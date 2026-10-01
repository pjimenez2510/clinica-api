import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
// AU-035: el segundo factor se matricula por las rutas reales, y el TOTP se
// calcula desde el `uri` de la matrícula — lo que haría el teléfono al leer el
// QR. Reconstruirlo con los parámetros copiados del servicio probaría la copia.
import { URI } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { MAILER } from '../../src/shared/mail/mail.port';

import { useDatabase } from './setup/database';
import { FakeMailer } from './setup/fake-mailer';
import { establishmentId } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The administration half of `auth` (A2) as the browser consumes it, against a
 * real PostgreSQL 18.
 *
 * WHAT THESE PROVE THAT THE UNIT SUITES CANNOT:
 *
 *   - AU-023: deactivating an account really ends its open sessions. The unit
 *     test asserts the port was called; this asserts the refresh that was
 *     working a line earlier now answers 401, which is the thing that matters.
 *   - AU-024, all three shapes, WITH the database's own statement-level
 *     trigger underneath. This is the requirement whose failure locks everyone
 *     out permanently, so it is the one that must not depend on a check in
 *     TypeScript being reached.
 *   - AU-031: the trigger `trg_role_protect_system` and the RESTRICT foreign
 *     key from `user_role_grant` — neither of which a double can demonstrate.
 *   - AU-032: a change to what a role carries reaches a token that was issued
 *     BEFORE the change, without anybody signing in again. That is only
 *     observable end to end, because it is a property of how the guard
 *     resolves permissions per request.
 *   - AU-021: the account created by `POST /auth/users` cannot sign in.
 */
const PASSWORD = 'el caballo come alfalfa';
const ADMIN_EMAIL = 'gerencia@clinica.ec';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';

/** Synthetic cedulas with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';
const RECEPCION_CEDULA = '0926687856';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface AccountBody {
  id: string;
  email: string;
  /** AU-020. Present in the LIST too, which is why `user:read` says so. */
  cedula: string | null;
  active: boolean;
  credentialPending: boolean;
}

interface RoleBody {
  id: string;
  code: string;
  isSystem: boolean;
  active: boolean;
  liveGrants: number;
}

interface RolePermissionsBody {
  roleId: string;
  permissions: string[];
  warnings: string[];
}

describe('la administración de cuentas y roles por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let adminUserId: string;
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
         * ⚠️ NO SMTP CONNECTION IN A TEST, EVER. Creating an account now
         * sends the invitation of AU-021, and without this override every
         * `createAccount` here would spend ten seconds failing to resolve
         * `not-a-real-host` — or, on a machine with Mailpit and a real `.env`,
         * would actually send.
         */
        .overrideProvider(MAILER)
        .useValue(mailer)
        // The storage is replaced, not the guard: `APP_GUARD` also covers the
        // authorisation guard, which is exactly what these tests exercise.
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
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', ADMIN_CEDULA);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function hash(): Promise<string> {
    return argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: PASSWORD_HASHING.memoryCost,
      timeCost: PASSWORD_HASHING.timeCost,
      parallelism: PASSWORD_HASHING.parallelism,
    });
  }

  async function signIn(
    email: string,
    roleCode: string,
    cedula: string | null,
    /** AU-038: a grant confined to ONE site. Absent = clinic-wide. */
    grantedSiteId?: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        cedula,
        passwordHash: await hash(),
      },
    });
    // Only the clinic-wide administrator is the one the rest of this suite
    // acts as; a site-scoped one must not take the name from underneath it.
    if (roleCode === 'ADMIN' && grantedSiteId === undefined) {
      adminUserId = user.id;
    }

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    // GLOBAL grant (siteId null): administering the clinic is not scoped to
    // one of its sites, and this is how a director is hired. AU-038 is what
    // happens when the grant is NOT global.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grantedSiteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const base = '/api/v1/auth';

  const get = (path: string, auth = token) =>
    request(app.getHttpServer())
      .get(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`);

  const post = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .post(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const put = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .put(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const patch = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const destroy = (path: string) =>
    request(app.getHttpServer())
      .delete(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`);

  let sequence = 0;
  const nextEmail = (): string => {
    sequence += 1;
    return `nueva${sequence}@clinica.ec`;
  };

  async function createAccount(
    overrides: Record<string, unknown> = {},
  ): Promise<AccountBody> {
    const response = await post('/users', {
      email: nextEmail(),
      firstName: 'Ana',
      lastName: 'Villacís',
      ...overrides,
    }).expect(201);
    return response.body as AccountBody;
  }

  async function createRole(
    overrides: Record<string, unknown> = {},
  ): Promise<RoleBody> {
    sequence += 1;
    const response = await post('/roles', {
      code: `ROL_PRUEBA_${sequence}`,
      name: 'Rol de prueba',
      ...overrides,
    }).expect(201);
    return response.body as RoleBody;
  }

  const roleIdOf = async (code: string): Promise<string> =>
    (await prisma.role.findUniqueOrThrow({ where: { code } })).id;

  describe('las cuentas', () => {
    it('AU-020 crea una cuenta con nombre, apellido y correo institucional', async () => {
      const created = await createAccount({ email: 'ANA.Villacis@Clinica.EC' });

      // Normalised to lowercase: signing in must not depend on how it was
      // typed, and the unique index is what makes the two agree.
      expect(created.email).toBe('ana.villacis@clinica.ec');
      expect(created.active).toBe(true);
    });

    it('AU-020 rechaza un correo que ya pertenece a otra cuenta', async () => {
      await createAccount({ email: 'repetida@clinica.ec' });

      const response = await post('/users', {
        email: 'repetida@clinica.ec',
        firstName: 'Otra',
        lastName: 'Persona',
      }).expect(409);

      expect((response.body as Problem).code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('AU-021 crea la cuenta SIN credencial: no puede iniciar sesión todavía', async () => {
      // D-013 quedó resuelta por correo, y AU-021 sigue prohibiendo lo mismo:
      // el administrador NO elige la contraseña de nadie. La cuenta existe, la
      // invitación va camino del buzón de la persona, y hasta que la canjee la
      // cuenta no entra. El flujo completo está en
      // `auth-credential-http.spec.ts`.
      const created = await createAccount({
        email: 'sincredencial@clinica.ec',
      });

      expect(created.credentialPending).toBe(true);

      const attempt = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'sincredencial@clinica.ec', password: PASSWORD })
        .expect(401);

      // AU-002: responde exactamente igual que una contraseña equivocada. La
      // cuenta sin credencial no se distingue de ninguna otra desde fuera.
      expect((attempt.body as Problem).code).toBe('INVALID_CREDENTIALS');
    });

    it('AU-021 tampoco entra con la cadena que hace de marcador', async () => {
      // El centinela no es un hash de Argon2, así que no puede ser el
      // resultado de ninguna contraseña — pero conviene demostrar que tampoco
      // se acepta escribiéndolo tal cual.
      await createAccount({ email: 'centinela@clinica.ec' });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          email: 'centinela@clinica.ec',
          password: '!no-usable-credential',
        })
        .expect(401);
    });

    it('AU-025 deja en la bitácora quién creó la cuenta, y nunca la credencial', async () => {
      const created = await createAccount();

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'auth' },
        select: { action: true, resourceId: true, userId: true },
        // Explicit order: `id` is the autoincrement, so it is the sequence in
        // which the two entries were written. Without it PostgreSQL is free to
        // return them either way round and the test passes or fails by luck.
        orderBy: { id: 'asc' },
      });

      // DOS entradas y no una: el alta, y la invitación de primera credencial
      // que la sigue (AU-021). Las dos llevan al administrador como autor y
      // ninguna tiene dónde poner un hash, un token ni una contraseña — que es
      // cómo se cumple «NO DEBERÁ registrar nunca la contraseña».
      expect(trail).toEqual([
        { action: 'CREATE', resourceId: created.id, userId: adminUserId },
        { action: 'UPDATE', resourceId: created.id, userId: adminUserId },
      ]);
    });

    it('AU-022 no ofrece NINGUNA ruta para borrar una cuenta', async () => {
      // Los accesos de esta persona están en la bitácora, y borrar la cuenta
      // dejaría huérfana la evidencia que exige la LOPDP (REQ-110). La
      // ausencia de la ruta ES el cumplimiento.
      const created = await createAccount();

      const response = await destroy(`/users/${created.id}`);
      expect([404, 405]).toContain(response.status);

      // Y la cuenta sigue ahí.
      await get(`/users/${created.id}`).expect(200);
    });

    it('AU-022 desactiva la cuenta, que es lo que se ofrece en su lugar', async () => {
      const created = await createAccount();

      const response = await post(`/users/${created.id}/deactivate`, {}).expect(
        200,
      );

      expect((response.body as AccountBody).active).toBe(false);
    });

    it('AU-022 esconde las cuentas desactivadas del listado salvo que se pidan', async () => {
      const created = await createAccount();
      await post(`/users/${created.id}/deactivate`, {}).expect(200);

      const hidden = await get('/users').expect(200);
      const shown = await get('/users?includeInactive=true').expect(200);

      const ids = (body: unknown): string[] =>
        (body as { items: AccountBody[] }).items.map((item) => item.id);

      expect(ids(hidden.body)).not.toContain(created.id);
      expect(ids(shown.body)).toContain(created.id);
    });

    it('AU-020 rechaza al crear una cédula que no supera el dígito verificador', async () => {
      // Hasta esta corrección el DTO sólo limitaba la longitud, y su comentario
      // decía que del dígito verificador se encargaban el value object `Cedula`
      // y el `is_valid_cedula()` de la base. Las dos afirmaciones eran falsas:
      // la función colgaba únicamente de `patient_identifier` y nadie importaba
      // `Cedula` bajo `modules/auth/`.
      const response = await post('/users', {
        email: nextEmail(),
        firstName: 'Ana',
        lastName: 'Villacís',
        // El mismo número con el dígito verificador cambiado en uno.
        cedula: '1710034066',
      }).expect(422);

      const problem = response.body as Problem;
      expect(problem.errors?.[0]?.field).toBe('cedula');
      expect(await prisma.user.count({ where: { cedula: '1710034066' } })).toBe(0); // prettier-ignore
    });

    it('AU-020 rechaza al editar una cédula que no es una cédula', async () => {
      // `PATCH /auth/users/:id {"cedula":"abc"}` respondía 2xx y guardaba
      // «abc» en la columna que el RDACAA exige en cada atención (REQ-021).
      const created = await createAccount();

      const response = await patch(`/users/${created.id}`, {
        cedula: 'abc',
      }).expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('cedula');
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: created.id },
        select: { cedula: true },
      });
      expect(after.cedula).toBeNull();
    });

    it('AU-020 la BASE también rechaza una cédula imposible en app_user', async () => {
      // Un `psql` a las dos de la mañana o una importación de datos esquivan el
      // DTO igual que lo esquivaba el listado. `app_user_cedula_valid` es lo
      // que queda, con el mismo algoritmo que el value object.
      // `app_user.id` y `updated_at` los pone Prisma, no la base: por eso
      // viajan explícitos aquí, que es exactamente lo que haría la
      // importación de datos contra la que protege la restricción.
      await expect(
        prisma.$executeRaw`
          INSERT INTO app_user (id, email, password_hash, first_name, last_name, cedula, updated_at)
          VALUES (gen_random_uuid(), 'cruda@clinica.ec', 'x', 'Ana', 'Villacís', '1710034066', now())
        `,
      ).rejects.toThrowError(/app_user_cedula_valid/);
    });

    it('AU-020 la misma restricción deja pasar NULL: recepción no firma nada', async () => {
      // NULL es el caso mayoritario y sigue siendo legítimo. Si la restricción
      // lo rechazara, la clínica no podría dar de alta a nadie que no sea
      // profesional.
      await expect(
        prisma.$executeRaw`
          INSERT INTO app_user (id, email, password_hash, first_name, last_name, cedula, updated_at)
          VALUES (gen_random_uuid(), 'sin.cedula@clinica.ec', 'x', 'Ana', 'Villacís', NULL, now())
        `,
      ).resolves.toBe(1);
    });

    it('AU-025 guarda la cédula válida y la deja vacía cuando se borra', async () => {
      const created = await createAccount({ cedula: '1713175071' });
      expect(created.cedula).toBe('1713175071');

      // La cadena vacía es como un formulario manda un campo borrado.
      await patch(`/users/${created.id}`, { cedula: '' }).expect(200);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: created.id },
        select: { cedula: true },
      });
      expect(after.cedula).toBeNull();
    });

    it('AU-020 encuentra una cuenta por nombre o por correo', async () => {
      await createAccount({ email: 'buscable@clinica.ec', lastName: 'Zambrano' }); // prettier-ignore

      const byName = await get('/users?search=zambrano').expect(200);
      const byEmail = await get('/users?search=buscable').expect(200);

      expect((byName.body as { items: AccountBody[] }).items).toHaveLength(1);
      expect((byEmail.body as { items: AccountBody[] }).items).toHaveLength(1);
    });

    it('AU-023 invalida las sesiones abiertas al desactivar la cuenta', async () => {
      // La mitad que de verdad importa: sin ella, «desactivar» no significa
      // nada — la cuenta sigue refrescando su sesión indefinidamente.
      const user = await prisma.user.create({
        data: {
          email: 'con.sesion@clinica.ec',
          firstName: 'Luis',
          lastName: 'Mora',
          passwordHash: await hash(),
        },
      });

      const signedIn = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'con.sesion@clinica.ec', password: PASSWORD })
        .expect(200);
      const cookies = signedIn.get('Set-Cookie');
      expect(cookies, 'el inicio de sesión debe fijar la cookie').toBeDefined();

      // La sesión funciona ANTES de desactivar: si no, la prueba pasaría
      // vacíamente y no demostraría nada.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookies!)
        .expect(200);

      await post(`/users/${user.id}/deactivate`, {}).expect(200);

      // La cookie rotó en el refresco de arriba, así que se usa la nueva.
      const rotated = signedIn.get('Set-Cookie');
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', rotated!)
        .expect(401);

      const revoked = await prisma.refreshToken.findMany({
        where: { userId: user.id },
        select: { revokedAt: true, revocationReason: true },
      });
      expect(revoked.every((row) => row.revokedAt !== null)).toBe(true);
      expect(
        revoked.some((row) => row.revocationReason === 'ACCOUNT_DEACTIVATED'),
      ).toBe(true);
    });

    it('AU-023 vuelve a rechazar el inicio de sesión mientras la cuenta esté desactivada', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'desactivada@clinica.ec',
          firstName: 'Luis',
          lastName: 'Mora',
          passwordHash: await hash(),
        },
      });

      await post(`/users/${user.id}/deactivate`, {}).expect(200);

      const attempt = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'desactivada@clinica.ec', password: PASSWORD })
        .expect(401);

      // AU-002 otra vez: no se distingue de una contraseña equivocada.
      expect((attempt.body as Problem).code).toBe('INVALID_CREDENTIALS');
    });

    it('AU-022 reactiva la cuenta y vuelve a dejarla entrar', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'reactivable@clinica.ec',
          firstName: 'Luis',
          lastName: 'Mora',
          passwordHash: await hash(),
        },
      });

      await post(`/users/${user.id}/deactivate`, {}).expect(200);
      await post(`/users/${user.id}/activate`, {}).expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'reactivable@clinica.ec', password: PASSWORD })
        .expect(200);
    });
  });

  describe('AU-024 · lo que protegería a la instalación de quedarse sin nadie', () => {
    it('AU-024 impide que un administrador se desactive a sí mismo', async () => {
      // Primera forma. Quien lo hace queda fuera en la petición siguiente, y
      // no queda ninguna sesión capaz de deshacerlo.
      const response = await post(
        `/users/${adminUserId}/deactivate`,
        {},
      ).expect(422);

      expect((response.body as Problem).code).toBe('CANNOT_DEMOTE_SELF');

      const still = await prisma.user.findUniqueOrThrow({
        where: { id: adminUserId },
        select: { active: true },
      });
      expect(still.active).toBe(true);
    });

    it('AU-024 impide que un administrador se quite a sí mismo user:manage por sus roles', async () => {
      // Segunda forma: editando sus propias concesiones y dejándose sólo un
      // rol clínico.
      const medico = await roleIdOf('MEDICO');

      const response = await put(`/users/${adminUserId}/roles`, {
        grants: [{ roleId: medico }],
      }).expect(422);

      expect((response.body as Problem).code).toBe('CANNOT_DEMOTE_SELF');

      const grants = await get(`/users/${adminUserId}/roles`).expect(200);
      expect(
        (grants.body as { items: { roleCode: string }[] }).items.map(
          (item) => item.roleCode,
        ),
      ).toEqual(['ADMIN']);
    });

    it('AU-024 impide quitarle user:manage al último rol activo que lo lleva', async () => {
      // Tercera forma, y la peor: se llega a ella editando el rol, sin
      // descuidarse con la propia cuenta.
      const admin = await roleIdOf('ADMIN');
      const current = await get(`/roles/${admin}/permissions`).expect(200);
      const without = (current.body as RolePermissionsBody).permissions.filter(
        (code) => code !== 'user:manage',
      );

      const response = await put(`/roles/${admin}/permissions`, {
        permissions: without,
      }).expect(422);

      expect((response.body as Problem).code).toBe('CANNOT_DEMOTE_SELF');

      // Y el permiso sigue donde estaba: no se guardó a medias.
      const after = await get(`/roles/${admin}/permissions`).expect(200);
      expect((after.body as RolePermissionsBody).permissions).toContain(
        'user:manage',
      );
    });

    it('AU-024 impide desactivar el último rol activo que administra usuarios', async () => {
      const admin = await roleIdOf('ADMIN');

      const response = await patch(`/roles/${admin}`, { active: false }).expect(422); // prettier-ignore

      expect((response.body as Problem).code).toBe('CANNOT_DEMOTE_SELF');
    });

    it('AU-024 la BASE también lo impide, no sólo el servicio', async () => {
      // `trg_role_permission_keep_an_administrator` es un disparador de
      // sentencia, diferido al COMMIT. Es la última línea y la única que
      // aguanta un `DELETE FROM role_permission` tecleado en `psql`.
      const admin = await roleIdOf('ADMIN');

      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM role_permission WHERE permission_code = 'user:manage'`,
        ),
      ).rejects.toThrow(/at least one active role must keep user:manage/);

      const survivors = await prisma.rolePermission.count({
        where: { roleId: admin, permissionCode: 'user:manage' },
      });
      expect(survivors).toBe(1);
    });

    it('AU-032 nadie se concede a sí mismo un rol, ni siquiera administrando', async () => {
      // `user_role_grant_no_self_grant` lleva en la base desde la migración de
      // roles con su porqué al lado: la pregunta de auditoría «quién dio a esta
      // persona acceso a las historias» no puede responderse «ella misma».
      // Construir esta pantalla es lo que por fin le ha dado forma de
      // alcanzarse, y el servicio la responde con una frase en lugar de con un
      // `CHECK_FAILED`.
      const medico = await roleIdOf('MEDICO');
      const admin = await roleIdOf('ADMIN');

      const response = await put(`/users/${adminUserId}/roles`, {
        grants: [{ roleId: admin }, { roleId: medico }],
      }).expect(422);

      expect((response.body as Problem).code).toBe('CANNOT_GRANT_TO_SELF');
    });

    it('AU-032 la BASE también rechaza la concesión a uno mismo', async () => {
      const medico = await roleIdOf('MEDICO');

      await expect(
        prisma.userRoleGrant.create({
          data: {
            userId: adminUserId,
            roleId: medico,
            grantedById: adminUserId,
          },
        }),
      ).rejects.toThrow(/user_role_grant_no_self_grant/);
    });

    it('AU-024 sí permite el relevo: un sucesor recibe la administración y retira la del anterior', async () => {
      // La prohibición no es «no puedes editarte»: es «no puedes dejar el
      // sistema sin administración», y la separación de funciones añade que
      // nadie se concede nada a sí mismo. El traspaso real pasa por dos
      // personas, que es exactamente lo que las dos reglas juntas describen.
      const relief = await createRole({ code: 'GERENCIA_2', name: 'Gerencia' });
      await put(`/roles/${relief.id}/permissions`, {
        permissions: ['user:manage', 'user:read'],
      }).expect(200);

      // El administrador de siempre da de alta a su sucesora y le concede el
      // rol nuevo — a ELLA, no a sí mismo.
      const successor = await prisma.user.create({
        data: {
          email: 'sucesora@clinica.ec',
          firstName: 'Rocío',
          lastName: 'Paredes',
          passwordHash: await hash(),
        },
      });
      await put(`/users/${successor.id}/roles`, {
        grants: [{ roleId: relief.id }],
      }).expect(200);

      const successorToken = (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'sucesora@clinica.ec', password: PASSWORD })
          .expect(200)
      ).body as { accessToken: string };

      // Y es LA SUCESORA quien retira la administración del rol anterior. Ya no
      // es el último que la lleva, y ella la conserva por el suyo.
      const admin = await roleIdOf('ADMIN');
      await put(
        `/roles/${admin}/permissions`,
        { permissions: ['site:read'] },
        successorToken.accessToken,
      ).expect(200);

      // El administrador de antes ya no administra: el relevo se completó.
      await get('/users', token).expect(403);
    });
  });

  describe('los roles', () => {
    it('AU-030 crea un rol propio de la clínica', async () => {
      const created = await createRole({
        code: 'ENLACE_SEGUROS',
        name: 'Enlace con aseguradoras',
      });

      expect(created).toMatchObject({
        code: 'ENLACE_SEGUROS',
        isSystem: false,
        active: true,
        liveGrants: 0,
      });
    });

    it('AU-030 rechaza un código de rol repetido', async () => {
      await createRole({ code: 'ENLACE_SEGUROS', name: 'Enlace' });

      const response = await post('/roles', {
        code: 'ENLACE_SEGUROS',
        name: 'Otro',
      }).expect(409);

      expect((response.body as Problem).code).toBe('ROLE_CODE_DUPLICATE');
    });

    it('AU-030 rechaza un código que no es un identificador', async () => {
      // Aparece en semillas, en registros y en conversaciones de soporte: en
      // minúsculas o con espacios deja de poder buscarse.
      await post('/roles', { code: 'enlace seguros', name: 'Enlace' }).expect(422); // prettier-ignore
    });

    it('AU-031 NO borra un rol del sistema y ofrece desactivarlo', async () => {
      const medico = await roleIdOf('MEDICO');

      const response = await destroy(`/roles/${medico}`).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SYSTEM_ROLE_PROTECTED');
      expect(problem.title).toContain('desactivarlo');
      expect(await prisma.role.count({ where: { id: medico } })).toBe(1);
    });

    it('AU-031 la BASE también protege el rol del sistema', async () => {
      // `trg_role_protect_system`. El servicio responde antes para que el
      // mensaje no dependa de una versión de PostgreSQL, y esto es lo que
      // aguanta cuando la escritura llega por otro camino.
      const medico = await roleIdOf('MEDICO');

      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM "role" WHERE id = $1::uuid`, medico), // prettier-ignore
      ).rejects.toThrow(/system role .* cannot be deleted/);
    });

    it('AU-031 NO borra un rol con concesiones vivas y ofrece desactivarlo', async () => {
      const role = await createRole();
      const account = await createAccount();
      await put(`/users/${account.id}/roles`, {
        grants: [{ roleId: role.id }],
      }).expect(200);

      const response = await destroy(`/roles/${role.id}`).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('ROLE_IN_USE');
      expect(problem.title).toContain('desactivarlo');
    });

    it('AU-031 borra un rol propio que nadie tiene', async () => {
      const role = await createRole();

      await destroy(`/roles/${role.id}`).expect(204);

      expect(await prisma.role.count({ where: { id: role.id } })).toBe(0);
    });

    it('AU-031 desactiva un rol y deja de conceder lo que llevaba', async () => {
      const role = await createRole();
      await put(`/roles/${role.id}/permissions`, {
        permissions: ['audit:read'],
      }).expect(200);

      await patch(`/roles/${role.id}`, { active: false }).expect(200);

      // `role-permission.registry.ts` excluye los inactivos EN LA CONSULTA, y
      // eso es lo que hace que desactivar sea una alternativa real a borrar.
      const resolved = await registry.resolve([
        { roleId: role.id, siteId: null },
      ]);
      expect(resolved).toEqual([]);
    });

    it('AU-031 esconde los roles desactivados del listado salvo que se pidan', async () => {
      const role = await createRole();
      await patch(`/roles/${role.id}`, { active: false }).expect(200);

      const hidden = await get('/roles').expect(200);
      const shown = await get('/roles?includeInactive=true').expect(200);

      const ids = (body: unknown): string[] =>
        (body as { items: RoleBody[] }).items.map((item) => item.id);

      expect(ids(hidden.body)).not.toContain(role.id);
      expect(ids(shown.body)).toContain(role.id);
    });
  });

  describe('los permisos de un rol', () => {
    it('AU-033 expone el catálogo con su recurso y su descripción', async () => {
      // Sin descripción, quien asigna marca casillas por su forma.
      const response = await get('/permissions').expect(200);
      const items = (
        response.body as {
          items: { code: string; resource: string; description: string }[];
        }
      ).items;

      expect(items.length).toBeGreaterThan(10);
      expect(items.every((item) => item.description.length > 0)).toBe(true);
      expect(items.map((item) => item.code)).toContain('settings:manage');
    });

    it('AU-033 rechaza un permiso que el código no declara', async () => {
      const role = await createRole();

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['agenda:read', 'historia:borrar'],
      }).expect(422);

      expect((response.body as Problem).code).toBe('UNKNOWN_PERMISSION');
    });

    it('AU-033 no escribe nada cuando uno solo de los códigos es desconocido', async () => {
      const role = await createRole();
      await put(`/roles/${role.id}/permissions`, {
        permissions: ['agenda:read'],
      }).expect(200);

      await put(`/roles/${role.id}/permissions`, {
        permissions: ['agenda:write', 'no:existe'],
      }).expect(422);

      const after = await get(`/roles/${role.id}/permissions`).expect(200);
      expect((after.body as RolePermissionsBody).permissions).toEqual([
        'agenda:read',
      ]);
    });

    it('AU-033 dice que el permiso NO ESTÁ INSTALADO cuando la base va por detrás del código', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EL FALLO TAL Y COMO OCURRIÓ, CONTRA LA BASE DE VERDAD.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `permission` es un ESPEJO del catálogo del código, y la pantalla lee el
       * catálogo del CÓDIGO —a propósito: `RolesService.catalogue()` explica por
       * qué—. Entre desplegar una versión que declara un permiso nuevo y correr
       * `pnpm db:seed:auth` los dos discrepan, y marcar esa casilla moría en la
       * clave foránea: 422 `RELATED_RECORD_MISSING`, en pantalla «Datos
       * inválidos», sobre un formulario donde nada era inválido.
       *
       * NINGUNA PRUEBA PODÍA VERLO, y esa es la otra mitad del defecto: todas
       * las de integración llaman a `syncAuthorisation` al preparar, así que la
       * discrepancia era irrepresentable en la suite. Aquí se provoca borrando
       * la fila del espejo, que es exactamente el estado de un despliegue sin
       * sincronizar.
       *
       * `user:reset-mfa` y no otro porque es el que lo destapó: AU-035 obliga a
       * que una instalación lo conceda a propósito, así que hay una persona
       * delante de esa pantalla marcándolo, y lo que obtenía no le decía nada.
       */
      const role = await createRole();
      await prisma.permission.delete({ where: { code: 'user:reset-mfa' } });

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['agenda:read', 'user:reset-mfa'],
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PERMISSION_NOT_INSTALLED');

      /**
       * LO QUE SE AFIRMA ES EL `errors[0].message`, Y NO EL `title`, porque es
       * el que la pantalla enseña: `ApiError.userMessage` en `clinica-web`
       * prefiere el error de campo sobre el título. La primera versión de este
       * arreglo puso la frase accionable en `title` y una lista de códigos
       * pelada en el campo, así que en pantalla se leía «Permisos sin
       * instalar: user:reset-mfa» — mejor que «Datos inválidos», pero sin
       * ninguna de las palabras que dicen qué hacer.
       */
      const message = problem.errors?.[0]?.message ?? '';
      // El permiso, para poder decir cuál en una llamada a soporte.
      expect(message).toContain('user:reset-mfa');
      // Qué hacer ahora, y a quién avisar para que deje de pasar.
      expect(message).toContain('Desmárquelo');
      expect(message).toContain('avise a quien administra');

      // Y no se escribió el subconjunto que sí estaba instalado: el rol
      // conserva lo que tenía.
      const after = await get(`/roles/${role.id}/permissions`).expect(200);
      expect((after.body as RolePermissionsBody).permissions).toEqual([]);
    });

    it('AU-033 guarda con normalidad en cuanto el espejo está publicado', async () => {
      // La otra mitad de la prueba de arriba: el rechazo es por el estado de la
      // instalación, no por el permiso. Sin esto, un `if` que rechazara
      // `user:reset-mfa` siempre pasaría igual — y AU-035 dejaría de poder
      // cumplirse, porque la clínica no podría concedérselo a nadie.
      const role = await createRole();

      await put(`/roles/${role.id}/permissions`, {
        permissions: ['user:reset-mfa'],
      }).expect(200);

      const after = await get(`/roles/${role.id}/permissions`).expect(200);
      expect((after.body as RolePermissionsBody).permissions).toEqual([
        'user:reset-mfa',
      ]);
    });

    it('AU-034 ADVIERTE de record:* junto a user:manage y guarda igualmente', async () => {
      // El requisito es advertir SIN impedir: rechazarlo empujaría a una
      // clínica pequeña a compartir una cuenta, que es peor para la bitácora.
      const role = await createRole();

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['user:manage', 'record:read', 'record:write'],
      }).expect(200);

      const body = response.body as RolePermissionsBody;
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.warnings[0]).toContain('historia clínica');

      // Y la operación SÍ se guardó: la advertencia no es un rechazo.
      const stored = await prisma.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permissionCode: true },
      });
      expect(stored.map((row) => row.permissionCode).sort()).toEqual([
        'record:read',
        'record:write',
        'user:manage',
      ]);
    });

    it('AU-034 no advierte nada cuando la combinación es corriente', async () => {
      const role = await createRole();

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['agenda:read', 'patient:read'],
      }).expect(200);

      expect((response.body as RolePermissionsBody).warnings).toEqual([]);
    });

    it('AU-045 ADVIERTE del rol que receta sin background:write y guarda igualmente', async () => {
      const role = await createRole();

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['record:read', 'prescription:write'],
      }).expect(200);

      expect((response.body as RolePermissionsBody).warnings).toEqual([
        'Este rol receta o escribe en la historia clínica pero no puede registrar alergias ni antecedentes. Puede guardarlo igualmente.',
      ]);
      const stored = await prisma.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permissionCode: true },
      });
      expect(stored.map((row) => row.permissionCode).sort()).toEqual([
        'prescription:write',
        'record:read',
      ]);
    });

    it('AU-045 ADVIERTE del rol de enfermería sin background:write, con su frase, y guarda igualmente', async () => {
      const role = await createRole();

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['nursing:write', 'vitals:write'],
      }).expect(200);

      expect((response.body as RolePermissionsBody).warnings).toEqual([
        'Este rol registra los formularios de enfermería pero no puede registrar alergias ni antecedentes. Puede guardarlo igualmente.',
      ]);
      const stored = await prisma.rolePermission.count({
        where: { roleId: role.id },
      });
      expect(stored).toBe(2);
    });

    it('AU-045 control: con background:write no advierte nada', async () => {
      const role = await createRole();

      const response = await put(`/roles/${role.id}/permissions`, {
        permissions: ['record:read', 'prescription:write', 'background:write'],
      }).expect(200);

      expect((response.body as RolePermissionsBody).warnings).toEqual([]);
    });

    it('AU-045 la descripción de background:write dice que sin él no se registran alergias', async () => {
      const catalogue = await get('/permissions').expect(200);
      const description = (
        catalogue.body as { items: { code: string; description: string }[] }
      ).items.find((item) => item.code === 'background:write')?.description;

      expect(description).toBe(
        'Registrar alergias y antecedentes del paciente. Sin él no se registran alergias ni antecedentes',
      );
    });

    it('AU-045 una base que ya tenía la descripción vieja la recibe nueva al sincronizar', async () => {
      // Control: la fila parte del texto de antes, como en una instalación
      // desplegada. Sin esto, la prueba de arriba sólo diría que una base
      // nueva nace bien.
      await prisma.permission.update({
        where: { code: 'background:write' },
        data: { description: 'Registrar alergias y antecedentes del paciente' },
      });

      await syncAuthorisation(prisma);

      const { description } = await prisma.permission.findUniqueOrThrow({
        where: { code: 'background:write' },
      });
      expect(description).toBe(
        'Registrar alergias y antecedentes del paciente. Sin él no se registran alergias ni antecedentes',
      );
    });
  });

  describe('AU-032 · conceder un rol surte efecto sin volver a entrar', () => {
    it('AU-032 cambia los permisos efectivos del MISMO token, sin reiniciar la sesión', async () => {
      // Esta es la prueba literal del requisito. Los permisos se resuelven POR
      // PETICIÓN (AU-012), no dentro del token, así que un permiso añadido al
      // rol que alguien ya tiene alcanza al token que ya está en su navegador.
      const nurseToken = await signIn(
        'enfermeria@clinica.ec',
        'ENFERMERIA',
        null,
      );
      const nurseRole = await roleIdOf('ENFERMERIA');

      // Antes: enfermería no administra usuarios, así que no ve el catálogo.
      const before = await get('/permissions', nurseToken).expect(403);
      expect((before.body as Problem).code).toBe('PERMISSION_DENIED');

      const current = await get(`/roles/${nurseRole}/permissions`).expect(200);
      await put(`/roles/${nurseRole}/permissions`, {
        permissions: [
          ...(current.body as RolePermissionsBody).permissions,
          'user:read',
        ],
      }).expect(200);

      // Después: EL MISMO token, sin login, sin refresco, sin esperar el TTL.
      await get('/permissions', nurseToken).expect(200);
    });

    it('AU-032 revocar el permiso vuelve a cerrar la puerta en la petición siguiente', async () => {
      const nurseToken = await signIn(
        'enfermeria@clinica.ec',
        'ENFERMERIA',
        null,
      );
      const nurseRole = await roleIdOf('ENFERMERIA');
      const current = await get(`/roles/${nurseRole}/permissions`).expect(200);
      const original = (current.body as RolePermissionsBody).permissions;

      await put(`/roles/${nurseRole}/permissions`, {
        permissions: [...original, 'user:read'],
      }).expect(200);
      await get('/permissions', nurseToken).expect(200);

      await put(`/roles/${nurseRole}/permissions`, {
        permissions: original,
      }).expect(200);

      // Revocar tiene que surtir efecto en segundos, no en los quince minutos
      // que dura el token: es la mitad que de verdad protege.
      await get('/permissions', nurseToken).expect(403);
    });

    it('AU-032 concede un rol NUEVO con su sede y llega a la sesión al refrescarla', async () => {
      // MATIZ HONESTO, y conviene que quede escrito: el token lleva QUÉ ROLES
      // tiene el portador; lo que se resuelve por petición es qué permisos
      // lleva cada rol. Así que un rol RECIÉN CONCEDIDO alcanza a la persona
      // en cuanto su sesión rota —sin volver a teclear la contraseña— y no en
      // la petición inmediatamente siguiente. Cambiar eso significaría
      // consultar las concesiones en cada petición, que es justo el coste que
      // `role-permission.registry.ts` documenta haber evitado.
      const user = await prisma.user.create({
        data: {
          email: 'sin.roles@clinica.ec',
          firstName: 'Luis',
          lastName: 'Mora',
          passwordHash: await hash(),
        },
      });

      const signedIn = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'sin.roles@clinica.ec', password: PASSWORD })
        .expect(200);
      const cookies = signedIn.get('Set-Cookie');
      const firstToken = (signedIn.body as { accessToken: string }).accessToken;

      await get('/permissions', firstToken).expect(403);

      const auditor = await roleIdOf('AUDITOR');
      await put(`/roles/${auditor}/permissions`, {
        permissions: ['audit:read', 'user:read'],
      }).expect(200);
      const granted = await put(`/users/${user.id}/roles`, {
        grants: [{ roleId: auditor }],
      }).expect(200);

      expect(
        (granted.body as { items: { roleCode: string }[] }).items[0]?.roleCode,
      ).toBe('AUDITOR');

      // Sin credenciales: sólo la cookie que ya tenía.
      const resumed = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookies!)
        .expect(200);

      const resumedToken = (resumed.body as { accessToken: string })
        .accessToken;
      await get('/permissions', resumedToken).expect(200);
    });

    it('AU-032 conserva la sede de la concesión', async () => {
      const site = await prisma.site.create({
        data: {
          mspUnicode: 'AUTH-0001',
          establishmentId: await establishmentId(prisma),
          name: 'Sede Norte',
        },
        select: { id: true },
      });
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      const response = await put(`/users/${account.id}/roles`, {
        grants: [{ roleId: recepcion, siteId: site.id }],
      }).expect(200);

      expect(
        (response.body as { items: { siteId: string | null }[] }).items[0]
          ?.siteId,
      ).toBe(site.id);
    });

    it('AU-032 revoca la concesión en lugar de borrarla, para que quede quién la tuvo', async () => {
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      await put(`/users/${account.id}/roles`, {
        grants: [{ roleId: recepcion }],
      }).expect(200);
      await put(`/users/${account.id}/roles`, { grants: [] }).expect(200);

      const rows = await prisma.userRoleGrant.findMany({
        where: { userId: account.id },
        select: { revokedAt: true },
      });

      // La fila sigue ahí, revocada: quién pudo hacer qué y cuándo es
      // evidencia que la LOPDP espera (REQ-110), y una fila borrada no lo dice.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).not.toBeNull();
    });

    it('AU-032 no reescribe una concesión que ya era exactamente la pedida', async () => {
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      await put(`/users/${account.id}/roles`, {
        grants: [{ roleId: recepcion }],
      }).expect(200);
      const first = await prisma.userRoleGrant.findFirstOrThrow({
        where: { userId: account.id, revokedAt: null },
        select: { id: true, grantedAt: true },
      });

      await put(`/users/${account.id}/roles`, {
        grants: [{ roleId: recepcion }],
      }).expect(200);

      const after = await prisma.userRoleGrant.findMany({
        where: { userId: account.id },
        select: { id: true, grantedAt: true },
      });

      // Revocar y volver a conceder reescribiría `granted_at` y `granted_by`, y
      // la bitácora mostraría un cambio que no ocurrió.
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(first.id);
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AU-038 — LA CONCESIÓN DE ROLES ERA ESCALADA DE PRIVILEGIOS (D-023, opción A)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `PUT /users/:id/roles` declaraba alcance `global` mientras `grants[].siteId`
   * viajaba en el CUERPO, donde el guard no mira. Quien tuviera `user:manage`
   * acotado a una sede podía conceder a OTRA cuenta un rol con `siteId: null`
   * —toda sede, presente y futura— y a partir de ahí el alcance por sede deja
   * de significar nada en todo el sistema. Concedérselo a sí mismo ya lo
   * impedía `CANNOT_GRANT_TO_SELF`; hacerlo a una segunda cuenta, no.
   *
   * Decisión del usuario (15-08-2026): **opción A**, sólo dentro de su alcance,
   * comprobado en los dos extremos como ST-047.
   */
  describe('AU-038 · el alcance por sede al conceder roles', () => {
    const SEDE_ADMIN_EMAIL = 'admin.norte@clinica.ec';
    /** Cédula sintética con dígito verificador calculado. */
    const SEDE_ADMIN_CEDULA = '1708221443';

    async function twoSites(): Promise<{
      norte: { id: string };
      sur: { id: string };
      scoped: string;
    }> {
      const norte = await prisma.site.create({
        data: {
          mspUnicode: 'AUTH-9001',
          establishmentId: await establishmentId(prisma),
          name: 'Sede Norte',
        },
        select: { id: true },
      });
      const sur = await prisma.site.create({
        data: {
          mspUnicode: 'AUTH-9002',
          establishmentId: await establishmentId(prisma),
          name: 'Sede Sur',
        },
        select: { id: true },
      });
      const scoped = await signIn(
        SEDE_ADMIN_EMAIL,
        'ADMIN',
        SEDE_ADMIN_CEDULA,
        norte.id,
      );
      return { norte, sur, scoped };
    }

    const liveGrants = async (userId: string) =>
      prisma.userRoleGrant.findMany({
        where: { userId, revokedAt: null },
        select: { siteId: true },
      });

    it('AU-038 quien administra Norte NO puede conceder un rol global a otra cuenta', async () => {
      const { scoped } = await twoSites();
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      // `siteId` ausente = todas las sedes, incluidas las que se abran después.
      const response = await put(
        `/users/${account.id}/roles`,
        { grants: [{ roleId: recepcion }] },
        scoped,
      ).expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      // «Sin escribir nada»: la cuenta sigue sin ninguna concesión viva.
      expect(await liveGrants(account.id)).toEqual([]);
    });

    it('AU-038 tampoco puede conceder un rol en OTRA sede', async () => {
      const { sur, scoped } = await twoSites();
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      const response = await put(
        `/users/${account.id}/roles`,
        { grants: [{ roleId: recepcion, siteId: sur.id }] },
        scoped,
      ).expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      expect(await liveGrants(account.id)).toEqual([]);
      // La negativa no confirma que ese identificador sea una sede.
      expect(JSON.stringify(response.body)).not.toContain(sur.id);
    });

    it('AU-038 tampoco puede REVOCAR en silencio la concesión de otra sede', async () => {
      // El PUT fija el conjunto entero: enviar sólo lo suyo dejaría sin rol a
      // la recepción de otra ciudad, y eso es tan suyo como dárselo.
      const { norte, sur, scoped } = await twoSites();
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');
      await put(`/users/${account.id}/roles`, {
        grants: [
          { roleId: recepcion, siteId: norte.id },
          { roleId: recepcion, siteId: sur.id },
        ],
      }).expect(200);

      const response = await put(
        `/users/${account.id}/roles`,
        { grants: [{ roleId: recepcion, siteId: norte.id }] },
        scoped,
      ).expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      expect(
        (await liveGrants(account.id)).map((row) => row.siteId).sort(),
      ).toEqual(
        // prettier-ignore
        [norte.id, sur.id].sort(),
      );
    });

    it('AU-038 sí concede dentro de SU sede: la comprobación no es un muro', async () => {
      const { norte, scoped } = await twoSites();
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      await put(
        `/users/${account.id}/roles`,
        { grants: [{ roleId: recepcion, siteId: norte.id }] },
        scoped,
      ).expect(200);

      expect(await liveGrants(account.id)).toEqual([{ siteId: norte.id }]);
    });

    it('AU-038 la concesión de clínica sigue concediendo el rol global: es la dirección', async () => {
      const { sur } = await twoSites();
      const account = await createAccount();
      const recepcion = await roleIdOf('RECEPCION');

      // `token` es la administradora con concesión global (`siteId` nulo).
      await put(`/users/${account.id}/roles`, {
        grants: [{ roleId: recepcion }, { roleId: recepcion, siteId: sur.id }],
      }).expect(200);

      expect(
        (await liveGrants(account.id)).map((row) => row.siteId).sort(),
      ).toEqual(
        // prettier-ignore
        [null, sur.id].sort(),
      );
    });
  });

  describe('quién puede administrar', () => {
    it('AU-020 rechaza a quien no tiene user:manage al crear una cuenta', async () => {
      const recepcion = await signIn(
        RECEPCION_EMAIL,
        'RECEPCION',
        RECEPCION_CEDULA,
      );

      const response = await post(
        '/users',
        { email: 'x@clinica.ec', firstName: 'A', lastName: 'B' },
        recepcion,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('AU-020 rechaza a quien no tiene user:read al listar las cuentas', async () => {
      // La lista lleva el nombre y el correo institucional de toda la
      // plantilla: no es algo que un permiso clínico deba implicar.
      const recepcion = await signIn(
        RECEPCION_EMAIL,
        'RECEPCION',
        RECEPCION_CEDULA,
      );

      const response = await get('/users', recepcion).expect(403);
      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('AU-033 el listado bajo user:read lleva la cédula, y el permiso lo dice', async () => {
      /**
       * Los roles son DATO (AU-030): una clínica inventa «TALENTO HUMANO»,
       * marca las casillas que reconoce y se queda con el resultado. Lo único
       * que lee antes de marcar es la descripción del permiso, así que una que
       * omita el documento de identidad de toda la plantilla no es un problema
       * de redacción: es una concesión desinformada.
       *
       * Las dos mitades se afirman JUNTAS a propósito. Quien quite `cedula` del
       * listado tendrá que suavizar la frase, y quien suavice la frase tendrá
       * que quitar el campo primero.
       */
      await createAccount({ cedula: '1713175071' });

      const listed = await get('/users').expect(200);
      const carries = (listed.body as { items: AccountBody[] }).items.some(
        (item) => item.cedula === '1713175071',
      );

      const catalogue = await get('/permissions').expect(200);
      const description = (
        catalogue.body as { items: { code: string; description: string }[] }
      ).items.find((item) => item.code === 'user:read')?.description;

      expect(carries).toBe(true);
      expect(description).toMatch(/cédula/i);
    });

    it('AU-030 rechaza a quien no tiene user:manage al tocar los roles', async () => {
      const recepcion = await signIn(
        RECEPCION_EMAIL,
        'RECEPCION',
        RECEPCION_CEDULA,
      );
      const role = await createRole();

      await post('/roles', { code: 'INVENTADO', name: 'X' }, recepcion).expect(403); // prettier-ignore
      await put(
        `/roles/${role.id}/permissions`,
        { permissions: ['audit:read'] },
        recepcion,
      ).expect(403);
    });
  });

  /**
   * A4 — recuperar el segundo factor (AU-035, AU-036, REQ-154, D-014).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ ESTO NO PUEDE PROBARSE CON DOBLES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Lo que AU-035 promete es una AUSENCIA en la base: el secreto TOTP, los
   * códigos de respaldo y los refrescos vivos de esa cuenta dejan de estar. Un
   * doble que contesta «hecho» demuestra que el doble contesta. Y la promesa
   * añadida —que las tres desaparecen en la MISMA operación— sólo es
   * observable si hay una transacción de verdad detrás: una cuenta con el
   * secreto borrado y diez códigos vivos es un segundo factor a medias que
   * nadie puede usar y que la pantalla presenta como retirado.
   *
   * El segundo factor se matricula recorriendo las rutas REALES, con el TOTP
   * calculado desde el `uri` que devuelve la matrícula —lo que haría la
   * aplicación del teléfono al leer el QR—. Insertar las filas a mano probaría
   * la inserción.
   */
  describe('el reinicio del segundo factor', () => {
    const SOPORTE_EMAIL = 'soporte@clinica.ec';
    const SOPORTE_CEDULA = '1713175071';
    const MEDICO_EMAIL = 'medico.sin.telefono@clinica.ec';

    interface Operator {
      token: string;
      userId: string;
    }

    /**
     * Una cuenta que puede reiniciar segundos factores Y NADA MÁS.
     *
     * El rol se crea aquí porque NINGÚN rol de fábrica lleva este permiso
     * (AU-035, D-014) — que es justo lo que afirma
     * `authorisation-data.spec.ts`—. Que la clínica tenga que concederlo a
     * mano es el requisito, así que la prueba lo concede a mano.
     */
    async function signInWithResetPermission(): Promise<Operator> {
      await prisma.role.create({
        data: {
          code: 'SOPORTE',
          name: 'Soporte técnico',
          permissions: { create: [{ permissionCode: 'user:reset-mfa' }] },
        },
      });
      // La caché de rol→permiso se indexa por id; sin esto el rol recién
      // creado no concede nada durante su TTL.
      registry.invalidate();

      const operatorToken = await signIn(
        SOPORTE_EMAIL,
        'SOPORTE',
        SOPORTE_CEDULA,
      );
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: SOPORTE_EMAIL },
      });

      return { token: operatorToken, userId: user.id };
    }

    interface EnrolledDoctor {
      userId: string;
      /** La cookie de refresco de una sesión abierta. */
      cookies: string[];
      /**
       * El token de acceso de esa sesión, YA con el segundo factor superado.
       *
       * Se devuelve porque AU-036 habla de «sesiones abiertas» y una sesión
       * abierta son dos cosas: la cookie de refresco y este token. Sin él, la
       * prueba sólo alcanzaría la mitad que caduca sola.
       */
      accessToken: string;
      backupCodes: string[];
    }

    /** Una cuenta con el segundo factor matriculado y una sesión abierta. */
    async function enrolledDoctor(): Promise<EnrolledDoctor> {
      const user = await prisma.user.create({
        data: {
          email: MEDICO_EMAIL,
          firstName: 'Ana',
          lastName: 'Villacís',
          passwordHash: await hash(),
        },
      });

      const signedIn = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: MEDICO_EMAIL, password: PASSWORD })
        .expect(200);
      const cookies = signedIn.get('Set-Cookie');
      expect(cookies, 'el inicio de sesión debe fijar la cookie').toBeDefined();
      const accessToken = (signedIn.body as { accessToken: string })
        .accessToken;

      const enrolment = (
        await request(app.getHttpServer())
          .post('/api/v1/auth/mfa/enroll')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200)
      ).body as { uri: string };

      const confirmation = (
        await request(app.getHttpServer())
          .post('/api/v1/auth/mfa/confirm')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ code: URI.parse(enrolment.uri).generate() })
          .expect(200)
      ).body as { backupCodes: string[] };

      return { userId: user.id, cookies: cookies!, accessToken, backupCodes: confirmation.backupCodes }; // prettier-ignore
    }

    const resetMfa = (userId: string, auth: string) =>
      post(`/users/${userId}/reset-mfa`, {}, auth);

    it('AU-035 borra el secreto, la marca de matrícula, el último paso y los códigos de respaldo', async () => {
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      // ANTES: si esto no se afirma, la prueba pasaría con una cuenta que
      // nunca tuvo segundo factor y no demostraría nada.
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { mfaSecretEncrypted: true, mfaEnabledAt: true },
      });
      expect(before.mfaSecretEncrypted).not.toBeNull();
      expect(before.mfaEnabledAt).not.toBeNull();
      expect(doctor.backupCodes.length).toBeGreaterThan(0);
      expect(
        await prisma.backupCode.count({ where: { userId: doctor.userId } }),
      ).toBe(doctor.backupCodes.length);

      const response = await resetMfa(doctor.userId, operator.token).expect(
        200,
      );
      expect((response.body as AccountBody & { mfaEnabled: boolean }).mfaEnabled).toBe(false); // prettier-ignore

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: {
          mfaSecretEncrypted: true,
          mfaEnabledAt: true,
          mfaLastStep: true,
        },
      });
      expect(after.mfaSecretEncrypted).toBeNull();
      expect(after.mfaEnabledAt).toBeNull();
      // El último paso consumido también: dejarlo obligaría a la próxima
      // matrícula a esperar a que el reloj lo superase.
      expect(after.mfaLastStep).toBeNull();
      expect(
        await prisma.backupCode.count({ where: { userId: doctor.userId } }),
      ).toBe(0);
    });

    it('AU-035 no deja la cuenta a medias: o desaparecen el secreto y los códigos, o ninguno', async () => {
      // La atomicidad, afirmada sobre el estado resultante: no existe ningún
      // instante observable con el secreto retirado y códigos vivos, ni al
      // revés. Con dos escrituras sueltas, un fallo entre ellas deja
      // exactamente una de esas dos mitades.
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      await resetMfa(doctor.userId, operator.token).expect(200);

      const [account, codes] = await Promise.all([
        prisma.user.findUniqueOrThrow({
          where: { id: doctor.userId },
          select: { mfaSecretEncrypted: true },
        }),
        prisma.backupCode.count({ where: { userId: doctor.userId } }),
      ]);

      const secretGone = account.mfaSecretEncrypted === null;
      const codesGone = codes === 0;
      expect(
        secretGone === codesGone,
        'el secreto y los códigos tienen que irse juntos',
      ).toBe(true);
      expect(secretGone).toBe(true);
    });

    it('AU-036 invalida las sesiones abiertas de esa cuenta, con un motivo propio', async () => {
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      // La sesión funciona ANTES del reinicio: sin esto la prueba pasaría
      // vacíamente.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', doctor.cookies)
        .expect(200);

      await resetMfa(doctor.userId, operator.token).expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', doctor.cookies)
        .expect(401);

      const tokens = await prisma.refreshToken.findMany({
        where: { userId: doctor.userId },
        select: { revokedAt: true, revocationReason: true },
      });
      expect(tokens.every((row) => row.revokedAt !== null)).toBe(true);
      // Un motivo propio y no `ACCOUNT_DEACTIVATED`: en una auditoría, «se le
      // retiró el acceso» y «se le retiró el segundo factor» son dos hechos
      // distintos y sólo uno de los dos ocurrió.
      expect(tokens.some((row) => row.revocationReason === 'MFA_RESET')).toBe(
        true,
      );
    });

    it('AU-036 deja sin valor el token de acceso emitido ANTES del reinicio', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * LA CARRERA POR LA PROPIEDAD DEL SEGUNDO FACTOR.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Revocar sólo los refrescos dejaba vivo el token de acceso —quince
       * minutos por defecto— y `mfa/enroll` y `mfa/confirm` llevan
       * `@MfaFlowOnly()`, que por diseño NO comprueba permiso. Quien tuviera la
       * sesión anterior podía matricular SU autenticador en la cuenta que
       * soporte acababa de devolverle a la doctora, y llevarse además el lote
       * de códigos de respaldo.
       *
       * Es la ventana más grave precisamente porque el reinicio deja la cuenta
       * sin matricular a propósito: no hay factor viejo que estorbe.
       */
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      // El token ALCANZA la ruta antes del reinicio; sin esto la prueba pasaría
      // vacíamente con un token que nunca sirvió. El 409 es de la matrícula ya
      // hecha, no del token: la petición pasó los dos guardias.
      const before = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${doctor.accessToken}`)
        .expect(409);
      expect((before.body as Problem).code).toBe('MFA_ALREADY_ENROLLED');

      await resetMfa(doctor.userId, operator.token).expect(200);

      const enrolment = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${doctor.accessToken}`)
        .expect(401);
      expect((enrolment.body as Problem).code).toBe('SESSION_REVOKED');
      // Y la frase dice QUÉ HACER. «No autenticado» a secas manda a la doctora
      // a soporte otra vez, que es de donde acaba de salir.
      expect((enrolment.body as Problem).title).toMatch(/vuelva a iniciar sesión/i); // prettier-ignore

      const confirmation = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/confirm')
        .set('Authorization', `Bearer ${doctor.accessToken}`)
        .send({ code: '000000' })
        .expect(401);
      expect((confirmation.body as Problem).code).toBe('SESSION_REVOKED');

      // Y la cuenta sigue esperando a su dueña: sin segundo factor y sin lote
      // de respaldo en manos de nadie.
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { mfaEnabledAt: true, mfaPendingSecretEncrypted: true },
      });
      expect(after.mfaEnabledAt).toBeNull();
      expect(after.mfaPendingSecretEncrypted).toBeNull();
      expect(
        await prisma.backupCode.count({ where: { userId: doctor.userId } }),
      ).toBe(0);
    });

    it('AU-036 no toca las sesiones de las demás cuentas', async () => {
      // La otra mitad del mismo arreglo: comprobar la familia en cada petición
      // no puede convertir el reinicio de una cuenta en el cierre de sesión de
      // quien lo pidió, ni de nadie más.
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      await resetMfa(doctor.userId, operator.token).expect(200);

      // El operador sigue trabajando con el mismo token.
      await resetMfa(doctor.userId, operator.token).expect(200);
    });

    it('AU-035 no toca la contraseña: quien reinicia no conoce ninguna credencial', async () => {
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      const before = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { passwordHash: true },
      });

      await resetMfa(doctor.userId, operator.token).expect(200);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { passwordHash: true },
      });
      expect(after.passwordHash).toBe(before.passwordHash);

      // Y la persona sigue necesitando la suya para entrar. Ahora sin reto de
      // segundo factor, que es lo que le permite volver a matricularlo.
      const session = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: MEDICO_EMAIL, password: PASSWORD })
        .expect(200);
      expect((session.body as { mfaRequired?: true }).mfaRequired).toBeUndefined(); // prettier-ignore
    });

    it('AU-035 deja a la persona volver a matricular su segundo factor', async () => {
      // La prueba independiente de la entrega A4, de extremo a extremo.
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      await resetMfa(doctor.userId, operator.token).expect(200);

      const accessToken = (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: MEDICO_EMAIL, password: PASSWORD })
          .expect(200)
      ).body as { accessToken: string };

      const enrolment = (
        await request(app.getHttpServer())
          .post('/api/v1/auth/mfa/enroll')
          .set('Authorization', `Bearer ${accessToken.accessToken}`)
          .expect(200)
      ).body as { uri: string };

      const confirmation = (
        await request(app.getHttpServer())
          .post('/api/v1/auth/mfa/confirm')
          .set('Authorization', `Bearer ${accessToken.accessToken}`)
          .send({ code: URI.parse(enrolment.uri).generate() })
          .expect(200)
      ).body as { backupCodes: string[] };

      expect(confirmation.backupCodes.length).toBeGreaterThan(0);
      // Un lote NUEVO: los códigos anteriores no vuelven.
      expect(confirmation.backupCodes).not.toEqual(doctor.backupCodes);
    });

    it('AU-035 registra el reinicio en la bitácora con autor, sujeto e instante', async () => {
      // No es decoración: este permiso permite apropiarse de una cuenta ajena
      // —quien retira el segundo factor de un médico y además puede invitarle
      // de nuevo puede firmar en su nombre—, y la bitácora es lo único que lo
      // hace rastreable (REQ-110).
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      await resetMfa(doctor.userId, operator.token).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'auth', action: 'MFA_RESET' },
        select: {
          userId: true,
          resourceId: true,
          occurredAt: true,
          action: true,
        },
      });

      expect(trail).toHaveLength(1);
      expect(trail[0]?.userId).toBe(operator.userId);
      expect(trail[0]?.resourceId).toBe(doctor.userId);
      expect(trail[0]?.occurredAt).toBeInstanceOf(Date);
      // UN VERBO PROPIO Y NO `UPDATE`: renombrar una cuenta escribe también un
      // `UPDATE` sobre `auth`, así que con el verbo genérico la pregunta «¿a
      // quién le han reiniciado el segundo factor?» no tiene respuesta.
      expect(trail[0]?.action).toBe('MFA_RESET');
    });

    it('AU-035 no aplica el reinicio si la entrada de bitácora no se puede escribir', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * ESTE ACTO FALLA CERRADO, Y ES LA ÚNICA EXCEPCIÓN DEL MÓDULO.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `PrismaAccessAuditRecorder` se traga cualquier fallo a propósito, y
       * está bien: negarle una historia clínica a un médico porque la tabla de
       * bitácora tosió es el peor de los dos fallos. Su propio comentario ya
       * nombraba la excepción —lo que hay que registrar para poder hacerlo—, y
       * `MFA_RESET` es exactamente eso: AU-035 dice que la entrada NO es
       * contabilidad, es el requisito, y es lo único que hace defendible
       * conceder el permiso ante la SPDP.
       *
       * Con la escritura anterior —transacción primero, bitácora después y
       * fuera de ella— un `INSERT` fallido dejaba al médico sin segundo factor,
       * sin sesiones, sin nadie a quien atribuirlo… y con un 200 en pantalla.
       *
       * SE ROMPE LA BASE, NO UN DOBLE. El trigger es lo único que reproduce el
       * fallo de verdad: un doble que lanza demostraría que el doble lanza, y
       * no que las dos escrituras comparten transacción.
       */
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_refuse_mfa_reset_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'MFA_RESET' THEN
            -- 53100 disk_full: un fallo de INFRAESTRUCTURA, que es el
            -- escenario. Un RAISE desnudo saldría como P0001 y el mapeo lo
            -- degrada a 422 «regla de integridad», que diría que el reinicio
            -- se rechazó por una regla de negocio. Aquí no hay ninguna regla:
            -- la tabla no está disponible.
            RAISE EXCEPTION 'access_audit unreachable' USING ERRCODE = '53100';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER trg_test_refuse_mfa_reset_audit
        BEFORE INSERT ON access_audit
        FOR EACH ROW EXECUTE FUNCTION test_refuse_mfa_reset_audit()
      `);

      try {
        await resetMfa(doctor.userId, operator.token).expect(500);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS trg_test_refuse_mfa_reset_audit ON access_audit',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS test_refuse_mfa_reset_audit()',
        );
      }

      // NADA se aplicó. Ni el factor, ni los códigos, ni las sesiones.
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { mfaSecretEncrypted: true, mfaEnabledAt: true },
      });
      expect(after.mfaSecretEncrypted).not.toBeNull();
      expect(after.mfaEnabledAt).not.toBeNull();
      expect(
        await prisma.backupCode.count({ where: { userId: doctor.userId } }),
      ).toBe(doctor.backupCodes.length);

      const sessions = await prisma.refreshToken.findMany({
        where: { userId: doctor.userId },
        select: { revokedAt: true },
      });
      expect(sessions.some((row) => row.revokedAt === null)).toBe(true);

      // Y la sesión de la doctora sigue abierta de verdad, no sólo en la fila.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', doctor.cookies)
        .expect(200);
    });

    it('AU-035 nunca escribe una credencial en la bitácora', async () => {
      const operator = await signInWithResetPermission();
      const doctor = await enrolledDoctor();

      const secret = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { mfaSecretEncrypted: true },
      });

      await resetMfa(doctor.userId, operator.token).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'auth' },
      });
      const written = JSON.stringify(trail);

      expect(written).not.toContain(secret.mfaSecretEncrypted);
      for (const code of doctor.backupCodes) {
        expect(written).not.toContain(code);
      }
    });

    it('AU-035 exige user:reset-mfa: administrar usuarios no alcanza', async () => {
      // El permiso existe SEPARADO de `user:manage` justo por esto (D-014).
      // Si `user:manage` bastara, el permiso sería decorativo y el rol de
      // administración podría apropiarse de la cuenta de cualquier médico.
      const doctor = await enrolledDoctor();

      const refused = await resetMfa(doctor.userId, token).expect(403);
      expect((refused.body as Problem).code).toBe('PERMISSION_DENIED');

      // Y no ocurrió nada: el rechazo es anterior a cualquier escritura.
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: doctor.userId },
        select: { mfaEnabledAt: true },
      });
      expect(after.mfaEnabledAt).not.toBeNull();
    });

    it('AU-035 responde 404 sobre una cuenta que no existe', async () => {
      const operator = await signInWithResetPermission();

      const missing = await resetMfa(
        '00000000-0000-4000-8000-000000000000',
        operator.token,
      ).expect(404);

      expect((missing.body as Problem).code).toBe('USER_NOT_FOUND');
    });

    it('AU-035 impide reiniciarse el propio segundo factor', async () => {
      const operator = await signInWithResetPermission();

      const refused = await resetMfa(operator.userId, operator.token).expect(422); // prettier-ignore

      expect((refused.body as Problem).code).toBe('CANNOT_RESET_OWN_MFA');
      expect((refused.body as Problem).title).toMatch(/otra persona/i);
    });

    it('AU-035 acepta sin error una cuenta que no tenía segundo factor', async () => {
      // Idempotente a propósito: lo que se pide es un estado, y ya se cumple.
      const operator = await signInWithResetPermission();
      const account = await createAccount();

      const response = await resetMfa(account.id, operator.token).expect(200);

      expect(
        (response.body as AccountBody & { mfaEnabled: boolean }).mfaEnabled,
      ).toBe(false);
      // Y sigue siendo idempotente la segunda vez.
      await resetMfa(account.id, operator.token).expect(200);
    });
  });
});
