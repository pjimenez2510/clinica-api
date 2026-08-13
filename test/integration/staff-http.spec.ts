import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type PractitionerScheduleRule, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { seedStaff } from '../../prisma/seed-staff.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import { withSerialisationRetry } from '../../src/shared/infrastructure/prisma/serialisation-retry';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import '../../src/modules/staff/infrastructure/staff.constraints';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';

/**
 * The staff module (S1 and S2) as the browser consumes it, against a real
 * PostgreSQL 18.
 *
 * WHAT THESE PROVE THAT THE UNIT SUITES CANNOT: that the guarantees live in
 * the base. The headline one is ST-042 — `schedule_rule_no_overlap`, exercised
 * by two CONCURRENT writers with exactly one winner, because a sequential
 * insert-then-insert proves uniqueness and not arbitration. Alongside it: the
 * partial unique index of ST-008, the duration CHECK of ST-009, the RESTRICT
 * that makes ST-010 refuse a delete, and that every refusal reaches HTTP with
 * the code the SPEC fixes, under the permissions the module declares.
 */
const PASSWORD = 'el caballo come alfalfa';
const ADMIN_EMAIL = 'gerencia@clinica.ec';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';

/** Synthetic cedulas with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';
const RECEPCION_CEDULA = '0926687856';
const DOCTOR_CEDULA = '1713175071';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface ScheduleOutcome {
  rule: { id: string; validTo: string | null; active: boolean };
  conflicts: { agendaEntryId: string; date: string }[];
}

/** `YYYY-MM-DD` `days` away from today in Ecuador, for the ACESS windows. */
function clinicDay(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const shifted = new Date(`${today}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

describe('el personal por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let adminUserId: string;
  /** The account a clinical profile is attached to; `auth` owns it. */
  let doctorUserId: string;
  let siteId: string;

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
    doctorUserId = (
      await prisma.user.create({
        data: {
          email: 'ana.villacis@clinica.ec',
          firstName: 'Ana',
          lastName: 'Villacís',
          cedula: DOCTOR_CEDULA,
          passwordHash: 'not-a-real-hash',
        },
      })
    ).id;
    siteId = (await createSite(prisma)).id;
  });

  afterAll(async () => {
    await app?.close();
  });

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
    // GLOBAL grant (siteId null): the staff file is clinic-wide, which is what
    // the controller's `'global'` site scope says out loud.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const api = (path: string) => `/api/v1/staff${path}`;
  const get = (path: string, auth = token) =>
    request(app.getHttpServer())
      .get(api(path))
      .set('Authorization', `Bearer ${auth}`);
  const post = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .post(api(path))
      .set('Authorization', `Bearer ${auth}`)
      .send(body);
  const patch = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(api(path))
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const put = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .put(api(path))
      .set('Authorization', `Bearer ${auth}`)
      .send(body);
  const destroy = (path: string) =>
    request(app.getHttpServer())
      .delete(api(path))
      .set('Authorization', `Bearer ${token}`);

  /** A profile on the seeded account, with sites already assigned. */
  async function createPractitioner(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const response = await post('/practitioners', {
      userId: doctorUserId,
      mspCode: 'MSP-42',
      ...overrides,
    }).expect(201);
    const practitioner = response.body as { id: string };
    await put(`/practitioners/${practitioner.id}/sites`, {
      siteIds: [siteId],
    }).expect(200);
    return practitioner;
  }

  async function createSpecialty(
    code = 'cardiologia',
    name = 'Cardiología',
  ): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/specialties')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, name })
      .expect(201);
    return response.body as { id: string };
  }

  async function createServiceType(
    specialtyId: string,
    name = 'Control',
    durationMinutes = 20,
  ): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/specialties/${specialtyId}/service-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name, durationMinutes })
      .expect(201);
    return response.body as { id: string };
  }

  // --- The file ---------------------------------------------------------------

  describe('la ficha del profesional', () => {
    it('ST-001 expone la cédula del profesional desde la cuenta, sin duplicarla', async () => {
      const practitioner = await createPractitioner();

      const response = await get(`/practitioners/${practitioner.id}`).expect(200); // prettier-ignore
      expect(response.body).toMatchObject({ cedula: DOCTOR_CEDULA });

      // The column exists ONCE, on `app_user`. A copy on `practitioner` would
      // be a second answer to one question, and the SPEC warns against the
      // ADD COLUMN explicitly.
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'practitioner'
      `;
      expect(columns.map((column) => column.column_name)).not.toContain('cedula'); // prettier-ignore
      expect(columns.map((column) => column.column_name)).not.toContain('acess_registration'); // prettier-ignore
    });

    it('ST-001 la unicidad de la cédula la garantiza la base, no el servicio', async () => {
      // Straight into the table, dodging service and DTO: only
      // `app_user_cedula_key` can refuse this one.
      await expect(
        prisma.user.create({
          data: {
            email: 'otra.cuenta@clinica.ec',
            firstName: 'Otra',
            lastName: 'Cuenta',
            cedula: DOCTOR_CEDULA,
            passwordHash: 'not-a-real-hash',
          },
        }),
      ).rejects.toThrowError(/cedula|Unique/i);
    });

    it('ST-001 rechaza por campo una cédula con dígito verificador incorrecto', async () => {
      const practitioner = await createPractitioner();

      const response = await patch(`/practitioners/${practitioner.id}`, {
        cedula: '1710034066',
      }).expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('cedula');
    });

    it('ST-003 guarda el código MSP y lo expone en la ficha para cada atención', async () => {
      const practitioner = await createPractitioner({ mspCode: 'MSP-777' });

      const response = await get(`/practitioners/${practitioner.id}`).expect(200); // prettier-ignore
      expect(response.body).toMatchObject({ mspCode: 'MSP-777' });
    });

    it('ST-002 registra el ACESS con su caducidad y los devuelve juntos', async () => {
      const practitioner = await createPractitioner();

      await patch(`/practitioners/${practitioner.id}`, {
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: clinicDay(400),
      }).expect(200);

      const response = await get(`/practitioners/${practitioner.id}`).expect(200); // prettier-ignore
      expect(response.body).toMatchObject({
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: clinicDay(400),
      });
    });

    it('ST-006 marca si el profesional es agendable y lo conserva', async () => {
      const practitioner = await createPractitioner({ schedulable: false });

      const response = await get(`/practitioners/${practitioner.id}`).expect(200); // prettier-ignore
      expect(response.body).toMatchObject({ schedulable: false });
    });

    it('ST-010 desactiva en vez de borrar: sale del listado por defecto y vuelve con includeInactive', async () => {
      const practitioner = await createPractitioner();
      await patch(`/practitioners/${practitioner.id}`, { active: false }).expect(200); // prettier-ignore

      const byDefault = await get('/practitioners').expect(200);
      const everything = await get('/practitioners?includeInactive=true').expect(200); // prettier-ignore

      const ids = (body: unknown) =>
        (body as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids(byDefault.body)).not.toContain(practitioner.id);
      expect(ids(everything.body)).toContain(practitioner.id);
      // And the row is still there, with its history intact.
      expect(
        await prisma.practitioner.findUnique({
          where: { id: practitioner.id },
        }),
      ).not.toBeNull();
    });

    it('ST-010 rechaza borrar un profesional con citas y ofrece desactivarlo', async () => {
      const practitioner = await createPractitioner();
      const patient = await createPatient(prisma);
      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date('2026-09-14T13:00:00Z'),
          endsAt: new Date('2026-09-14T13:20:00Z'),
          bookingChannel: 'PHONE',
        },
      });

      const response = await destroy(`/practitioners/${practitioner.id}`).expect(409); // prettier-ignore

      const problem = response.body as Problem;
      expect(problem.code).toBe('PRACTITIONER_IN_USE');
      // The other half of the requirement: the refusal offers deactivation.
      expect(problem.title).toContain('esactív');
      // And nothing was deleted.
      expect(
        await prisma.practitioner.findUnique({
          where: { id: practitioner.id },
        }),
      ).not.toBeNull();
    });

    it('ST-010 toda mutación de la ficha queda en la bitácora con autor e instante', async () => {
      const practitioner = await createPractitioner();
      await patch(`/practitioners/${practitioner.id}`, { mspCode: 'MSP-9' }).expect(200); // prettier-ignore

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'staff' },
        orderBy: { id: 'asc' },
      });

      // CREATE (the profile), UPDATE (the sites of the fixture), UPDATE (the code).
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']); // prettier-ignore
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
      expect(trail[0]?.occurredAt).toBeInstanceOf(Date);
    });

    it('ST-010 RECEPCION no administra profesionales: recibe 403 PERMISSION_DENIED', async () => {
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', RECEPCION_CEDULA); // prettier-ignore

      const response = await post(
        '/practitioners',
        { userId: doctorUserId },
        recepcion,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('ST-001 RECEPCION tampoco LEE la ficha: la cédula y el ACESS no son de agenda', async () => {
      // Deliberate: the agenda lists bookable practitioners under its own
      // `agenda:read` route (AG-108), so nothing recepción needs is behind
      // `staff:read` — and this file carries an employee's personal data.
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', RECEPCION_CEDULA); // prettier-ignore

      const response = await get('/practitioners', recepcion).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });
  });

  // --- ACESS ------------------------------------------------------------------

  describe('la habilitación ACESS', () => {
    it('ST-004 un ACESS caducado ayer impide firmar y nombra la fecha', async () => {
      const practitioner = await createPractitioner();
      const expiredOn = clinicDay(-1);
      await patch(`/practitioners/${practitioner.id}`, {
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: expiredOn,
      }).expect(200);

      const response = await get(
        `/practitioners/${practitioner.id}/signing-eligibility`,
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('ACESS_EXPIRED');
      expect(problem.title).toContain(expiredOn);
    });

    it('ST-004 el mismo profesional con el ACESS vigente sí puede firmar', async () => {
      // The independent test the SPEC names for S1, both halves of it.
      const practitioner = await createPractitioner();
      await patch(`/practitioners/${practitioner.id}`, {
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: clinicDay(1),
      }).expect(200);

      const response = await get(
        `/practitioners/${practitioner.id}/signing-eligibility`,
      ).expect(200);

      expect(response.body).toMatchObject({ eligible: true, daysToExpiry: 1 });
    });

    it('ST-002 sin registro ACESS la comprobación responde ACESS_MISSING, no caducado', async () => {
      const practitioner = await createPractitioner();

      const response = await get(
        `/practitioners/${practitioner.id}/signing-eligibility`,
      ).expect(422);

      expect((response.body as Problem).code).toBe('ACESS_MISSING');
    });

    it('ST-004 el ACESS caducado NO impide agendar: la agenda no consulta este módulo (D-009)', async () => {
      const practitioner = await createPractitioner();
      await patch(`/practitioners/${practitioner.id}`, {
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: clinicDay(-30),
      }).expect(200);
      const patient = await createPatient(prisma);

      // Booking goes straight through: blocking the agenda for paperwork that
      // is sorted out in days is disproportionate, and REQ-041 protects the
      // signature, not the attention.
      const booked = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date('2026-09-14T14:00:00Z'),
          endsAt: new Date('2026-09-14T14:20:00Z'),
          bookingChannel: 'PHONE',
        },
      });
      expect(booked.id).toBeTruthy();
    });

    it('ST-005 lista a quien le caduca el ACESS dentro de 30 días, sin bloquearlo', async () => {
      const soon = await createPractitioner();
      await patch(`/practitioners/${soon.id}`, {
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: clinicDay(20),
      }).expect(200);

      const response = await get('/practitioners/acess-expiring').expect(200);

      const items = (
        response.body as {
          items: { practitionerId: string; daysToExpiry: number }[];
        }
      ).items;
      expect(items).toEqual([
        expect.objectContaining({ practitionerId: soon.id, daysToExpiry: 20 }),
      ]);
      // Warning only: nothing about the practitioner changed.
      expect(
        (
          await prisma.practitioner.findUniqueOrThrow({
            where: { id: soon.id },
          })
        ).active,
      ).toBe(true);
    });

    it('ST-005 deja fuera al que caduca más allá de la ventana', async () => {
      const later = await createPractitioner();
      await patch(`/practitioners/${later.id}`, {
        acessRegistration: 'ACESS-1001',
        acessExpiresOn: clinicDay(90),
      }).expect(200);

      const response = await get('/practitioners/acess-expiring').expect(200);

      expect((response.body as { items: unknown[] }).items).toEqual([]);
    });
  });

  // --- Sites, specialties, durations (the absorbed debt) ----------------------

  describe('sedes, especialidades y duraciones', () => {
    it('ST-007 registra en qué sedes atiende el profesional', async () => {
      const practitioner = await createPractitioner();

      const response = await get(`/practitioners/${practitioner.id}/sites`).expect(200); // prettier-ignore

      expect((response.body as { items: { siteId: string }[] }).items).toEqual([
        expect.objectContaining({ siteId }),
      ]);
    });

    it('ST-008 rechaza con PRIMARY_SPECIALTY_REQUIRED una asignación con dos principales', async () => {
      const practitioner = await createPractitioner();
      const first = await createSpecialty('cardiologia', 'Cardiología');
      const second = await createSpecialty('pediatria', 'Pediatría');

      const response = await put(
        `/practitioners/${practitioner.id}/specialties`,
        {
          items: [
            { specialtyId: first.id, isPrimary: true },
            { specialtyId: second.id, isPrimary: true },
          ],
        },
      ).expect(422);

      expect((response.body as Problem).code).toBe('PRIMARY_SPECIALTY_REQUIRED'); // prettier-ignore
    });

    it('ST-008 la base admite a lo sumo una principal: el índice parcial rechaza la segunda', async () => {
      const practitioner = await createPractitioner();
      const first = await createSpecialty('cardiologia', 'Cardiología');
      const second = await createSpecialty('pediatria', 'Pediatría');

      await prisma.practitionerSpecialty.create({
        data: {
          practitionerId: practitioner.id,
          specialtyId: first.id,
          isPrimary: true,
        },
      });
      // Straight into the table, dodging service and DTO: only
      // `practitioner_specialty_one_primary` can refuse this one.
      await expect(
        prisma.practitionerSpecialty.create({
          data: {
            practitionerId: practitioner.id,
            specialtyId: second.id,
            isPrimary: true,
          },
        }),
      ).rejects.toThrowError(/practitioner_specialty_one_primary|Unique/i);
    });

    it('ST-008 expone la especialidad principal en el listado que consume la agenda', async () => {
      const practitioner = await createPractitioner();
      const cardio = await createSpecialty('cardiologia', 'Cardiología');
      const pedia = await createSpecialty('pediatria', 'Pediatría');

      await put(`/practitioners/${practitioner.id}/specialties`, {
        items: [
          { specialtyId: pedia.id, isPrimary: false },
          { specialtyId: cardio.id, isPrimary: true },
        ],
      }).expect(200);

      const listing = await get('/practitioners').expect(200);
      const row = (
        listing.body as {
          items: { id: string; primarySpecialty: { id: string } | null }[];
        }
      ).items.find((item) => item.id === practitioner.id);
      expect(row?.primarySpecialty).toMatchObject({ id: cardio.id });
    });

    it('ST-008/SP-004 rechaza con SPECIALTY_INACTIVE asignar una especialidad desactivada', async () => {
      const practitioner = await createPractitioner();
      const specialty = await createSpecialty();
      await request(app.getHttpServer())
        .patch(`/api/v1/specialties/${specialty.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ active: false })
        .expect(200);

      const response = await put(
        `/practitioners/${practitioner.id}/specialties`,
        { items: [{ specialtyId: specialty.id, isPrimary: true }] },
      ).expect(422);

      expect((response.body as Problem).code).toBe('SPECIALTY_INACTIVE');
    });

    it('ST-008/SP-004 conserva intactas las asignaciones existentes al desactivar', async () => {
      const practitioner = await createPractitioner();
      const specialty = await createSpecialty();
      await put(`/practitioners/${practitioner.id}/specialties`, {
        items: [{ specialtyId: specialty.id, isPrimary: true }],
      }).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/specialties/${specialty.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ active: false })
        .expect(200);

      const response = await get(
        `/practitioners/${practitioner.id}/specialties`,
      ).expect(200);
      const items = (
        response.body as { items: { specialtyId: string; active: boolean }[] }
      ).items;
      expect(items).toEqual([
        expect.objectContaining({ specialtyId: specialty.id, active: false }),
      ]);
    });

    it('ST-009 fija, resuelve y retira una excepción de duración por profesional', async () => {
      const practitioner = await createPractitioner();
      const specialty = await createSpecialty();
      const control = await createServiceType(specialty.id, 'Control', 20);
      const primera = await createServiceType(specialty.id, 'Primera vez', 30);
      await put(`/practitioners/${practitioner.id}/specialties`, {
        items: [{ specialtyId: specialty.id, isPrimary: true }],
      }).expect(200);

      await put(
        `/practitioners/${practitioner.id}/duration-exceptions/${control.id}`,
        { durationMinutes: 45 },
      ).expect(204);

      const listed = await get(
        `/practitioners/${practitioner.id}/duration-exceptions`,
      ).expect(200);
      const items = (
        listed.body as {
          items: {
            serviceTypeId: string;
            baseMinutes: number;
            exceptionMinutes: number | null;
            resolvedMinutes: number;
          }[];
        }
      ).items;
      // With an exception the practitioner's own minutes rule (level 1)…
      expect(
        items.find((item) => item.serviceTypeId === control.id),
      ).toMatchObject({
        // prettier-ignore
        baseMinutes: 20,
        exceptionMinutes: 45,
        resolvedMinutes: 45,
      });
      // …and without one the base of the specialty·type rules (level 2).
      expect(
        items.find((item) => item.serviceTypeId === primera.id),
      ).toMatchObject({
        // prettier-ignore
        exceptionMinutes: null,
        resolvedMinutes: 30,
      });

      await destroy(
        `/practitioners/${practitioner.id}/duration-exceptions/${control.id}`,
      ).expect(204);
      expect(
        await prisma.durationException.count({
          where: { practitionerId: practitioner.id },
        }),
      ).toBe(0);
    });

    it('ST-009 el rango de la duración lo garantiza la base: 37 y 250 minutos se rechazan', async () => {
      const practitioner = await createPractitioner();
      const specialty = await createSpecialty();
      const type = await createServiceType(specialty.id);

      for (const minutes of [37, 250]) {
        // Straight SQL, dodging the DTO on purpose: a psql at two in the
        // morning is exactly what the CHECK exists for.
        await expect(
          prisma.$executeRaw`
            INSERT INTO duration_exception (practitioner_id, service_type_id, duration_minutes)
            VALUES (${practitioner.id}::uuid, ${type.id}::uuid, ${minutes})
          `,
        ).rejects.toThrowError(/duration_exception_range/);
      }
    });

    it('ST-009 el espejo del rango responde por campo antes de llegar a la base', async () => {
      const practitioner = await createPractitioner();
      const specialty = await createSpecialty();
      const type = await createServiceType(specialty.id);

      const response = await put(
        `/practitioners/${practitioner.id}/duration-exceptions/${type.id}`,
        { durationMinutes: 37 },
      ).expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('durationMinutes'); // prettier-ignore
    });
  });

  // --- Schedule rules (S2) ----------------------------------------------------

  describe('las reglas de horario', () => {
    const RULE = {
      weekday: 1,
      startTime: '08:00',
      endTime: '12:00',
      slotMinutes: 20,
      validFrom: '2026-01-01',
    };

    it('ST-040 crea una regla de horario con vigencia desde la aplicación', async () => {
      const practitioner = await createPractitioner();

      const response = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);

      expect((response.body as ScheduleOutcome).rule).toMatchObject({
        validFrom: '2026-01-01',
        validTo: null,
        active: true,
      });
    });

    it('ST-007 rechaza una regla en una sede donde el profesional no atiende', async () => {
      const practitioner = await createPractitioner();
      const elsewhere = await createSite(prisma, 'Sede Ajena');

      const response = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId: elsewhere.id, ...RULE },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PRACTITIONER_NOT_IN_SITE');
      expect(problem.errors?.[0]?.field).toBe('siteId');
      expect(await prisma.practitionerScheduleRule.count()).toBe(0);
    });

    it('ST-006 un profesional no agendable no admite reglas de horario nuevas', async () => {
      const practitioner = await createPractitioner({ schedulable: false });

      const response = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(422);

      expect((response.body as Problem).code).toBe('PRACTITIONER_NOT_SCHEDULABLE'); // prettier-ignore
    });

    it('ST-045 la base rechaza un turno que no cabe en la franja', async () => {
      const practitioner = await createPractitioner();

      // Straight SQL: the service mirrors this per field, the CHECK is the
      // guarantee for a seed, an import or a psql.
      await expect(
        prisma.$executeRaw`
          INSERT INTO practitioner_schedule_rule
            (practitioner_id, site_id, weekday, start_time, end_time, slot_minutes, valid_from, updated_at)
          VALUES (${practitioner.id}::uuid, ${siteId}::uuid, 1, '08:00', '08:15', 20, '2026-01-01', now())
        `,
      ).rejects.toThrowError(/schedule_rule_slot_fits/);
    });

    it('ST-045 el espejo responde por campo antes de llegar a la base', async () => {
      const practitioner = await createPractitioner();

      const response = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE, startTime: '08:00', endTime: '08:15' },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_SCHEDULE_RULE');
      expect(problem.errors?.[0]?.field).toBe('slotMinutes');
    });

    it('ST-042 rechaza con SCHEDULE_RULE_OVERLAP una regla que solapa otra vigente', async () => {
      const practitioner = await createPractitioner();
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
      }).expect(201);

      const response = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE, startTime: '11:00', endTime: '15:00' },
      ).expect(409);

      expect((response.body as Problem).code).toBe('SCHEDULE_RULE_OVERLAP');
    });

    it('ST-042 dos franjas contiguas NO solapan: el rango es medio abierto', async () => {
      const practitioner = await createPractitioner();
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
      }).expect(201);

      // Morning ends at 12:00, afternoon starts at 12:00. With `[]` bounds the
      // most normal split of a consulting day would be refused.
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
        startTime: '12:00',
        endTime: '16:00',
      }).expect(201);

      expect(await prisma.practitionerScheduleRule.count()).toBe(2);
    });

    it('ST-042 las mismas horas en OTRO día de la semana se admiten', async () => {
      const practitioner = await createPractitioner();
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
      }).expect(201);

      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
        weekday: 2,
      }).expect(201);

      expect(await prisma.practitionerScheduleRule.count()).toBe(2);
    });

    it('ST-041/ST-042 las mismas horas con vigencias disjuntas se admiten', async () => {
      const practitioner = await createPractitioner();
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
        validFrom: '2026-01-01',
        validTo: '2026-05-31',
      }).expect(201);

      // The new schedule starts the day after the old one ended. `valid_to` is
      // INCLUSIVE here, as the agenda has always read it, so a succession is
      // written as 31-05 / 01-06 and not as 01-06 / 01-06.
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
        validFrom: '2026-06-01',
        validTo: null,
      }).expect(201);

      expect(await prisma.practitionerScheduleRule.count()).toBe(2);
    });

    it('ST-042 dos vigencias que comparten UN día sí solapan: el fin es inclusivo', async () => {
      // The mirror of the test above, and the reason the bound matters: with a
      // half-open `daterange` these two would both be accepted while
      // `slot-availability.ts` considered both in force on 01-06.
      const practitioner = await createPractitioner();
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
        validFrom: '2026-01-01',
        validTo: '2026-06-01',
      }).expect(201);

      const response = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE, validFrom: '2026-06-01', validTo: null },
      ).expect(409);

      expect((response.body as Problem).code).toBe('SCHEDULE_RULE_OVERLAP');
    });

    it('ST-046 la misma franja en OTRA sede se admite: la regla pertenece a una sede', async () => {
      const practitioner = await createPractitioner();
      const second = await createSite(prisma, 'Sede Sur');
      await put(`/practitioners/${practitioner.id}/sites`, {
        siteIds: [siteId, second.id],
      }).expect(200);

      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId,
        ...RULE,
      }).expect(201);
      await post(`/practitioners/${practitioner.id}/schedule-rules`, {
        siteId: second.id,
        ...RULE,
      }).expect(201);

      // The practitioner cannot actually be in both at once — that is the
      // agenda's EXCLUDE on appointments, not this one's job (ST-046).
      expect(await prisma.practitionerScheduleRule.count()).toBe(2);
    });

    it('ST-041 cerrar una regla rige hacia adelante y no borra la fila', async () => {
      const practitioner = await createPractitioner();
      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;

      const closed = await destroy(`/schedule-rules/${ruleId}`).expect(200);

      // `validTo` is the LAST day the rule rules: closing today leaves today
      // intact, so the morning already half over is not cancelled.
      expect((closed.body as ScheduleOutcome).rule.validTo).toBe(clinicDay(0));
      // The row survives: last month's agenda has to stay explainable.
      const kept = await prisma.practitionerScheduleRule.findUnique({
        where: { id: ruleId },
      });
      expect(kept).not.toBeNull();
      expect(kept?.active).toBe(true);
    });

    it('ST-044 toda mutación de horario queda en la bitácora con autor', async () => {
      const practitioner = await createPractitioner();
      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;
      await patch(`/schedule-rules/${ruleId}`, { slotMinutes: 30 }).expect(200);
      await destroy(`/schedule-rules/${ruleId}`).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'staff', resourceId: ruleId },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']); // prettier-ignore
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
    });

    it('ST-043 un cambio de horario LISTA las citas que deja fuera y no las toca', async () => {
      const practitioner = await createPractitioner();
      const patient = await createPatient(prisma);
      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;

      // A Monday inside the rule: 09:00 Ecuadorian time.
      const booked = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date('2027-03-01T09:00:00-05:00'),
          endsAt: new Date('2027-03-01T09:20:00-05:00'),
          bookingChannel: 'PHONE',
        },
      });

      // The morning is cut back to 08:30; the 09:00 appointment falls outside.
      const response = await patch(`/schedule-rules/${ruleId}`, {
        endTime: '08:30',
      }).expect(200);

      const outcome = response.body as ScheduleOutcome;
      expect(outcome.conflicts).toEqual([
        expect.objectContaining({
          agendaEntryId: booked.id,
          date: '2027-03-01',
        }),
      ]);

      // NOTHING was cancelled or moved. That absence IS the requirement.
      const after = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: booked.id },
      });
      expect(after).toMatchObject({
        startsAt: booked.startsAt,
        endsAt: booked.endsAt,
        status: booked.status,
        releasedAt: null,
        cancelledAt: null,
      });
    });

    it('ST-043 una cita que el nuevo horario sigue cubriendo no es conflicto', async () => {
      const practitioner = await createPractitioner();
      const patient = await createPatient(prisma);
      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;

      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date('2027-03-01T08:00:00-05:00'),
          endsAt: new Date('2027-03-01T08:20:00-05:00'),
          bookingChannel: 'PHONE',
        },
      });

      const response = await patch(`/schedule-rules/${ruleId}`, {
        endTime: '10:00',
      }).expect(200);

      expect((response.body as ScheduleOutcome).conflicts).toEqual([]);
    });

    it('ST-043 mover la regla a otra sede LISTA las citas que se quedan en la original', async () => {
      // El fallo que esta prueba fija: los conflictos se calculaban contra la
      // sede que la regla tiene DESPUÉS del cambio, así que mover una regla
      // respondía 200 con `conflicts: []` mientras las citas de la sede
      // original se quedaban sin ninguna regla que las cubriera.
      const practitioner = await createPractitioner();
      const patient = await createPatient(prisma);
      const second = await createSite(prisma, 'Sede Sur');
      await put(`/practitioners/${practitioner.id}/sites`, {
        siteIds: [siteId, second.id],
      }).expect(200);

      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;

      // Un lunes dentro de la franja, en la sede original.
      const booked = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date('2027-03-01T09:00:00-05:00'),
          endsAt: new Date('2027-03-01T09:20:00-05:00'),
          bookingChannel: 'PHONE',
        },
      });

      const response = await patch(`/schedule-rules/${ruleId}`, {
        siteId: second.id,
      }).expect(200);

      const outcome = response.body as ScheduleOutcome;
      expect(outcome.conflicts).toEqual([
        expect.objectContaining({
          agendaEntryId: booked.id,
          date: '2027-03-01',
        }),
      ]);

      // Y nada se anuló ni se movió: la lista es para un humano (ST-043).
      const after = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: booked.id },
      });
      expect(after).toMatchObject({
        siteId,
        startsAt: booked.startsAt,
        releasedAt: null,
        cancelledAt: null,
      });
    });

    it('ST-043 un SOBRECUPO fuera del nuevo horario también es un conflicto', async () => {
      /**
       * `blocks_calendar = false` es un sobrecupo deliberado: una urgencia
       * encajada a mano, y es una cita con un paciente que espera. La consulta
       * de ST-043 filtraba `blocks_calendar: true`, así que los sobrecupos
       * desaparecían de la lista — precisamente los pacientes a los que hay que
       * llamar. `kind` y `released_at` ya cubren los dos casos que el
       * comentario de esa consulta citaba (los bloqueos y las citas anuladas).
       */
      const practitioner = await createPractitioner();
      const patient = await createPatient(prisma);
      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;

      const overbooked = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date('2027-03-01T09:00:00-05:00'),
          endsAt: new Date('2027-03-01T09:20:00-05:00'),
          bookingChannel: 'PHONE',
          blocksCalendar: false,
        },
      });

      const response = await patch(`/schedule-rules/${ruleId}`, {
        endTime: '08:30',
      }).expect(200);

      expect(
        (response.body as ScheduleOutcome).conflicts.map(
          (conflict) => conflict.agendaEntryId,
        ),
      ).toEqual([overbooked.id]);
    });

    it('ST-043 un BLOQUEO fuera del nuevo horario NO es un conflicto', async () => {
      // La otra mitad, y lo que `kind` ya distinguía: un feriado fuera de las
      // horas nuevas es exactamente para lo que sirve un bloqueo.
      const practitioner = await createPractitioner();
      const created = await post(
        `/practitioners/${practitioner.id}/schedule-rules`,
        { siteId, ...RULE },
      ).expect(201);
      const ruleId = (created.body as ScheduleOutcome).rule.id;

      await prisma.agendaEntry.create({
        data: {
          // `agenda_entry_booking_channel_coherence`: un bloqueo no tiene
          // canal de reserva ni paciente, porque no lo reservó nadie.
          kind: 'BLOCK',
          status: 'BLOCKED',
          siteId,
          practitionerId: practitioner.id,
          startsAt: new Date('2027-03-01T09:00:00-05:00'),
          endsAt: new Date('2027-03-01T09:20:00-05:00'),
        },
      });

      const response = await patch(`/schedule-rules/${ruleId}`, {
        endTime: '08:30',
      }).expect(200);

      expect((response.body as ScheduleOutcome).conflicts).toEqual([]);
    });

    it('ST-042 ARBITRA entre dos administradores que solapan el mismo horario', async () => {
      /**
       * The reason ST-042 lives in the database and not in a service.
       *
       * The tests above write one rule and then another, which proves
       * uniqueness, not ARBITRATION. A `SELECT ... WHERE NOT EXISTS` followed
       * by an INSERT would pass every one of them and still leave two
       * overlapping rules, because both transactions read "free" before either
       * writes — and a slot grid derived from two overlapping rules offers the
       * same minute twice, with two different durations.
       *
       * Two independent clients, so these are genuinely two connections.
       * Follows `agenda-overlap.spec.ts`: no barrier holding the transactions
       * open, because PostgreSQL makes the second writer WAIT on the first
       * one's uncommitted row and only rejects it at that commit — that
       * blocking IS the arbitration, and trying to force both to insert before
       * either commits deadlocks by construction.
       */
      const practitioner = await createPractitioner();
      const url = inject('databaseUrl');

      const clientA = new PrismaClient({
        adapter: new PrismaPg({ connectionString: url }),
      });
      const clientB = new PrismaClient({
        adapter: new PrismaPg({ connectionString: url }),
      });

      const write = (
        client: PrismaClient,
        startHour: string,
        endHour: string,
      ) =>
        withSerialisationRetry(() =>
          client.practitionerScheduleRule.create({
            data: {
              practitionerId: practitioner.id,
              siteId,
              weekday: 1,
              startTime: new Date(`1970-01-01T${startHour}:00Z`),
              endTime: new Date(`1970-01-01T${endHour}:00Z`),
              slotMinutes: 20,
              validFrom: new Date('2026-01-01T00:00:00Z'),
            },
          }),
        );

      try {
        const outcomes = await Promise.allSettled([
          write(clientA, '08:00', '12:00'),
          // Overlapping by an hour: same practitioner, same site, same weekday.
          write(clientB, '11:00', '15:00'),
        ]);

        // EXACTLY one, not "at least one failed": two winners is the bug.
        const winners = outcomes.filter(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<PractitionerScheduleRule> =>
            outcome.status === 'fulfilled',
        );
        expect(winners).toHaveLength(1);

        // WHO won, and not merely how many. Which client wins is the
        // database's call and cannot be predicted, but the winner is knowable
        // after the fact: it is the one whose row is in the table. This rules
        // out the two failures a count would miss — a "winner" whose insert
        // was rolled back, and a loser who left a row behind anyway.
        const held = await db().practitionerScheduleRule.findMany({
          where: { practitionerId: practitioner.id, active: true },
        });
        expect(held).toHaveLength(1);
        expect(held[0]?.id).toBe(winners[0]?.value.id);

        // And the loser is told what is wrong in the module's own words, with
        // the status the SPEC fixes — not a 500 from a raw constraint message.
        const loser = outcomes.find((outcome) => outcome.status === 'rejected');
        const problem = extractDatabaseProblem(loser?.reason);
        expect(problem?.status).toBe(409);
        expect(problem?.code).toBe('SCHEDULE_RULE_OVERLAP');
      } finally {
        await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
      }
    });
  });

  describe('la semilla de desarrollo', () => {
    /**
     * LA REGLA DE «SEMILLAS POR ENTREGA»: toda entrega con pantalla nueva deja
     * un estado idempotente donde probarla a mano. La de ST-009 no lo tenía —
     * `duration_exception` no la escribía nadie— y `practitioner_specialty`,
     * que es tabla de este módulo desde el 13-08-2026, la seguía escribiendo
     * la semilla de `specialties`. Una pantalla que sólo se puede probar
     * escribiendo SQL a mano es una pantalla que nadie prueba.
     */
    async function seededPractitionerAccounts(): Promise<void> {
      for (const [email, cedula] of [
        ['medico@clinica.ec', '1804822136'],
        ['admin@clinica.ec', '0926687856'],
      ] as const) {
        const user = await prisma.user.create({
          data: {
            email,
            firstName: 'Personal',
            lastName: 'De prueba',
            // Cédulas sintéticas con dígito verificador calculado.
            cedula,
            passwordHash: 'not-a-real-hash',
          },
        });
        await prisma.practitioner.create({ data: { userId: user.id } });
      }
    }

    it('ST-008/ST-009 deja especialidad principal y excepción de duración, y es idempotente', async () => {
      await seededPractitionerAccounts();
      await seedSpecialties(prisma);

      const first = await seedStaff(prisma);
      expect(first.habilitated).toBe(2);
      expect(first.specialtiesAssigned).toBe(2);
      // ST-009: la fila sin la cual la pantalla de excepciones abre vacía.
      expect(first.durationExceptions).toBe(1);

      const exception = await prisma.durationException.findFirstOrThrow({
        select: { durationMinutes: true, serviceType: { select: { name: true, durationMinutes: true } } }, // prettier-ignore
      });
      // Visiblemente distinta de la base (SP-020): así se lee de un vistazo la
      // jerarquía de D-010 —excepción → base—.
      expect(exception).toMatchObject({
        durationMinutes: 45,
        serviceType: { name: 'Control', durationMinutes: 20 },
      });

      const second = await seedStaff(prisma);
      expect(second.specialtiesAssigned).toBe(0);
      expect(second.durationExceptions).toBe(0);
      expect(second.rules).toBe(0);
      expect(await prisma.durationException.count()).toBe(1);
      expect(await prisma.practitionerSpecialty.count()).toBe(2);
    });

    it('SP-001 la semilla del catálogo ya NO escribe practitioner_specialty', async () => {
      // Es tabla de `staff` (ST-008). Una semilla que escribe la tabla de otro
      // módulo es la misma frontera que `arch:check` rechaza en el código.
      await seededPractitionerAccounts();

      await seedSpecialties(prisma);

      expect(await prisma.practitionerSpecialty.count()).toBe(0);
    });

    it('ST-008 sin catálogo de especialidades la semilla no falla: lo omite', async () => {
      // `specialties` no es suyo. Saltarlo es la respuesta correcta a «todavía
      // no se ha sembrado el catálogo», y reventar aquí obligaría a recordar
      // un orden que nadie escribió.
      await seededPractitionerAccounts();

      const result = await seedStaff(prisma);

      expect(result.specialtiesAssigned).toBe(0);
      expect(result.durationExceptions).toBe(0);
      // Y lo que sí es suyo sí quedó sembrado.
      expect(result.habilitated).toBe(2);
      expect(result.rules).toBeGreaterThan(0);
    });
  });
});
