import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { MailDeliveryFailedError } from '../../src/shared/mail/mail.errors';
import { MAILER } from '../../src/shared/mail/mail.port';

import { useDatabase } from './setup/database';
import { FakeMailer } from './setup/fake-mailer';

/**
 * The first credential of an account, end to end, against a real PostgreSQL 18
 * (AU-021, AU-026..AU-029 · D-013).
 *
 * WHAT THESE PROVE THAT THE UNIT SUITES CANNOT:
 *
 *   - the token is NOT IN THE TABLE. Only its hash is, and that is a property
 *     of what PostgreSQL ended up holding — a repository double would return
 *     whatever it was told and demonstrate nothing.
 *   - AU-027, with `credential_invitation_one_live_per_user` underneath. The
 *     partial unique index is the actual guarantee that a re-send leaves ONE
 *     live link; an `if` in TypeScript is not.
 *   - the whole loop closes: an account that answered 401 a moment ago signs
 *     in with the password its owner just chose. That is the thing D-013 was
 *     blocking, and it is only observable from outside.
 *   - AU-029: the account survives an e-mail failure. A real relay cannot be
 *     asked to fail on command, which is why the mailer is a fake here —
 *     never a real SMTP connection in a test.
 */
const PASSWORD = 'el caballo come alfalfa';
const NEW_PASSWORD = 'la ventana mira al patio';
const ADMIN_EMAIL = 'gerencia@clinica.ec';

/** Synthetic cedula with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface CreatedAccountBody {
  id: string;
  email: string;
  credentialPending: boolean;
  invitationSent: boolean;
  invitationExpiresAt: string;
}

interface TokenStatusBody {
  valid: boolean;
  expiresAt: string | null;
}

describe('la primera credencial por correo', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  const mailer = new FakeMailer();

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    mailer.reset();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        /**
         * ⚠️ NEVER A REAL SMTP CONNECTION IN A TEST. `test-env.ts` points
         * `SMTP_HOST` at `not-a-real-host`, but a machine with a real `.env`
         * and Mailpit running would otherwise send actual messages from the
         * suite — and the failure path of AU-029 cannot be produced at all
         * without a mailer that can be told to fail.
         */
        .overrideProvider(MAILER)
        .useValue(mailer)
        // The storage is replaced, not the guard: the public credential routes
        // are throttled, and 10 requests a minute would break the suite while
        // proving nothing about the routes themselves.
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
      await app.init();
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signInAsAdmin();
  });

  afterAll(async () => {
    await app?.close();
  });

  const base = '/api/v1/auth';
  const server = () => app.getHttpServer();

  async function signInAsAdmin(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        firstName: 'Gabriela',
        lastName: 'Mera',
        cedula: ADMIN_CEDULA,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
    });

    const response = await request(server())
      .post(`${base}/login`)
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  let sequence = 0;
  async function createAccount(): Promise<CreatedAccountBody> {
    sequence += 1;
    const response = await request(server())
      .post(`${base}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `nueva${sequence}@clinica.ec`,
        firstName: 'Ana',
        lastName: 'Villacís',
      })
      .expect(201);

    return response.body as CreatedAccountBody;
  }

  /**
   * Ages an invitation past its expiry, the way three days of calendar would.
   *
   * BOTH COLUMNS MOVE, and that is not a workaround: the CHECK
   * `credential_invitation_expires_after_creation` refuses a row whose expiry
   * precedes its creation, and an invitation that expired is one that was
   * ISSUED long ago — pulling only `expires_at` back would be simulating a
   * state the system cannot reach.
   */
  async function expireInvitationOf(userId: string): Promise<void> {
    const issuedAt = new Date(Date.now() - 96 * 3_600_000);
    await prisma.credentialInvitation.updateMany({
      where: { userId, usedAt: null },
      data: {
        createdAt: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 72 * 3_600_000),
      },
    });
  }

  /** The two public routes, called exactly as an anonymous browser would. */
  const checkToken = (value: string) =>
    request(server()).get(`${base}/credential/${encodeURIComponent(value)}`);

  const setCredential = (body: Record<string, unknown>) =>
    request(server()).post(`${base}/credential`).send(body);

  describe('emisión de la invitación', () => {
    it('AU-021 envía un enlace al correo institucional al crear la cuenta', async () => {
      const created = await createAccount();

      expect(created.invitationSent).toBe(true);
      expect(created.credentialPending).toBe(true);
      expect(mailer.last()?.to).toBe(created.email);
      expect(mailer.tokenFromLast()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    });

    it('AU-021 guarda SÓLO el hash: el token en claro no está en la tabla', async () => {
      // La garantía que sólo la base puede demostrar. Si esta fila llevara el
      // token, una copia robada de la base sería una copia de las credenciales
      // de todo el personal recién contratado.
      await createAccount();
      const plain = mailer.tokenFromLast();

      const rows = await prisma.credentialInvitation.findMany();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(plain);

      // Y lo que sí hay es su SHA-256, que es lo que se busca al presentarlo.
      const { createHash } = await import('node:crypto');
      expect(rows[0]?.tokenHash).toBe(
        createHash('sha256').update(plain).digest('hex'),
      );
    });

    it('AU-026 caduca a las 72 horas de emitirse', async () => {
      const created = await createAccount();

      const row = await prisma.credentialInvitation.findFirstOrThrow({
        where: { userId: created.id },
      });
      const hours =
        (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;

      // Redondeado al minuto: `created_at` lo pone la base y `expires_at` el
      // proceso, así que difieren en milisegundos por definición.
      expect(Math.round(hours * 60) / 60).toBeCloseTo(72, 1);
      expect(new Date(created.invitationExpiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('AU-021 el enlace apunta a la interfaz y no a esta API', async () => {
      await createAccount();

      // Quien lo abre necesita un formulario; esta API responde JSON.
      expect(mailer.last()?.text).toContain('/acceso/credencial?token=');
    });
  });

  describe('canje del enlace', () => {
    it('AU-021 fija la contraseña y la cuenta entra con ella', async () => {
      // El bucle completo, que es lo que D-013 estaba bloqueando: la cuenta
      // respondía 401 hace un momento y ahora inicia sesión con la contraseña
      // que su dueña acaba de elegir.
      const created = await createAccount();
      const plain = mailer.tokenFromLast();

      await request(server())
        .post(`${base}/login`)
        .send({ email: created.email, password: NEW_PASSWORD })
        .expect(401);

      await setCredential({ token: plain, password: NEW_PASSWORD }).expect(204);

      const session = await request(server())
        .post(`${base}/login`)
        .send({ email: created.email, password: NEW_PASSWORD })
        .expect(200);

      expect((session.body as { accessToken?: string }).accessToken).toEqual(
        expect.any(String),
      );

      // Y la cuenta deja de estar pendiente de credencial.
      const account = await request(server())
        .get(`${base}/users/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((account.body as { credentialPending: boolean }).credentialPending).toBe(false); // prettier-ignore
    });

    it('AU-021 aplica la misma política de contraseñas que el cambio de contraseña', async () => {
      await createAccount();
      const plain = mailer.tokenFromLast();

      const response = await setCredential({
        token: plain,
        password: 'corta',
      }).expect(422);

      expect((response.body as Problem).code).toBe('WEAK_PASSWORD');

      // El enlace NO se gastó: es lo único que la persona tiene, y gastarlo al
      // rechazar la contraseña la dejaría fuera por escribir once caracteres.
      const status = await checkToken(plain).expect(200);
      expect((status.body as TokenStatusBody).valid).toBe(true);
    });

    it('AU-021 deja en la bitácora que la credencial la fijó la propia cuenta', async () => {
      const created = await createAccount();
      const plain = mailer.tokenFromLast();

      await setCredential({ token: plain, password: NEW_PASSWORD }).expect(204);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'auth', resourceId: created.id },
        select: { action: true, userId: true },
        orderBy: { occurredAt: 'asc' },
      });

      // El alta y la invitación las firma el administrador; el canje lo firma
      // la persona, porque nadie más pudo hacerlo: nadie más conoció nunca la
      // contraseña. Eso es el no repudio que D-013 compra.
      expect(trail.at(-1)).toEqual({ action: 'UPDATE', userId: created.id });
      expect(JSON.stringify(trail)).not.toContain(NEW_PASSWORD);
    });

    it('AU-028 responde INVALID_CREDENTIAL_TOKEN igual para un enlace desconocido, uno usado y uno caducado', async () => {
      // Los tres, contra la base de verdad, y comparados entre sí. Que sean
      // idénticos es el requisito: distinguirlos convierte una ruta pública en
      // un oráculo sobre el propio secreto.
      const desconocido = await setCredential({
        token: 'no-existe-este-token',
        password: NEW_PASSWORD,
      }).expect(422);

      await createAccount();
      const usado = mailer.tokenFromLast();
      await setCredential({ token: usado, password: NEW_PASSWORD }).expect(204);
      const yaUsado = await setCredential({
        token: usado,
        password: NEW_PASSWORD,
      }).expect(422);

      const created = await createAccount();
      const caducado = mailer.tokenFromLast();
      await expireInvitationOf(created.id);
      const yaCaducado = await setCredential({
        token: caducado,
        password: NEW_PASSWORD,
      }).expect(422);

      const shapeOf = (body: unknown) => {
        const problem = body as Problem;
        return { status: problem.status, code: problem.code, title: problem.title }; // prettier-ignore
      };

      expect(shapeOf(desconocido.body).code).toBe('INVALID_CREDENTIAL_TOKEN');
      expect(shapeOf(yaUsado.body)).toEqual(shapeOf(desconocido.body));
      expect(shapeOf(yaCaducado.body)).toEqual(shapeOf(desconocido.body));
    });

    it('AU-028 la comprobación previa responde lo mismo para los tres', async () => {
      // La pantalla pregunta antes de pedir una contraseña, para poder decir
      // «este enlace ya no sirve» en lugar de dejar a alguien pensando que se
      // equivocó al escribirla.
      await createAccount();
      const usado = mailer.tokenFromLast();
      await setCredential({ token: usado, password: NEW_PASSWORD }).expect(204);

      const stale = await createAccount();
      const caducado = mailer.tokenFromLast();
      await expireInvitationOf(stale.id);

      const answers: TokenStatusBody[] = [];
      for (const value of ['no-existe', usado, caducado]) {
        const response = await checkToken(value).expect(200);
        answers.push(response.body as TokenStatusBody);
      }

      expect(answers).toEqual([
        { valid: false, expiresAt: null },
        { valid: false, expiresAt: null },
        { valid: false, expiresAt: null },
      ]);
    });

    it('AU-021 no exige ninguna autenticación para fijar la contraseña', async () => {
      // Es la razón de ser de la ruta: quien no puede iniciar sesión es justo
      // quien tiene que alcanzarla. Sin cabecera `Authorization` en ninguna de
      // las llamadas de este archivo, y aun así funciona.
      await createAccount();
      const plain = mailer.tokenFromLast();

      await checkToken(plain).expect(200);
      await setCredential({ token: plain, password: NEW_PASSWORD }).expect(204);
    });
  });

  describe('reenvío', () => {
    it('AU-027 el reenvío anula el enlace anterior', async () => {
      // El caso que lo hace importar: el correo estaba mal tecleado, así que
      // el enlace anterior está en el buzón de un desconocido. Un reenvío que
      // se limitara a añadir otro lo dejaría ahí.
      const created = await createAccount();
      const primero = mailer.tokenFromLast();

      await request(server())
        .post(`${base}/users/${created.id}/invitation`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      const segundo = mailer.tokenFromLast();
      expect(segundo).not.toBe(primero);

      // El viejo ya no sirve, ni para comprobar ni para canjear.
      await checkToken(primero).expect(200).expect({ valid: false, expiresAt: null }); // prettier-ignore
      await setCredential({ token: primero, password: NEW_PASSWORD }).expect(422); // prettier-ignore

      // El nuevo sí.
      await setCredential({ token: segundo, password: NEW_PASSWORD }).expect(204); // prettier-ignore
    });

    it('AU-027 deja UNA sola invitación viva, que es lo que garantiza el índice parcial', async () => {
      const created = await createAccount();

      for (let i = 0; i < 3; i += 1) {
        await request(server())
          .post(`${base}/users/${created.id}/invitation`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);
      }

      // Cuatro filas —el rastro de cuántas veces hizo falta invitar— y una
      // sola viva. `credential_invitation_one_live_per_user` es lo que lo
      // impone, no un `if`.
      const all = await prisma.credentialInvitation.findMany({
        where: { userId: created.id },
      });
      const live = all.filter((row) => row.usedAt === null);

      expect(all).toHaveLength(4);
      expect(live).toHaveLength(1);
    });

    it('AU-021 responde USER_NOT_FOUND al reenviar a una cuenta que no existe', async () => {
      const response = await request(server())
        .post(`${base}/users/00000000-0000-0000-0000-0000000000ff/invitation`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(404);

      expect((response.body as Problem).code).toBe('USER_NOT_FOUND');
    });

    it('AU-021 exige user:manage para reenviar una invitación', async () => {
      const created = await createAccount();

      await request(server())
        .post(`${base}/users/${created.id}/invitation`)
        .send({})
        .expect(401);
    });
  });

  describe('cuando el correo no sale', () => {
    it('AU-029 conserva la cuenta y lo dice en la respuesta', async () => {
      // La alternativa —deshacer el alta— convertiría una caída del servidor
      // de correo en «no se puede dar de alta a nadie».
      mailer.failWith = new MailDeliveryFailedError();

      const created = await createAccount();

      expect(created.invitationSent).toBe(false);
      expect(created.credentialPending).toBe(true);

      // La cuenta existe de verdad, no es una respuesta de cortesía.
      await request(server())
        .get(`${base}/users/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('AU-029 la invitación queda emitida y el reenvío la entrega cuando el correo vuelve', async () => {
      // Es la mitad que hace útil a `invitationSent: false`: la pantalla
      // ofrece reenviar, y reenviar funciona.
      mailer.failWith = new MailDeliveryFailedError();
      const created = await createAccount();
      expect(created.invitationSent).toBe(false);

      mailer.failWith = null;
      const resent = await request(server())
        .post(`${base}/users/${created.id}/invitation`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      expect((resent.body as { invitationSent: boolean }).invitationSent).toBe(true); // prettier-ignore

      await setCredential({
        token: mailer.tokenFromLast(),
        password: NEW_PASSWORD,
      }).expect(204);

      await request(server())
        .post(`${base}/login`)
        .send({ email: created.email, password: NEW_PASSWORD })
        .expect(200);
    });
  });
});
