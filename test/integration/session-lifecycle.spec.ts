import { randomUUID } from 'node:crypto';

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
import { RefreshTokenReuseError } from '../../src/modules/auth/domain/auth.errors';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { PrismaAccountAdminRepository } from '../../src/modules/auth/infrastructure/prisma-account-admin.repository';
import { PrismaAuthUserRepository } from '../../src/modules/auth/infrastructure/prisma-auth-user.repository';
import { PrismaCredentialInvitationRepository } from '../../src/modules/auth/infrastructure/prisma-credential-invitation.repository';
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

    async function signIn(userAgent = BROWSER): Promise<{
      cookies: string[];
      accessToken: string;
    }> {
      await createAccount();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('User-Agent', userAgent)
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
    async function blockedOnALock(
      waiters = 1,
      table = 'refresh_token',
    ): Promise<void> {
      // Only OTHER sessions, only statements on `table`: the waiters this
      // test provoked, not whatever else the database is doing.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query ILIKE ${`%${table}%`}`;
        if ((row?.waiting ?? 0n) >= BigInt(waiters)) return;
      }
      throw new Error(
        `nunca hubo ${waiters} sentencia(s) esperando un bloqueo`,
      );
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

    /**
     * EVERY path that closes sessions, called through the code that really
     * runs — not a stand-in. The first version of these tests only exercised
     * `RefreshTokenService`, and three of these five paths revoked on their
     * own and stayed exposed (clean-context review, 30-09-2026).
     */
    const revocations: {
      name: string;
      revoke: (row: { userId: string; familyId: string }) => Promise<unknown>;
    }[] = [
      {
        name: 'el cierre de sesión',
        revoke: (row) =>
          app.get(RefreshTokenService).revokeFamily(row.familyId, 'SIGN_OUT'),
      },
      {
        name: 'la desactivación de la cuenta (AU-023)',
        revoke: (row) =>
          app
            .get(RefreshTokenService)
            .revokeAllForUser(row.userId, 'ACCOUNT_DEACTIVATED'),
      },
      {
        name: 'el cambio de contraseña',
        revoke: async (row) => {
          const { passwordHash } = await prisma.user.findUniqueOrThrow({
            where: { id: row.userId },
          });
          return app
            .get(PrismaAuthUserRepository)
            .rotateCredentials(row.userId, passwordHash, 'PASSWORD_CHANGE');
        },
      },
      {
        name: 'el reinicio del segundo factor (AU-036)',
        revoke: (row) =>
          app
            .get(PrismaAccountAdminRepository)
            .resetMfa(row.userId, 'MFA_RESET', { userId: row.userId }),
      },
      {
        name: 'el canje de una invitación de credencial',
        revoke: async (row) => {
          const { passwordHash } = await prisma.user.findUniqueOrThrow({
            where: { id: row.userId },
          });
          const invitation = await prisma.credentialInvitation.create({
            data: {
              userId: row.userId,
              tokenHash: TokenService.hashRefreshToken(
                `invitacion-${row.familyId}`,
              ),
              expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            },
          });
          return app.get(PrismaCredentialInvitationRepository).redeem({
            invitationId: invitation.id,
            userId: row.userId,
            passwordHash: passwordHash,
            now: new Date(),
          });
        },
      },
    ];

    for (const { name, revoke } of revocations) {
      it(`AU-039 ${name} que llega mientras se emite un sucesor no lo deja vivo`, async () => {
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

        let revoking: Promise<unknown> | undefined;
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

          revoking = revoke(presented);
          await blockedOnALock();
        });
        await revoking;

        expect(await liveRows(presented.familyId)).toBe(0);
        expect(
          await app.get(RefreshTokenService).isFamilyOpen(presented.familyId),
        ).toBe(false);
      });
    }

    for (const { name, revoke } of revocations) {
      it(`AU-039 una familia cerrada por ${name} no revive por la gracia`, async () => {
        // Todo lo que el positivo pide —el último usado, dentro de la ventana,
        // el mismo navegador— salvo la familia abierta.
        const { cookies: first } = await signIn();
        await rotate(first);
        const presented = await rowOf(first);

        await revoke(presented);

        await refresh(first).expect(401);
        expect(await liveRows(presented.familyId)).toBe(0);
        expect(
          await app.get(RefreshTokenService).isFamilyOpen(presented.familyId),
        ).toBe(false);
      });
    }

    it('AU-039 reclamar y emitir van juntos: una revocación durante una rotación normal no deja el sucesor vivo', async () => {
      /**
       * La otra mitad de la carrera: que la ROTACIÓN reclame y emita en una
       * sola transacción. Se sostiene la fila de la cuenta, así que el INSERT
       * del sucesor —su clave foránea— espera con el refresco ya reclamado y
       * bloqueado. Entonces llega la revocación, y tiene que esperar a ese
       * refresco. Con reclamar y emitir en dos sentencias sueltas no esperaría:
       * revocaría y el sucesor nacería vivo después.
       */
      const { cookies } = await signIn();
      const presented = await rowOf(cookies);

      let rotating: Promise<request.Response> | undefined;
      let revoking: Promise<void> | undefined;
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM app_user WHERE id = ${presented.userId}::uuid FOR UPDATE`;
        rotating = refresh(cookies).then((response) => response);
        await blockedOnALock(1);

        revoking = app
          .get(RefreshTokenService)
          .revokeFamily(presented.familyId, 'SIGN_OUT');
        await blockedOnALock(2);
      });
      await Promise.all([rotating, revoking]);

      expect(await liveRows(presented.familyId)).toBe(0);
    });

    it('AU-039 dos gracias seguidas: la segunda retira el sucesor de la primera', async () => {
      const { cookies: first } = await signIn();
      await rotate(first);
      const firstRegrant = (await refresh(first).expect(200)).get(
        'Set-Cookie',
      )!;
      const secondRegrant = (await refresh(first).expect(200)).get(
        'Set-Cookie',
      )!;

      expect((await rowOf(firstRegrant)).revocationReason).toBe('SUPERSEDED');
      expect((await rowOf(secondRegrant)).revokedAt).toBeNull();
      expect(await liveRows((await rowOf(first)).familyId)).toBe(1);
    });

    it('AU-039 sin agente de usuario no hay gracia, aunque el que lo recibió tampoco lo enviara', async () => {
      // Sin la comprobación explícita, '' = '' cumpliría «el mismo agente».
      const { cookies: first } = await signIn('');
      await rotate(first);

      await refresh(first, '').expect(401);
      const { familyId } = await rowOf(first);
      expect(await liveRows(familyId)).toBe(0);
      expect(await app.get(RefreshTokenService).isFamilyOpen(familyId)).toBe(
        false,
      );
    });

    it('AU-039 con la ventana a 0 rige AU-004 estricto: el mismo refresco no vale dos veces', async () => {
      // El mismo servicio, construido con la gracia apagada; lo demás es el de
      // la aplicación y la misma base.
      await createAccount();
      const { id: userId, sessionEpoch } = await prisma.user.findUniqueOrThrow({
        where: { email: 'ana.torres@clinica.ec' },
      });
      const config = app.get<ConfigService<Env, true>>(ConfigService);
      const strict = new RefreshTokenService(
        prisma as unknown as PrismaService,
        app.get(TokenService),
        app.get(RefreshTokenService)['logger'],
        {
          get: (key: keyof Env) =>
            key === 'JWT_REFRESH_REUSE_GRACE_SECONDS'
              ? 0
              : config.get(key, { infer: true }),
        } as unknown as ConfigService<Env, true>,
      );

      const issued = (await strict.issueForNewSession(userId, sessionEpoch, {
        userAgent: BROWSER,
      }))!;
      await strict.rotate(issued.token, { userAgent: BROWSER });

      await expect(
        strict.rotate(issued.token, { userAgent: BROWSER }),
      ).rejects.toBeInstanceOf(RefreshTokenReuseError);
      expect(await liveRows(issued.familyId)).toBe(0);
    });

    it('AU-039 la gracia sobre un refresco cuyo sucesor se está usando no deja dos cabezas', async () => {
      /**
       * El dueño rota `second` → `third` y, en ese instante, alguien con copia
       * de `first` y el mismo agente de usuario lo presenta dentro de la
       * ventana. Si la gracia sólo bloquease `first`, vería `second` aún sin
       * usar, lo daría por huérfano y la familia acabaría con DOS ramas vivas
       * que no vuelven a presentar nada gastado. La prueba sostiene abierta la
       * rotación del dueño, lanza la gracia, la ve esperar y confirma: al
       * seguir, `first` ya no es el último usado y rige AU-004.
       */
      const { cookies: first } = await signIn();
      const second = await rotate(first);
      const secondRow = await rowOf(second);

      let presenting: Promise<request.Response> | undefined;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE refresh_token
             SET used_at = now(), revocation_reason = 'ROTATION'
           WHERE id = ${secondRow.id}::uuid`;
        await tx.refreshToken.create({
          data: {
            userId: secondRow.userId,
            familyId: secondRow.familyId,
            tokenHash: TokenService.hashRefreshToken(`tercero-${secondRow.id}`),
            expiresAt: secondRow.expiresAt,
            userAgent: BROWSER,
          },
        });

        presenting = refresh(first).then((response) => response);
        await blockedOnALock();
      });

      expect((await presenting!).status).toBe(401);
      expect(await liveRows(secondRow.familyId)).toBe(0);
      expect(
        await app.get(RefreshTokenService).isFamilyOpen(secondRow.familyId),
      ).toBe(false);
    });

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

    /**
     * AU-040 — UN TOPE DE VIDA POR FAMILIA, CONTADO DESDE EL INICIO DE SESIÓN.
     *
     * Nada aquí escribe una fecha: la familia se ENVEJECE desplazando hacia
     * atrás todas sus marcas —`created_at`, `used_at`, `expires_at`— los días
     * de `JWT_REFRESH_TTL_DAYS` que lee la aplicación, más o menos unos
     * segundos. Cada caso negativo tiene su control, a un lado u otro del tope.
     */
    describe('AU-040 tope de vida de la sesión', () => {
      /** The session lifetime, in seconds, the running app was configured with. */
      function lifetimeSeconds(): number {
        return (
          app
            .get<ConfigService<Env, true>>(ConfigService)
            .get('JWT_REFRESH_TTL_DAYS', { infer: true }) * 86_400
        );
      }

      /**
       * Moves every mark of the family `seconds` into the past, as if it had
       * been signed into that much earlier. `used_at` stays put when
       * `keepUse`: the last rotation happened just now, near the ceiling.
       */
      async function ageFamily(
        familyId: string,
        seconds: number,
        { keepUse = false } = {},
      ): Promise<void> {
        const aged = await prisma.$executeRaw`
          UPDATE refresh_token
             SET created_at = created_at - make_interval(secs => ${seconds}),
                 expires_at = expires_at - make_interval(secs => ${seconds}),
                 used_at = CASE WHEN ${keepUse} THEN used_at
                                ELSE used_at - make_interval(secs => ${seconds}) END
           WHERE family_id = ${familyId}::uuid`;
        expect(aged, 'la familia tiene filas que envejecer').toBeGreaterThan(0);
      }

      async function familyRows(familyId: string) {
        return prisma.refreshToken.findMany({
          where: { familyId },
          orderBy: { createdAt: 'asc' },
        });
      }

      /** `Expires` of the refresh cookie, as the browser will read it. */
      function cookieExpiry(cookies: string[]): string | undefined {
        const cookie = cookies.find((c) => /^(__Host-)?refresh=/.test(c));
        return /;\s*Expires=([^;]+)/i.exec(cookie ?? '')?.[1];
      }

      it('AU-040 la caducidad se fija al iniciar sesión: la vida configurada desde ese instante', async () => {
        const { cookies } = await signIn();
        const row = await rowOf(cookies);

        const lifetimeMs = row.expiresAt.getTime() - row.createdAt.getTime();
        // `created_at` is the database clock at the INSERT; `expires_at` the
        // application clock just before it. Same machine: seconds apart at most.
        expect(Math.abs(lifetimeMs - lifetimeSeconds() * 1000)).toBeLessThan(
          5_000,
        );
      });

      it('AU-040 la cookie dura un día más que la sesión, para que el navegador pueda oír que caducó', async () => {
        // Con la cookie muriendo a la vez que la familia, el navegador ya no
        // la envía al pasar el tope: la API responde «no hay cookie» y nadie
        // sabe que la sesión caducó (revisión en contexto limpio, 30-09-2026).
        const { cookies } = await signIn();
        const row = await rowOf(cookies);

        const cookieMs = Date.parse(cookieExpiry(cookies)!);
        const marginMs = cookieMs - row.expiresAt.getTime();
        // `Expires` has second resolution.
        expect(Math.abs(marginMs - 86_400_000)).toBeLessThan(1_000);
      });

      it('AU-040 rotar no alarga la sesión: el sucesor y el de la gracia heredan la caducidad del inicio de sesión', async () => {
        const { cookies: first } = await signIn();
        const started = await rowOf(first);

        const second = await rotate(first);
        const third = await rotate(second);
        await rotate(third); // la respuesta que «se perdió»
        const regranted = (await refresh(third).expect(200)).get('Set-Cookie')!;

        for (const cookies of [second, third, regranted]) {
          expect((await rowOf(cookies)).expiresAt).toEqual(started.expiresAt);
          // Y el navegador lo oye igual: la cookie no se alarga tampoco.
          expect(cookieExpiry(cookies)).toBe(cookieExpiry(first));
        }
      });

      it('AU-040 una sesión que se renueva hasta el último minuto caduca en el tope contado desde el inicio de sesión', async () => {
        const { cookies: first } = await signIn();
        const { familyId } = await rowOf(first);

        // Control: a un minuto del tope, renueva. Con la caducidad renovada
        // en cada rotación, esa renovación la habría alargado otra semana.
        await ageFamily(familyId, lifetimeSeconds() - 60);
        const lastMinute = await rotate(first);

        // Dos minutos después: el tope pasó hace uno.
        await ageFamily(familyId, 120);
        const refused = await refresh(lastMinute).expect(401);
        expect(refused.body).toMatchObject({ code: 'SESSION_EXPIRED' });
      });

      it('AU-040 una familia más allá del tope no emite nada, no se revoca y no da la alarma', async () => {
        const { cookies: first } = await signIn();
        const current = await rotate(first);
        const { familyId } = await rowOf(first);
        await ageFamily(familyId, lifetimeSeconds() + 1);
        const before = await familyRows(familyId);

        const refused = await refresh(current).expect(401);
        expect(refused.body).toMatchObject({ code: 'SESSION_EXPIRED' });

        // Ni fila nueva ni revocación: no quedaba nada abierto que cerrar.
        const after = await familyRows(familyId);
        expect(after).toEqual(before);
        expect(after.every((row) => row.revokedAt === null)).toBe(true);
      });

      it('AU-040 un refresco ya usado de una familia caducada tampoco da la alarma de reúso', async () => {
        const { cookies: first } = await signIn();
        await rotate(first);
        const { familyId } = await rowOf(first);
        await ageFamily(familyId, lifetimeSeconds() + 1);

        const refused = await refresh(first).expect(401);
        expect(refused.body).toMatchObject({ code: 'SESSION_EXPIRED' });
        expect(
          (await familyRows(familyId)).some(
            (row) => row.revocationReason === 'REUSE',
          ),
        ).toBe(false);
      });

      it('AU-004 una familia anterior al tope, con caducidades distintas por fila, sigue dando la alarma de reúso', async () => {
        /**
         * Antes de AU-040 cada rotación daba a su fila `ahora + 7 días`. En
         * una familia así, el refresco ya usado puede haber caducado mientras
         * su sucesor sigue vivo: presentarlo es un reúso, no una sesión
         * caducada, y tiene que revocar la familia como siempre.
         */
        const { cookies: first } = await signIn();
        const successor = await rotate(first);
        const used = await rowOf(first);
        // Sólo la fila usada caduca: la de su sucesor sigue en el futuro.
        await prisma.$executeRaw`
          UPDATE refresh_token
             SET expires_at = now() - make_interval(secs => 1)
           WHERE id = ${used.id}::uuid`;

        const refused = await refresh(first).expect(401);
        expect(refused.body).toMatchObject({
          code: 'REFRESH_TOKEN_REUSE_DETECTED',
        });
        expect(await liveRows(used.familyId)).toBe(0);
        await refresh(successor).expect(401);
      });

      it('AU-040 una familia REVOCADA cuyo refresco además pasó su caducidad no se hace pasar por caducada', async () => {
        // Cerrada por el cierre de sesión: lo que responde es lo de una
        // familia cerrada, no «caducó» — que abriría el diálogo de volver a
        // entrar en vez de terminar la sesión.
        const { cookies } = await signIn();
        const { familyId } = await rowOf(cookies);
        await app.get(RefreshTokenService).revokeFamily(familyId, 'SIGN_OUT');
        await ageFamily(familyId, lifetimeSeconds() + 1);

        const refused = await refresh(cookies).expect(401);
        expect(refused.body).not.toMatchObject({ code: 'SESSION_EXPIRED' });
      });

      it('AU-040 la gracia de AU-039 no rescata una familia que pasó el tope', async () => {
        // Todo lo que la gracia pide —el último usado, recién usado, el mismo
        // navegador, la familia sin revocar— salvo la familia viva: empezó
        // hace más que el tope, y la última renovación fue justo ahora.
        const { cookies: first } = await signIn();
        await rotate(first); // la respuesta que «se perdió»
        const { familyId } = await rowOf(first);
        await ageFamily(familyId, lifetimeSeconds() + 1, { keepUse: true });
        const before = await familyRows(familyId);

        const refused = await refresh(first).expect(401);
        expect(refused.body).toMatchObject({ code: 'SESSION_EXPIRED' });
        expect(await familyRows(familyId)).toEqual(before);
      });

      it('AU-040 control de la gracia: la misma respuesta perdida en una familia por debajo del tope sigue', async () => {
        const { cookies: first } = await signIn();
        await rotate(first);
        const { familyId } = await rowOf(first);
        await ageFamily(familyId, lifetimeSeconds() - 60, { keepUse: true });

        await refresh(first).expect(200);
      });

      it('AU-040 el token de acceso de una familia caducada responde SESSION_EXPIRED antes de caducar él', async () => {
        const { cookies, accessToken } = await signIn();
        const { familyId } = await rowOf(cookies);
        await ageFamily(familyId, lifetimeSeconds() + 1);

        const refused = await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(401);
        expect(refused.body).toMatchObject({ code: 'SESSION_EXPIRED' });
      });

      it('AU-040 control del guardia: el token de acceso de una familia por debajo del tope sigue valiendo', async () => {
        const { cookies, accessToken } = await signIn();
        const { familyId } = await rowOf(cookies);
        await ageFamily(familyId, lifetimeSeconds() - 60);

        await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(204);
      });
    });

    /**
     * AU-041 — LA CARRERA ENTRE INICIAR SESIÓN Y CERRAR TODAS LAS SESIONES.
     *
     * Forzada en el orden malo, no esperada, como las de AU-039. La prueba
     * sostiene una transacción que bloquea la sesión que ya existe: el cierre
     * incrementa la época de la cuenta y se queda esperando a esa fila, con la
     * cuenta bloqueada. Entonces entra el inicio de sesión: lee las
     * credenciales —y la época vieja— y espera a su vez sobre la cuenta (en
     * `clearFailedAttempts`, antes de llegar al `FOR SHARE` de la emisión: lo
     * que la prueba fija es que la época que compara se leyó antes del cierre).
     * Cuando la prueba confirma, el cierre termina primero.
     */
    describe('AU-041 iniciar sesión mientras se cierran todas las sesiones', () => {
      const accountWide = revocations.filter(
        ({ name }) => name !== 'el cierre de sesión',
      );

      async function liveRowsOfUser(userId: string): Promise<number> {
        return prisma.refreshToken.count({
          where: { userId, revokedAt: null, usedAt: null },
        });
      }

      const signInAgain = () =>
        request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('User-Agent', BROWSER)
          .send({ email: 'ana.torres@clinica.ec', password: PASSWORD });

      for (const { name, revoke } of accountWide) {
        it(`AU-041 ${name} confirmado entre leer las credenciales y emitir la sesión: no queda ninguna abierta`, async () => {
          const { cookies } = await signIn();
          const existing = await rowOf(cookies);

          let revoking: Promise<unknown> | undefined;
          let signingIn: Promise<request.Response> | undefined;
          await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`
              SELECT id FROM refresh_token WHERE id = ${existing.id}::uuid FOR UPDATE`;

            revoking = revoke(existing);
            await blockedOnALock(1, 'refresh_token');

            signingIn = signInAgain().then((response) => response);
            await blockedOnALock(1, 'app_user');
          });
          await revoking;
          const response = await signingIn!;

          expect(response.status).toBe(401);
          expect(await liveRowsOfUser(existing.userId)).toBe(0);
        });
      }

      it('AU-041 un cierre que llega mientras se emite la sesión la alcanza', async () => {
        /**
         * El otro orden. La prueba ES la emisión: bloquea la cuenta FOR SHARE,
         * como la de verdad, e inserta la familia. El cierre tiene que esperar
         * a que se confirme y verla al revocar. **Control:** incrementando la
         * época después del `UPDATE` que revoca, queda 1 fila viva.
         */
        const { cookies } = await signIn();
        const existing = await rowOf(cookies);

        let revoking: Promise<unknown> | undefined;
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM app_user WHERE id = ${existing.userId}::uuid FOR SHARE`;
          await tx.refreshToken.create({
            data: {
              userId: existing.userId,
              familyId: randomUUID(),
              tokenHash: TokenService.hashRefreshToken(`nueva-${existing.id}`),
              expiresAt: existing.expiresAt,
              userAgent: BROWSER,
            },
          });

          revoking = app
            .get(RefreshTokenService)
            .revokeAllForUser(existing.userId, 'ACCOUNT_DEACTIVATED');
          await blockedOnALock(1, 'app_user');
        });
        await revoking;

        expect(await liveRowsOfUser(existing.userId)).toBe(0);
      });

      it('AU-041 el rehash de un inicio de sesión no pisa una contraseña cambiada mientras tanto', async () => {
        /**
         * El inicio de sesión que rehace el hash (parámetros de Argon2 más
         * fuertes) escribía el de la contraseña que acababa de comprobar, sin
         * condición. Si en medio se confirmaba un cambio de contraseña, la
         * VIEJA volvía a valer. Ahora sólo escribe si el hash sigue siendo el
         * que leyó.
         */
        const { cookies } = await signIn();
        const { userId } = await rowOf(cookies);
        const repository = app.get(PrismaAuthUserRepository);
        const { passwordHash: read } = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
        });

        await repository.rotateCredentials(
          userId,
          'hash-nuevo',
          'PASSWORD_CHANGE',
        );
        await repository.updatePasswordHash(userId, 'rehash-de-la-vieja', read);

        const { passwordHash } = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
        });
        expect(passwordHash).toBe('hash-nuevo');

        // Control: con el hash que sigue ahí, el rehash sí se escribe.
        await repository.updatePasswordHash(userId, 'rehash', 'hash-nuevo');
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
            .passwordHash,
        ).toBe('rehash');
      });

      it('AU-041 control: sin un cierre de por medio, iniciar sesión otra vez funciona y deja dos sesiones', async () => {
        const { cookies } = await signIn();
        const { userId } = await rowOf(cookies);

        await signInAgain().expect(200);

        expect(await liveRowsOfUser(userId)).toBe(2);
      });

      it('AU-041 cerrar todas las sesiones avanza la época de la cuenta; cerrar una sola no', async () => {
        const { cookies } = await signIn();
        const existing = await rowOf(cookies);
        const epochOf = async () =>
          (
            await prisma.user.findUniqueOrThrow({
              where: { id: existing.userId },
              select: { sessionEpoch: true },
            })
          ).sessionEpoch;

        const start = await epochOf();
        await app
          .get(RefreshTokenService)
          .revokeFamily(existing.familyId, 'SIGN_OUT');
        expect(await epochOf()).toBe(start);

        let expected = start;
        for (const { name, revoke } of accountWide) {
          await revoke(existing);
          expected += 1;
          expect(await epochOf(), name).toBe(expected);
        }
      });
    });
  });
});
