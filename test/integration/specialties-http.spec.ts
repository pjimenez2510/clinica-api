import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createConsultation,
  createPatient,
  createService,
  createPractitioner,
  createSite,
  hourSlot,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The specialties module (C1) as the browser consumes it, against a real
 * PostgreSQL 18: what these prove that the unit suites cannot is that the
 * guarantees actually live in the base — the accent-insensitive uniqueness
 * (SP-006), the RESTRICT that answers SPECIALTY_IN_USE (SP-003) — and that
 * every refusal reaches HTTP with the code the SPEC fixes, under the
 * permissions of D-002.
 *
 * SINCE 11-10-2026 (ADR-013) the service types are gone: a consultation is a
 * `service` of kind CONSULTATION. What this suite still proves about them is
 * what the substituted requirements (SP-020 … SP-031) promise from the
 * specialty's side — against the base, where the guarantees moved.
 *
 * WHAT MOVED OUT ON 13-08-2026: everything that administered a PRACTITIONER.
 * The assignment of specialties and the per-practitioner duration exceptions
 * are ST-008 and ST-009 in `test/integration/staff-http.spec.ts`, which is
 * where the debt this SPEC declared got settled.
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
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    const practitioner = await createPractitioner(prisma);
    practitionerId = practitioner.id;

    await syncAuthorisation(prisma);
    // SP-027. The consultation created through «Servicios» needs the 0 % rate
    // of health services, which comes from the billing seed.
    await seedBilling(prisma);
    // The role→permission cache is indexed by id, and truncation recreates
    // the roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', '1710034065');
  }

  async function signIn(
    email: string,
    roleCode: string,
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

  const destroy = (path: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1/specialties${path}`)
      .set('Authorization', `Bearer ${token}`);

  /**
   * SP-009: only the name travels — the request has no `code` any more.
   */
  async function createSpecialty(
    name = 'Cardiología',
  ): Promise<{ id: string; code: string }> {
    const response = await post('', { name }).expect(201);
    return response.body as { id: string; code: string };
  }

  /**
   * Una cita reservada QUE NOMBRA LA CONSULTA (SP-028), escrita directamente
   * en la tabla: la ruta que reserva es de `agenda` y lo que estas pruebas
   * comprueban es la clave foránea, no el endpoint.
   */
  async function bookAppointmentWith(serviceId: string) {
    const site = await createSite(prisma);
    await linkPractitionerToSite(prisma, practitionerId, site.id);
    const patient = await createPatient(prisma);

    return prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId,
        patientId: patient.id,
        ...hourSlot(13),
        bookingChannel: 'PHONE',
        serviceId,
      },
    });
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

      const response = await post('', { name: 'Pediatría' }, recepcion).expect(403); // prettier-ignore

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('SP-006 rechaza con SPECIALTY_DUPLICATE un nombre que solo difiere en acentos y mayúsculas', async () => {
      await createSpecialty('Pediatría');

      const response = await post('', { name: 'PEDIATRIA' }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SPECIALTY_DUPLICATE');
      expect(problem.errors?.[0]?.field).toBe('name');
    });

    it('SP-009 deriva el código del nombre al crear y lo devuelve en la respuesta', async () => {
      const created = await createSpecialty('Ginecología y Obstetricia');

      // El mismo código que ya trae la semilla del MSP para esta especialidad:
      // que la derivación los reproduzca los 22 lo fija
      // `specialty-code.spec.ts`; aquí se comprueba que es el que se GUARDA.
      expect(created.code).toBe('ginecologia-obstetricia');
      expect(
        await prisma.specialty.findUnique({ where: { id: created.id } }),
      ).toMatchObject({ code: 'ginecologia-obstetricia' });
    });

    it('SP-009 ignora un código enviado a mano: el contrato ya no lo acepta', async () => {
      const response = await post('', {
        name: 'Cardiología',
        code: 'el-que-yo-quiera',
      }).expect(201);

      expect((response.body as { code: string }).code).toBe('cardiologia');
    });

    it('SP-010 renombrar NO mueve el código, ni con un nombre que derivaría otro', async () => {
      const created = await createSpecialty('Ginecologia y Obstetricia');
      expect(created.code).toBe('ginecologia-obstetricia');

      // A name that would DERIVE ANOTHER code («obstetricia-ginecologia»):
      // with only a tilde changed, re-deriving would give the same code and
      // this test could not fail.
      const renamed = await patch(`/${created.id}`, {
        name: 'Obstetricia y Ginecología',
      }).expect(200);

      // Si el código se volviera a derivar aquí, esta fila cambiaría de
      // identidad para `practitioner_specialty`, los informes y la semilla.
      expect((renamed.body as { code: string }).code).toBe(
        'ginecologia-obstetricia',
      );
      expect(
        await prisma.specialty.findUnique({ where: { id: created.id } }),
      ).toMatchObject({ code: 'ginecologia-obstetricia' });
    });

    it('SP-009/SP-006 dos nombres que derivan el mismo código chocan hablando del NOMBRE', async () => {
      await createSpecialty('Medicina Familiar y Comunitaria');

      // Otro nombre, distinto de verdad, que deriva `medicina-familiar`.
      const response = await post('', {
        name: 'Medicina Familiar Preventiva',
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SPECIALTY_DUPLICATE');
      // La casilla que el formulario tiene es la del nombre; la del código no
      // existe, así que señalarla no iluminaría nada.
      expect(problem.errors?.[0]?.field).toBe('name');
      // Y ni el título ni el mensaje por campo le hablan de un código que esa
      // persona nunca vio (ADR-005 §5).
      expect(problem.title).not.toMatch(/c[oó]digo/i);
      expect(problem.errors?.[0]?.message).not.toMatch(/c[oó]digo/i);
    });

    it('SP-009 rechaza por campo un nombre del que no se puede derivar ningún código', async () => {
      const response = await post('', { name: '🙂🙂' }).expect(422);

      const problem = response.body as Problem;
      expect(problem.errors?.[0]?.field).toBe('name');
      expect(problem.errors?.[0]?.message).toContain('letras');
      expect(await prisma.specialty.count()).toBe(0);
    });

    it('SP-003 rechaza borrar una especialidad referenciada con SPECIALTY_IN_USE y ofrece desactivarla', async () => {
      const specialty = await createSpecialty();
      // ADR-013: what references it now is its consultation.
      await createConsultation(prisma, { specialtyId: specialty.id, name: 'Control' }); // prettier-ignore

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

  /**
   * ADR-013 (11-10-2026). The service type is gone: a consultation is a
   * `service` of kind CONSULTATION, administered in «Servicios» (`billing`).
   * The requirements it carried are substituted or amended in the SPEC; what
   * each still promises is proven here against the base, where it moved.
   */
  describe('la consulta es un servicio (ADR-013)', () => {
    /** Straight to the table: `service_consultation_shape` and the range are the base's. */
    let codes = 0;
    const insertConsultation = (name: string, specialtyId: string, minutes?: number) => // prettier-ignore
      createService(prisma, { code: `T-CONS-${++codes}`, name, kind: 'CONSULTATION', specialtyId, durationMinutes: minutes }); // prettier-ignore

    it('BI-279 (sustituye al tipo de atención): las rutas de tipos de atención ya no existen y la consulta exige especialidad y duración en la base', async () => {
      const specialty = await createSpecialty();

      await get(`/${specialty.id}/service-types`).expect(404);
      await post(`/${specialty.id}/service-types`, { name: 'Control', durationMinutes: 20 }).expect(404); // prettier-ignore

      // `service_consultation_shape`: sin duración no hay consulta…
      await expect(
        insertConsultation('Consulta sin duración', specialty.id),
      ).rejects.toThrow(/service_consultation_shape/);
      // …y con especialidad y duración, sí (control positivo).
      await expect(
        insertConsultation('Primera vez', specialty.id, 30),
      ).resolves.toMatchObject({ durationMinutes: 30 });
    });

    it('SP-021 la base rechaza 37 y 250 minutos en una consulta: el CHECK es la garantía, no el Zod', async () => {
      const specialty = await createSpecialty();

      for (const minutes of [37, 250]) {
        // Straight SQL, dodging every DTO on purpose: a psql at two in the
        // morning is exactly what the CHECK exists for.
        await expect(
          insertConsultation(
            `Fuera de rango ${minutes}`,
            specialty.id,
            minutes,
          ),
        ).rejects.toThrow(/service_duration_range/);
      }
      await expect(
        insertConsultation('Dentro de rango', specialty.id, 40),
      ).resolves.toMatchObject({ durationMinutes: 40 });
    });

    it('BI-278 (sustituye al nombre único por especialidad): dos servicios activos no comparten nombre, sin mirar tildes ni mayúsculas', async () => {
      const cardiology = await createSpecialty('Cardiología');
      const paediatrics = await createSpecialty('Pediatría');
      const first = await createConsultation(prisma, { specialtyId: cardiology.id, name: 'Control médico' }); // prettier-ignore

      // Ya no es «dentro de la especialidad»: es en toda la clínica.
      await expect(
        createConsultation(prisma, { specialtyId: paediatrics.id, name: 'CONTROL MEDICO' }), // prettier-ignore
      ).rejects.toThrow(/immutable_unaccent\(lower\(btrim\(name/);

      // Control positivo: retirado el primero, el nombre queda libre.
      await prisma.service.update({ where: { id: first.id }, data: { active: false } }); // prettier-ignore
      await expect(
        createConsultation(prisma, { specialtyId: paediatrics.id, name: 'CONTROL MEDICO' }), // prettier-ignore
      ).resolves.toMatchObject({ kind: 'CONSULTATION' });
    });

    it('SP-025 la base no deja borrar una consulta que una cita nombra; sin citas se borra y sus excepciones mueren con ella', async () => {
      const specialty = await createSpecialty();
      const booked = await createConsultation(prisma, { specialtyId: specialty.id, name: 'Control', visitKind: 'FOLLOW_UP' }); // prettier-ignore
      const free = await createConsultation(prisma, { specialtyId: specialty.id, name: 'Primera vez', visitKind: 'FIRST_VISIT' }); // prettier-ignore
      const appointment = await bookAppointmentWith(booked.id);
      await prisma.durationException.create({
        data: { practitionerId, serviceId: free.id, durationMinutes: 40 },
      });

      // `agenda_entry_service_fk` es RESTRICT: `billing` lo traduce a
      // BILLABLE_SERVICE_IN_USE y ofrece desactivarlo (BI-288).
      await expect(
        prisma.service.delete({ where: { id: booked.id } }),
      ).rejects.toThrow(/agenda_entry_service_fk/);
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: appointment.id },
      });
      expect(stored.serviceId).toBe(booked.id);

      // Control positivo: la que ninguna cita nombra se borra, y la excepción
      // de un médico sobre ella cae en cascada (`duration_exception_service_fk`).
      await prisma.service.delete({ where: { id: free.id } });
      await expect(
        prisma.durationException.count({ where: { serviceId: free.id } }),
      ).resolves.toBe(0);
    });

    it('SP-027 crear y corregir una consulta deja su rastro como servicio, con autor y antes y después', async () => {
      const specialty = await createSpecialty();
      const billing = (path: string) => `/api/v1/billing${path}`;

      const created = await request(app.getHttpServer())
        .post(billing('/services'))
        .set('Authorization', `Bearer ${token}`)
        .send({
          kind: 'CONSULTATION',
          name: 'Control cardiológico',
          selfPayAmount: '25.00',
          specialtyId: specialty.id,
          durationMinutes: 20,
          visitKind: 'FOLLOW_UP',
        })
        .expect(201);
      const serviceId = (created.body as { id: string }).id;
      await request(app.getHttpServer())
        .patch(billing(`/services/${serviceId}`))
        .set('Authorization', `Bearer ${token}`)
        .send({ durationMinutes: 30 })
        .expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'service', resourceId: serviceId },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
      expect(trail[1]?.before).toMatchObject({ durationMinutes: 20 });
      expect(trail[1]?.after).toMatchObject({ durationMinutes: 30 });
    });

    it('la especialidad no crea servicios detrás, y renombrarla no renombra sus consultas (ADR-013)', async () => {
      const before = await prisma.service.count();
      const specialty = await createSpecialty('Ginecologia');
      await expect(prisma.service.count()).resolves.toBe(before);

      const consultation = await createConsultation(prisma, { specialtyId: specialty.id, name: 'Control prenatal' }); // prettier-ignore
      await patch(`/${specialty.id}`, { name: 'Ginecología' }).expect(200);

      // La consulta lleva su propio nombre (BI-279): nada lo deriva ya de la
      // especialidad. Y la especialidad sí cambió (control positivo).
      await expect(
        prisma.service.findUniqueOrThrow({ where: { id: consultation.id } }),
      ).resolves.toMatchObject({ name: 'Control prenatal' });
      // SP-010: renamed, but its code is the one it was born with.
      await expect(
        prisma.specialty.findUniqueOrThrow({ where: { id: specialty.id } }),
      ).resolves.toMatchObject({ name: 'Ginecología', code: specialty.code });
      await expect(prisma.service.count()).resolves.toBe(before + 1);
    });

    it('la cita nombra UN servicio y no queda tabla de prestaciones por tipo (ADR-013)', async () => {
      const tables = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('service_type', 'service_type_billable_service', 'service')
      `;
      expect(tables.map((row) => row.table_name)).toEqual(['service']);

      const column = await prisma.$queryRaw<{ data_type: string }[]>`
        SELECT data_type FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'agenda_entry' AND column_name = 'service_id'
      `;
      expect(column).toEqual([{ data_type: 'uuid' }]);
    });

    it('SP-024 cambiar la duración de una consulta no toca ninguna cita ya reservada', async () => {
      const specialty = await createSpecialty();
      const consultation = await createConsultation(prisma, { specialtyId: specialty.id, name: 'Control', durationMinutes: 20 }); // prettier-ignore
      // LA CITA NOMBRA LA CONSULTA, que es lo que hace la prueba pertinente:
      // si algo propagara la duración a las citas, sería por esa relación.
      const booked = await bookAppointmentWith(consultation.id);

      // Escrito en la tabla y no por la ruta de `billing`: lo que se prueba es
      // que NADA en la base —ningún disparador— lleva el cambio a las citas.
      await prisma.service.update({
        where: { id: consultation.id },
        data: { durationMinutes: 40 },
      });

      const entries = await prisma.agendaEntry.findMany();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: booked.id,
        startsAt: booked.startsAt,
        // El intervalo con el que se reservó, no los cuarenta minutos que la
        // consulta dice ahora: la duración rige HACIA ADELANTE.
        endsAt: booked.endsAt,
        serviceId: consultation.id,
        updatedAt: booked.updatedAt,
      });
      // Control positivo: el cambio sí quedó en la consulta.
      await expect(
        prisma.service.findUniqueOrThrow({ where: { id: consultation.id } }),
      ).resolves.toMatchObject({ durationMinutes: 40 });
    });
  });

  describe('la semilla del catálogo (SP-001, D-008)', () => {
    it('SP-001 precarga las especialidades del MSP y es idempotente: dos pasadas, el mismo catálogo', async () => {
      const first = await seedSpecialties(prisma);
      expect(first.specialtiesCreated).toBeGreaterThan(15);

      const specialtiesAfterFirst = await prisma.specialty.count();

      const second = await seedSpecialties(prisma);
      expect(second.specialtiesCreated).toBe(0);
      expect(await prisma.specialty.count()).toBe(specialtiesAfterFirst);

      // Spot check D-008: the general practice every clinic starts from.
      const general = await prisma.specialty.findFirst({
        where: { code: 'medicina-general' },
      });
      expect(general).toMatchObject({ name: 'Medicina General', active: true });
    });
  });
});
