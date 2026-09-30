import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RefreshTokenService } from '../../src/modules/auth/infrastructure/refresh-token.service';
import { TokenService } from '../../src/modules/auth/infrastructure/token.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import type { Env } from '../../src/shared/config/env.schema';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The session, over real HTTP, against a real database.
 *
 * WHY THIS FILE EXISTS: every other test here talks to a service or to
 * PostgreSQL directly. Nothing exercised the assembled application, and the
 * gap had a precise cost — `POST /auth/refresh` answered with a token and no
 * identity. Every unit test passed, because none of them ever asked what the
 * endpoint actually returns. The browser found it: reloading the page produced
 * a valid session the client could not describe, so the dashboard drew itself
 * empty and the router, seeing a truthy user, never sent anybody to sign in.
 *
 * The rule it locks in: SIGNING IN AND RESUMING RETURN THE SAME THING. A
 * reload has to rebuild the whole session, and the only way it can is if
 * refresh says who you are, not just that you may continue.
 */
const PASSWORD = 'el caballo come alfalfa';

/**
 * The shape both `login` and `refresh` must answer with.
 *
 * Declared here rather than imported from the controller ON PURPOSE: this is
 * the contract as the CLIENT sees it. Importing the server's own type would
 * make the test agree with any change to it, including the one that removed
 * the identity from the refresh response.
 */
interface SessionBody {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; firstName: string; lastName: string };
  /** AU-005, AU-037: si ESTA cuenta tiene segundo factor. Nada más de él. */
  mfaEnabled: boolean;
  grants: { roleCode: string; siteId: string | null; permissions: string[] }[];
}

/** `response.body` is `any`; every read below goes through this instead. */
function sessionBody(response: request.Response): SessionBody {
  return response.body as SessionBody;
}

describe('session over HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Prisma hands back BigInt for bigserial ids and JSON.stringify throws on
    // them. `main.ts` calls this before creating the app; so must we, or the
    // first endpoint touching such a row fails for an unrelated reason.
    enableBigIntSerialisation();

    prisma = db();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The application must speak to the SAME database the fixtures write to.
      // Its own PrismaService points at the URL in the environment; overriding
      // it here is what keeps the two from being different databases.
      .overrideProvider(PrismaService)
      .useValue(prisma)
      /**
       * SIN LÍMITE DE PETICIONES, como en el resto de suites de HTTP.
       *
       * El limitador real permite diez peticiones por segundo POR IP, y aquí
       * todas salen de la misma: las pruebas de rotación hacen varias seguidas
       * a `/auth/refresh` y empezaban a recibir 429 en vez de lo que
       * comprueban. Un 429 en mitad de una prueba de reúso no es una señal
       * útil, es ruido que depende de lo rápido que vaya la máquina.
       *
       * ⚠️ Nadie comprueba el limitador en ninguna suite: todas lo sustituyen.
       * Anotado como deuda, no se tapa aquí.
       */
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 1,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app);
    await listenForTests(app);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** A signed-in-capable account holding a real role. */
  async function createAccount(): Promise<void> {
    await syncAuthorisation(prisma);

    const user = await prisma.user.create({
      data: {
        email: 'ana.torres@clinica.ec',
        firstName: 'Ana',
        lastName: 'Torres',
        // A real check digit: the database validates it and a made-up number
        // would fail for the wrong reason.
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const medico = await prisma.role.findUniqueOrThrow({
      where: { code: 'MEDICO' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: medico.id, siteId: null },
    });
  }

  it('answers a sign-in with the identity and the permissions', async () => {
    await createAccount();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    const body = sessionBody(response);
    expect(body.user).toMatchObject({
      email: 'ana.torres@clinica.ec',
      firstName: 'Ana',
      lastName: 'Torres',
    });
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.grants.length).toBeGreaterThan(0);
    expect(body.grants[0]!.permissions.length).toBeGreaterThan(0);
  });

  it('answers a refresh with the identity too, not just a token', async () => {
    // THE REGRESSION. Refresh used to return `{ accessToken, expiresIn }`, and
    // a reload is the only path that depends on this response to learn who the
    // user is — the access token lives in memory and does not survive it.
    await createAccount();

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    const cookies = signedIn.get('Set-Cookie');
    expect(cookies, 'sign-in must set the refresh cookie').toBeDefined();

    const resumed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies!)
      .expect(200);

    const before = sessionBody(signedIn);
    const after = sessionBody(resumed);

    expect(after.user).toEqual(before.user);
    expect(after.grants).toEqual(before.grants);
    expect(after.expiresIn).toEqual(before.expiresIn);
    // A NEW token, because rotation is the point of the endpoint.
    expect(after.accessToken).not.toEqual(before.accessToken);
  });

  it('dice si la cuenta tiene segundo factor, al entrar y al reanudar', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SIN ESTE CAMPO, UNA PANTALLA TENÍA QUE ADIVINAR
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `/mi-cuenta` ofrecía «Matricular» y «Cambiar de dispositivo» a la vez
     * porque la sesión no decía en cuál de los dos estados está la cuenta, y
     * una de las dos acciones estaba garantizado que fallaba —
     * `MFA_NOT_ENROLLED` o `MFA_ALREADY_ENROLLED`. Saberlo de la PROPIA cuenta
     * no exige ningún permiso; el único sitio donde vivía era `GET
     * /auth/users`, que es administrar a toda la plantilla.
     *
     * La mitad que se comprueba aquí es «sin matricular», en las dos
     * respuestas que una cuenta sin segundo factor puede recibir. El otro
     * estado —y `mfa/verify`— están en `mfa-backup-codes.spec.ts`, que es
     * donde se matricula de verdad.
     */
    await createAccount();

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    expect(sessionBody(signedIn).mfaEnabled).toBe(false);

    const resumed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', signedIn.get('Set-Cookie')!)
      .expect(200);

    // Reanudar es la única vía tras recargar la página, así que si el campo
    // faltase justo aquí la pantalla volvería a no saber nada.
    expect(sessionBody(resumed).mfaEnabled).toBe(false);
  });

  it('la sesión no cuenta NADA MÁS del segundo factor que si lo hay', async () => {
    // El secreto, el paso consumido y cuántos códigos de respaldo quedan no
    // salen de aquí: lo último diría a cualquiera que mire la pantalla lo
    // cerca que está esa cuenta de quedarse fuera del expediente.
    await createAccount();

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    const raw = JSON.stringify(signedIn.body);
    for (const leak of [
      'mfaSecret',
      'mfaEnabledAt',
      'mfaLastStep',
      'backupCodes',
      'backupCodesRemaining',
    ]) {
      expect(raw).not.toContain(leak);
    }
  });

  it('refuses to resume without the cookie', async () => {
    await createAccount();

    await request(app.getHttpServer()).post('/api/v1/auth/refresh').expect(401);
  });

  it('never puts the refresh token in the response body', async () => {
    // It travels in an httpOnly cookie precisely so an injected script cannot
    // read it. Leaking it in the body would undo that in one line.
    await createAccount();

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    expect(Object.keys(sessionBody(signedIn))).not.toContain('refreshToken');

    const resumed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', signedIn.get('Set-Cookie')!)
      .expect(200);

    expect(Object.keys(sessionBody(resumed))).not.toContain('refreshToken');
  });

  /**
   * AU-004 — refrescos de un solo uso que rotan, y un refresco ya usado fuera
   * de la excepción de AU-039 revoca la familia entera.
   *
   * LA MITAD QUE IMPORTA NO ESTABA PROBADA. `RefreshTokenService` no tenía
   * NINGUNA prueba: ni la reclamación atómica, ni la detección de reúso, ni la
   * revocación de la familia. Es lo que convierte un token robado en una
   * alarma en vez de una brecha silenciosa, y podía romperse entero sin que
   * fallara nada — el comentario del servicio lo describía con detalle, que es
   * exactamente la clase de garantía que nadie vuelve a comprobar.
   *
   * CONTRA LA BASE Y NO CONTRA UN DOBLE: la garantía vive en sentencias
   * condicionales y bloqueos, y un doble que devuelve `count: 1` demuestra
   * únicamente que el doble devuelve 1.
   *
   * AU-039 — LA VENTANA DE GRACIA. Nada aquí escribe una hora: para salir de
   * la ventana se ENVEJECE el `used_at` de la propia fila en `W + 1` segundos,
   * con `W` leído de la misma configuración que usa el servicio. Cada caso
   * negativo cambia UNA condición respecto al positivo, que pasa con todo lo
   * demás igual: eso es el control.
   */
  describe('AU-004 y AU-039 rotación de refrescos, reúso y ventana de gracia', () => {
    /** The browser that signed in. AU-039 compares it; supertest sends none. */
    const BROWSER = 'Mozilla/5.0 (Macintosh) mostrador-recepcion';
    /** Somebody else holding a copy of the cookie. */
    const OTHER_CLIENT = 'curl/8.7.1';

    /** `W`: the grace window the running application was configured with. */
    function graceSeconds(): number {
      return app
        .get<ConfigService<Env, true>>(ConfigService)
        .get('JWT_REFRESH_REUSE_GRACE_SECONDS', { infer: true });
    }

    async function signIn(): Promise<{
      cookies: string[];
      accessToken: string;
    }> {
      await createAccount();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('User-Agent', BROWSER)
        .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
        .expect(200);
      return {
        cookies: response.get('Set-Cookie')!,
        accessToken: sessionBody(response).accessToken,
      };
    }

    const refresh = (cookies: string[], userAgent = BROWSER) =>
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('User-Agent', userAgent)
        .set('Cookie', cookies);

    /** Refreshes and returns the cookie that carries the successor. */
    async function rotate(cookies: string[]): Promise<string[]> {
      return (await refresh(cookies).expect(200)).get('Set-Cookie')!;
    }

    /** The stored row of the refresh token a cookie carries. */
    function rowOf(cookies: string[]) {
      const pair = cookies
        .map((cookie) => cookie.split(';')[0]!)
        .find((c) => /^(__Host-)?refresh=/.test(c));
      expect(pair, 'la respuesta lleva la cookie de refresco').toBeDefined();
      const token = decodeURIComponent(pair!.slice(pair!.indexOf('=') + 1));
      return prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: TokenService.hashRefreshToken(token) },
      });
    }

    /** Moves this token's use `W + 1` seconds into the past: out of the window. */
    async function leaveTheWindow(cookies: string[]): Promise<void> {
      const { id } = await rowOf(cookies);
      const aged = await prisma.$executeRaw`
        UPDATE refresh_token
           SET used_at = used_at - make_interval(secs => ${graceSeconds() + 1})
         WHERE id = ${id}::uuid AND used_at IS NOT NULL`;
      expect(aged, 'sólo se envejece un refresco ya usado').toBe(1);
    }

    /** Rows of the family that would still let somebody in. */
    async function liveRows(familyId: string): Promise<number> {
      return prisma.refreshToken.count({
        where: { familyId, revokedAt: null, usedAt: null },
      });
    }

    /**
     * Resolves once another session of this database is waiting on a row
     * lock. A condition, not a delay: it returns the moment the revocation is
     * provably queued behind the open transaction, and fails if it never is.
     */
    async function blockedOnALock(): Promise<void> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if ((row?.waiting ?? 0n) > 0n) return;
      }
      throw new Error('la revocación nunca quedó esperando el bloqueo');
    }

    it('AU-039 la configuración de la prueba tiene ventana: sin ella nada de esto prueba la gracia', () => {
      expect(graceSeconds()).toBeGreaterThan(0);
    });

    it('AU-039 respuesta perdida y el mismo refresco dentro de la ventana: la sesión sigue', async () => {
      /**
       * EL DEFECTO, tal cual lo vio el mostrador. El servidor rota `first`, la
       * respuesta con la cookie nueva no llega, y el navegador vuelve con
       * `first`. Antes esto revocaba la familia; ahora renueva.
       */
      const { cookies: first } = await signIn();
      await rotate(first); // la respuesta que «se perdió»: su cookie se tira

      const recovered = await refresh(first).expect(200);
      expect(sessionBody(recovered).user.email).toBe('ana.torres@clinica.ec');

      // Y la sesión recuperada es una sesión de verdad: su cookie renueva.
      await rotate(recovered.get('Set-Cookie')!);
    });

    it('AU-039 retira el sucesor huérfano: la familia vuelve a tener una sola cabeza', async () => {
      const { cookies: first } = await signIn();
      const lost = await rotate(first);
      const recovered = (await refresh(first).expect(200)).get('Set-Cookie')!;

      const lostRow = await rowOf(lost);
      expect(lostRow.revokedAt).not.toBeNull();
      expect(lostRow.revocationReason).toBe('SUPERSEDED');
      expect((await rowOf(recovered)).revokedAt).toBeNull();
      expect(await liveRows(lostRow.familyId)).toBe(1);
    });

    it('AU-039 repetirlo dentro de la ventana no la alarga: el instante de uso no se mueve', async () => {
      const { cookies: first } = await signIn();
      await rotate(first);
      const usedAt = (await rowOf(first)).usedAt;
      expect(usedAt).not.toBeNull();

      await refresh(first).expect(200);
      await refresh(first).expect(200);

      expect((await rowOf(first)).usedAt).toEqual(usedAt);
    });

    it('AU-004 fuera de la ventana el mismo refresco es un reúso: 401 y familia REUSE', async () => {
      // Control: el mismo recorrido que el positivo, con el uso envejecido.
      const { cookies: first } = await signIn();
      const successor = await rotate(first);
      await leaveTheWindow(first);

      const refused = await refresh(first).expect(401);
      expect(refused.body).toMatchObject({
        code: 'REFRESH_TOKEN_REUSE_DETECTED',
      });

      // La familia entera, con el motivo que lee el responsable de seguridad.
      const { familyId } = await rowOf(first);
      expect(await liveRows(familyId)).toBe(0);
      expect((await rowOf(successor)).revocationReason).toBe('REUSE');
      await refresh(successor).expect(401);
    });

    it('AU-004 dentro de la ventana pero desde otro cliente: familia revocada', async () => {
      const { cookies: first } = await signIn();
      const successor = await rotate(first);

      await refresh(first, OTHER_CLIENT).expect(401);

      await refresh(successor).expect(401);
      expect(await liveRows((await rowOf(first)).familyId)).toBe(0);
    });

    it('AU-004 dentro de la ventana pero su sucesor ya se usó: el penúltimo es un reúso', async () => {
      // Si el sucesor se usó, la respuesta SÍ llegó y la sesión siguió
      // adelante: volver con el anterior ya no es una respuesta perdida.
      const { cookies: first } = await signIn();
      const second = await rotate(first);
      const third = await rotate(second);

      await refresh(first).expect(401);

      await refresh(third).expect(401);
      expect(await liveRows((await rowOf(first)).familyId)).toBe(0);
    });

    it('AU-039 un robo dentro de la ventana no se esconde: el sucesor retirado, si aparece, tumba la familia', async () => {
      /**
       * EL ATAQUE QUE LA GRACIA PODRÍA TAPAR. El ladrón rota primero con la
       * copia robada; el dueño vuelve dentro de la ventana con la misma, desde
       * su navegador, y la gracia le deja seguir. Si la rama del ladrón quedase
       * viva, ninguno volvería a presentar nada gastado y la alarma no sonaría
       * nunca. Se le retiró: en cuanto la usa, AU-004.
       */
      const { cookies: stolen } = await signIn();
      const thiefBranch = (await refresh(stolen, OTHER_CLIENT).expect(200)).get(
        'Set-Cookie',
      )!;
      const ownerBranch = (await refresh(stolen).expect(200)).get(
        'Set-Cookie',
      )!;

      const refused = await refresh(thiefBranch, OTHER_CLIENT).expect(401);
      expect(refused.body).toMatchObject({
        code: 'REFRESH_TOKEN_REUSE_DETECTED',
      });

      await refresh(ownerBranch).expect(401);
      expect(await liveRows((await rowOf(stolen)).familyId)).toBe(0);
    });

    it('AU-039 una familia cerrada con el cierre de sesión no revive por la gracia', async () => {
      const { cookies: first } = await signIn();
      const successor = await rotate(first);
      const { accessToken } = sessionBody(await refresh(successor).expect(200));

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      // `successor` es ahora el último usado, dentro de la ventana, mismo
      // navegador: todo lo que el positivo pide salvo la familia abierta.
      await refresh(successor).expect(401);
      const { familyId } = await rowOf(successor);
      expect(await liveRows(familyId)).toBe(0);
      expect(await app.get(RefreshTokenService).isFamilyOpen(familyId)).toBe(
        false,
      );
    });

    it('AU-039 una familia cerrada por AU-036 o por un cambio de contraseña no revive por la gracia', async () => {
      // `revokeAllForUser` es el camino de AU-036, AU-023 y el cambio de
      // contraseña: se llama tal cual, con el motivo de AU-036.
      const { cookies: first } = await signIn();
      await rotate(first);
      const { userId, familyId } = await rowOf(first);

      await app.get(RefreshTokenService).revokeAllForUser(userId, 'MFA_RESET');

      await refresh(first).expect(401);
      expect(await liveRows(familyId)).toBe(0);
      expect(await app.get(RefreshTokenService).isFamilyOpen(familyId)).toBe(
        false,
      );
    });

    for (const revocation of ['revokeFamily', 'revokeAllForUser'] as const) {
      it(`AU-039 una revocación (${revocation}) que llega mientras se emite un sucesor no lo deja vivo`, async () => {
        /**
         * LA CARRERA, forzada en el orden malo en vez de esperada. Renovar
         * (normal o por gracia) bloquea el refresco presentado e inserta el
         * sucesor en una transacción. Aquí la prueba ES esa transacción: la
         * deja abierta con el sucesor insertado, lanza la revocación, espera a
         * VERLA bloqueada en `pg_stat_activity` y sólo entonces confirma.
         *
         * Un `UPDATE` único esperaba al refresco presentado y, al seguir, no
         * veía el sucesor —no estaba en su instantánea—: la familia quedaba
         * con una fila viva y el guardia de AU-036 la daba por abierta.
         */
        const { cookies } = await signIn();
        const presented = await rowOf(cookies);
        const sessions = app.get(RefreshTokenService);

        let revoking: Promise<void> | undefined;
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM refresh_token WHERE id = ${presented.id}::uuid FOR UPDATE`;
          await tx.refreshToken.create({
            data: {
              userId: presented.userId,
              familyId: presented.familyId,
              tokenHash: TokenService.hashRefreshToken(
                `sucesor-${presented.id}`,
              ),
              expiresAt: presented.expiresAt,
              userAgent: BROWSER,
            },
          });

          revoking =
            revocation === 'revokeFamily'
              ? sessions.revokeFamily(presented.familyId, 'SIGN_OUT')
              : sessions.revokeAllForUser(presented.userId, 'MFA_RESET');
          await blockedOnALock();
        });
        await revoking;

        expect(await liveRows(presented.familyId)).toBe(0);
        expect(await sessions.isFamilyOpen(presented.familyId)).toBe(false);
      });
    }

    it('AU-004 marca la familia como REUSE en la base, no solo la rechaza', async () => {
      // El motivo es lo que un responsable de seguridad lee después. Revocar
      // sin decir por qué deja el incidente indistinguible de un cierre de
      // sesión corriente.
      const { cookies } = await signIn();
      await rotate(cookies);
      await leaveTheWindow(cookies);
      await refresh(cookies).expect(401);

      const revoked = await prisma.refreshToken.findMany({
        where: { revocationReason: 'REUSE' },
      });
      expect(revoked.length).toBeGreaterThan(0);
    });

    it('AU-039 dos renovaciones simultáneas desde el mismo navegador: las dos siguen y queda una sola cabeza', async () => {
      // La reclamación sigue siendo atómica —gana exactamente una rotación— y
      // la otra entra por la gracia en vez de tumbar la sesión, que era lo que
      // pasaba con dos pestañas a la vez. Lo que NO puede pasar es que la
      // familia se parta en dos ramas vivas.
      const { cookies } = await signIn();

      const outcomes = await Promise.all([refresh(cookies), refresh(cookies)]);

      expect(outcomes.map((o) => o.status)).toEqual([200, 200]);
      expect(await liveRows((await rowOf(cookies)).familyId)).toBe(1);
    });

    it('AU-004 en dos refrescos simultáneos desde clientes distintos gana exactamente uno', async () => {
      // La reclamación es condicional justamente por esto: un «leer,
      // comprobar, escribir» dejaría pasar los dos y partiría la familia en
      // dos ramas vivas. Se afirma CUÁNTOS ganan, no que «alguno falle».
      const { cookies } = await signIn();

      // Ninguno de los dos es el navegador que lo recibió, así que el
      // perdedor no puede entrar por la gracia: sólo cuenta la reclamación.
      const outcomes = await Promise.all([
        refresh(cookies, OTHER_CLIENT),
        refresh(cookies, `${OTHER_CLIENT} (otra copia)`),
      ]);

      const statuses = outcomes.map((o) => o.status).sort();
      expect(statuses).toEqual([200, 401]);
    });

    it('AU-004 el token de acceso es de vida corta y la respuesta dice cuánto', async () => {
      // «Vida corta» sin número no es comprobable. Una hora es el techo que
      // hace que revocar un rol surta efecto en minutos y no en días.
      const { cookies } = await signIn();
      const resumed = await refresh(cookies).expect(200);

      const { expiresIn } = sessionBody(resumed);
      expect(expiresIn).toBeGreaterThan(0);
      expect(expiresIn).toBeLessThanOrEqual(3600);
    });
  });
});
