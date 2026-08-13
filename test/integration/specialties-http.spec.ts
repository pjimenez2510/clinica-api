import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';

/**
 * The specialties module (C1) as the browser consumes it, against a real
 * PostgreSQL 18: what these prove that the unit suites cannot is that the
 * guarantees actually live in the base — the accent-insensitive uniqueness
 * (SP-006, SP-026), the duration CHECK (SP-021), the at-most-one-primary
 * partial index (SP-005), the RESTRICT that answers SPECIALTY_IN_USE
 * (SP-003) — and that every refusal reaches HTTP with the code the SPEC
 * fixes, under the permissions of D-002.
 */
const PASSWORD = 'el caballo come alfalfa';
const ADMIN_EMAIL = 'gerencia@clinica.ec';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

describe('las especialidades por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let adminUserId: string;
  let practitionerId: string;

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

    await seed();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seed(): Promise<void> {
    const practitioner = await createPractitioner(prisma);
    practitionerId = practitioner.id;

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates
    // the roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', '1710034065');
  }

  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'RECEPCION',
    cedula: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        // Synthetic cedula with a computed check digit; never a real one.
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    if (roleCode === 'ADMIN') adminUserId = user.id;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    // GLOBAL grant (siteId null): the specialty catalogue is clinic-wide, and this
    // is how an administrator is hired.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const post = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .post(`/api/v1/specialties${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/specialties${path}`)
      .set('Authorization', `Bearer ${token}`);

  const patch = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/api/v1/specialties${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const put = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .put(`/api/v1/specialties${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const destroy = (path: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1/specialties${path}`)
      .set('Authorization', `Bearer ${token}`);

  async function createSpecialty(
    code = 'cardiologia',
    name = 'Cardiología',
  ): Promise<{ id: string }> {
    const response = await post('', { code, name }).expect(201);
    return response.body as { id: string };
  }

  async function createServiceType(
    specialtyId: string,
    name = 'Control',
    durationMinutes = 20,
  ): Promise<{ id: string }> {
    const response = await post(`/${specialtyId}/service-types`, {
      name,
      durationMinutes,
    }).expect(201);
    return response.body as { id: string };
  }

  describe('especialidades', () => {
    it('SP-002 crea una especialidad y deja constancia en la bitácora con autor e instante', async () => {
      const specialty = await createSpecialty();

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        userId: adminUserId,
        resourceId: specialty.id,
        action: 'CREATE',
      });
      expect(trail[0]!.occurredAt).toBeInstanceOf(Date);
    });

    it('SP-002 exige el permiso de administración: RECEPCION recibe 403', async () => {
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '0926687856'); // prettier-ignore

      const response = await post(
        '',
        { code: 'pediatria', name: 'Pediatría' },
        recepcion,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('SP-006 rechaza con SPECIALTY_DUPLICATE un nombre que solo difiere en acentos y mayúsculas', async () => {
      await createSpecialty('pediatria', 'Pediatría');

      const response = await post('', {
        code: 'pediatria-2',
        name: 'PEDIATRIA',
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SPECIALTY_DUPLICATE');
      expect(problem.errors?.[0]?.field).toBe('name');
    });

    it('SP-006 rechaza con SPECIALTY_DUPLICATE un código repetido sin importar la caja', async () => {
      await createSpecialty('cardiologia', 'Cardiología');

      const response = await post('', {
        code: 'CARDIOLOGIA',
        name: 'Otra cardiología',
      }).expect(409);

      expect((response.body as Problem).code).toBe('SPECIALTY_DUPLICATE');
      expect((response.body as Problem).errors?.[0]?.field).toBe('code');
    });

    it('SP-003 rechaza borrar una especialidad referenciada con SPECIALTY_IN_USE y ofrece desactivarla', async () => {
      const specialty = await createSpecialty();
      await createServiceType(specialty.id);

      const response = await destroy(`/${specialty.id}`).expect(409); // prettier-ignore

      const problem = response.body as Problem;
      expect(problem.code).toBe('SPECIALTY_IN_USE');
      // The other half of the requirement: the refusal offers deactivation.
      expect(problem.title).toContain('desactivarla');
      // And the row survived.
      const kept = await prisma.specialty.findUnique({
        where: { id: specialty.id },
      });
      expect(kept).not.toBeNull();
    });

    it('SP-003 borra una especialidad sin referencias y deja bitácora', async () => {
      const specialty = await createSpecialty();

      await destroy(`/${specialty.id}`).expect(204);

      expect(
        await prisma.specialty.findUnique({ where: { id: specialty.id } }),
      ).toBeNull();
      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration', resourceId: specialty.id },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    });

    it('SP-004/SP-007 una desactivada sale del listado por defecto y aparece con includeInactive', async () => {
      const specialty = await createSpecialty();
      await patch(`/${specialty.id}`, { active: false }).expect(200); // prettier-ignore

      const byDefault = await get('').expect(200);
      const everything = await get('?includeInactive=true').expect(200); // prettier-ignore

      const defaultIds = (byDefault.body as { items: { id: string }[] }).items.map((item) => item.id); // prettier-ignore
      const allIds = (everything.body as { items: { id: string }[] }).items.map((item) => item.id); // prettier-ignore
      expect(defaultIds).not.toContain(specialty.id);
      expect(allIds).toContain(specialty.id);
    });
  });

  describe('especialidades por profesional', () => {
    it('SP-005 rechaza con PRIMARY_SPECIALTY_REQUIRED una asignación con dos principales', async () => {
      const first = await createSpecialty('cardiologia', 'Cardiología');
      const second = await createSpecialty('pediatria', 'Pediatría');

      const response = await put(
        `/practitioners/${practitionerId}/specialties`,
        {
          items: [
            { specialtyId: first.id, isPrimary: true },
            { specialtyId: second.id, isPrimary: true },
          ],
        },
      ).expect(422);

      expect((response.body as Problem).code).toBe('PRIMARY_SPECIALTY_REQUIRED'); // prettier-ignore
    });

    it('SP-005 la base admite a lo sumo una principal: el índice parcial rechaza la segunda', async () => {
      const first = await createSpecialty('cardiologia', 'Cardiología');
      const second = await createSpecialty('pediatria', 'Pediatría');

      await prisma.practitionerSpecialty.create({
        data: { practitionerId, specialtyId: first.id, isPrimary: true },
      });
      // Straight into the table, dodging service and DTO: only
      // `practitioner_specialty_one_primary` can refuse this one.
      await expect(
        prisma.practitionerSpecialty.create({
          data: { practitionerId, specialtyId: second.id, isPrimary: true },
        }),
      ).rejects.toThrowError(/practitioner_specialty_one_primary|Unique/i);
    });

    it('SP-008 expone la especialidad principal del profesional, la principal primero', async () => {
      const cardio = await createSpecialty('cardiologia', 'Cardiología');
      const pedia = await createSpecialty('pediatria', 'Pediatría');

      await put(`/practitioners/${practitionerId}/specialties`, {
        items: [
          { specialtyId: pedia.id, isPrimary: false },
          { specialtyId: cardio.id, isPrimary: true },
        ],
      }).expect(200);

      const response = await get(
        `/practitioners/${practitionerId}/specialties`,
      ).expect(200);
      const items = (
        response.body as {
          items: { specialtyId: string; isPrimary: boolean }[];
        }
      ).items;

      expect(items[0]).toMatchObject({ specialtyId: cardio.id, isPrimary: true }); // prettier-ignore
      expect(items.filter((item) => item.isPrimary)).toHaveLength(1);
    });

    it('SP-004 rechaza con SPECIALTY_INACTIVE asignar una especialidad desactivada', async () => {
      const specialty = await createSpecialty();
      await patch(`/${specialty.id}`, { active: false }).expect(200); // prettier-ignore

      const response = await put(
        `/practitioners/${practitionerId}/specialties`,
        { items: [{ specialtyId: specialty.id, isPrimary: true }] },
      ).expect(422);

      expect((response.body as Problem).code).toBe('SPECIALTY_INACTIVE');
    });

    it('SP-004 conserva intactas las referencias existentes al desactivar', async () => {
      const specialty = await createSpecialty();
      await put(`/practitioners/${practitionerId}/specialties`, {
        items: [{ specialtyId: specialty.id, isPrimary: true }],
      }).expect(200);

      await patch(`/${specialty.id}`, { active: false }).expect(200); // prettier-ignore

      const response = await get(
        `/practitioners/${practitionerId}/specialties`,
      ).expect(200);
      const items = (
        response.body as {
          items: { specialtyId: string; active: boolean }[];
        }
      ).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ specialtyId: specialty.id, active: false }); // prettier-ignore
    });
  });

  describe('tipos de atención y duraciones', () => {
    it('SP-020 crea un tipo de atención con duración base y lo lista por especialidad', async () => {
      const specialty = await createSpecialty();
      await createServiceType(specialty.id, 'Primera vez', 30);

      const response = await get(`/${specialty.id}/service-types`).expect(200);
      const items = (
        response.body as {
          items: { name: string; durationMinutes: number }[];
        }
      ).items;
      expect(items).toEqual([
        expect.objectContaining({ name: 'Primera vez', durationMinutes: 30 }),
      ]);
    });

    it('SP-021 la base rechaza 37 y 250 minutos: el CHECK es la garantía, no el Zod', async () => {
      const specialty = await createSpecialty();

      for (const minutes of [37, 250]) {
        // Straight SQL, dodging the DTO on purpose: a psql at two in the
        // morning is exactly what the CHECK exists for.
        await expect(
          prisma.$executeRaw`
            INSERT INTO service_type (specialty_id, name, duration_minutes)
            VALUES (${specialty.id}::uuid, ${'Fuera de rango ' + String(minutes)}, ${minutes})
          `,
        ).rejects.toThrowError(/service_type_duration_range/);
      }
    });

    it('SP-021 el espejo de la validación responde por campo antes de llegar a la base', async () => {
      const specialty = await createSpecialty();

      const response = await post(`/${specialty.id}/service-types`, {
        name: 'Control',
        durationMinutes: 37,
      }).expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('durationMinutes'); // prettier-ignore
    });

    it('SP-026 rechaza con SERVICE_TYPE_DUPLICATE dos tipos con el mismo nombre en la especialidad', async () => {
      const specialty = await createSpecialty();
      await createServiceType(specialty.id, 'Control', 20);

      const response = await post(`/${specialty.id}/service-types`, {
        name: 'CONTROL',
        durationMinutes: 30,
      }).expect(409);

      expect((response.body as Problem).code).toBe('SERVICE_TYPE_DUPLICATE');
    });

    it('SP-025 un tipo sin citas que lo referencien sí se borra; sus excepciones mueren con él', async () => {
      const specialty = await createSpecialty();
      const type = await createServiceType(specialty.id);
      await put(`/practitioners/${practitionerId}/specialties`, {
        items: [{ specialtyId: specialty.id, isPrimary: true }],
      }).expect(200);
      await put(
        `/practitioners/${practitionerId}/duration-exceptions/${type.id}`,
        { durationMinutes: 45 },
      ).expect(204);

      await destroy(`/service-types/${type.id}`).expect(204);

      // The exception CASCADEd by design: a personal override of a type that
      // no longer exists means nothing. SERVICE_TYPE_IN_USE stays armed for
      // the day agenda entries reference the type (C4).
      expect(
        await prisma.durationException.count({
          where: { serviceTypeId: type.id },
        }),
      ).toBe(0);
    });

    it('SP-027 toda mutación de tipos y duraciones queda en la bitácora con autor', async () => {
      const specialty = await createSpecialty();
      const type = await createServiceType(specialty.id);
      await patch(`/service-types/${type.id}`, { durationMinutes: 25 }).expect(200); // prettier-ignore

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration' },
        orderBy: { id: 'asc' },
      });

      expect(trail.map((row) => row.action)).toEqual([
        'CREATE', // the specialty
        'CREATE', // the service type
        'UPDATE', // the duration change
      ]);
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
    });

    it('SP-024 cambiar una duración no toca ninguna cita ya reservada', async () => {
      const site = await createSite(prisma);
      await linkPractitionerToSite(prisma, practitionerId, site.id);
      const patient = await createPatient(prisma);
      const specialty = await createSpecialty();
      const type = await createServiceType(specialty.id, 'Control', 20);

      const booked = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId,
          patientId: patient.id,
          startsAt: new Date('2026-09-14T13:00:00Z'),
          endsAt: new Date('2026-09-14T13:20:00Z'),
          bookingChannel: 'PHONE',
        },
      });

      await patch(`/service-types/${type.id}`, { durationMinutes: 45 }).expect(200); // prettier-ignore

      // Row count AND content: the appointment neither disappeared nor moved.
      const entries = await prisma.agendaEntry.findMany();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: booked.id,
        startsAt: booked.startsAt,
        endsAt: booked.endsAt,
        updatedAt: booked.updatedAt,
      });
    });

    it('SP-022 fija y retira una excepción de duración por médico', async () => {
      const specialty = await createSpecialty();
      const type = await createServiceType(specialty.id, 'Control', 20);
      await put(`/practitioners/${practitionerId}/specialties`, {
        items: [{ specialtyId: specialty.id, isPrimary: true }],
      }).expect(200);

      await put(
        `/practitioners/${practitionerId}/duration-exceptions/${type.id}`,
        { durationMinutes: 45 },
      ).expect(204);
      expect(
        await prisma.durationException.count({ where: { practitionerId } }),
      ).toBe(1);

      await destroy(
        `/practitioners/${practitionerId}/duration-exceptions/${type.id}`,
      ).expect(204);
      expect(
        await prisma.durationException.count({ where: { practitionerId } }),
      ).toBe(0);
    });

    it('SP-023/SP-028 resuelve excepción → base y la expone como resolvedMinutes', async () => {
      const specialty = await createSpecialty();
      const control = await createServiceType(specialty.id, 'Control', 20);
      const primera = await createServiceType(specialty.id, 'Primera vez', 30);
      await put(`/practitioners/${practitionerId}/specialties`, {
        items: [{ specialtyId: specialty.id, isPrimary: true }],
      }).expect(200);
      await put(
        `/practitioners/${practitionerId}/duration-exceptions/${control.id}`,
        { durationMinutes: 45 },
      ).expect(204);

      const response = await get(
        `/practitioners/${practitionerId}/duration-exceptions`,
      ).expect(200);
      const items = (
        response.body as {
          items: {
            serviceTypeId: string;
            baseMinutes: number;
            exceptionMinutes: number | null;
            resolvedMinutes: number;
          }[];
        }
      ).items;

      const withException = items.find((i) => i.serviceTypeId === control.id);
      const withoutException = items.find((i) => i.serviceTypeId === primera.id); // prettier-ignore
      // With an exception the practitioner's own minutes rule (SP-023 level 1)…
      expect(withException).toMatchObject({
        baseMinutes: 20,
        exceptionMinutes: 45,
        resolvedMinutes: 45,
      });
      // …and without one the base of the specialty·type rules (level 2).
      expect(withoutException).toMatchObject({
        baseMinutes: 30,
        exceptionMinutes: null,
        resolvedMinutes: 30,
      });
    });
  });

  describe('la semilla del catálogo (SP-001, D-008)', () => {
    it('SP-001 precarga las especialidades del MSP y es idempotente: dos pasadas, el mismo catálogo', async () => {
      const first = await seedSpecialties(prisma);
      expect(first.specialtiesCreated).toBeGreaterThan(15);

      const specialtiesAfterFirst = await prisma.specialty.count();
      const typesAfterFirst = await prisma.serviceType.count();
      // Two default service types per specialty (SP-020).
      expect(typesAfterFirst).toBe(specialtiesAfterFirst * 2);

      const second = await seedSpecialties(prisma);
      expect(second.specialtiesCreated).toBe(0);
      expect(second.serviceTypesCreated).toBe(0);
      expect(await prisma.specialty.count()).toBe(specialtiesAfterFirst);
      expect(await prisma.serviceType.count()).toBe(typesAfterFirst);

      // Spot check D-008: the general practice every clinic starts from.
      const general = await prisma.specialty.findFirst({
        where: { code: 'medicina-general' },
      });
      expect(general).toMatchObject({ name: 'Medicina General', active: true });
    });
  });
});
