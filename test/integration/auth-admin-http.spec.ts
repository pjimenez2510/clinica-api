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

import { useDatabase } from './setup/database';

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

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
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
      await app.init();
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', ADMIN_CEDULA);
  });

  afterAll(async () => {
    await app?.close();
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
    if (roleCode === 'ADMIN') adminUserId = user.id;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    // GLOBAL grant (siteId null): administering the clinic is not scoped to
    // one of its sites, and this is how a director is hired.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
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
      // ⚠️ D-013 sigue sin contestarse — cómo llega la primera credencial a la
      // persona es una decisión de política, no de código. Lo que AU-021 sí
      // fija es que el administrador NO elige la contraseña de nadie, y esto
      // es lo que lo hace comprobable: la cuenta existe y no entra.
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
      });

      expect(trail).toEqual([
        { action: 'CREATE', resourceId: created.id, userId: adminUserId },
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
        data: { mspUnicode: 'AUTH-0001', name: 'Sede Norte' },
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
});
