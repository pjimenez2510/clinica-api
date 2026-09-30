import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedOrganization } from '../../prisma/seed-organization.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createPractitioner } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The organization module (O1 and O2) as the browser consumes it, against a
 * real PostgreSQL 18.
 *
 * What these prove that the unit suites cannot is that the guarantees live in
 * the BASE: the unique MSP code (OR-002), the unique room name per site
 * (OR-020), the unique emission point code per site (OR-024), the RESTRICT
 * foreign keys that answer SITE_IN_USE and SITE_ROOM_IN_USE (OR-006, OR-022),
 * and above all the COMPOSITE foreign key that finally makes OR-021 (AG-105)
 * a database guarantee rather than an `if` in TypeScript — the one thing a
 * double could never demonstrate.
 */
const PASSWORD = 'el caballo come alfalfa';
const ADMIN_EMAIL = 'gerencia@clinica.ec';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';

/** RUCs with REAL check digits, computed with the SRI's three algorithms. */
const VALID_RUC = '1790001563001'; // private company
const VALID_PUBLIC_RUC = '1760001550001'; // public sector

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

describe('la organización por HTTP', () => {
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

    const practitioner = await createPractitioner(prisma);
    practitionerId = practitioner.id;

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates
    // the roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', '1710034065');
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /**
   * `siteId` is what ADR-007's site dimension looks like from outside.
   *
   * `null` — the default — is the clinic-wide grant a director gets. A NAMED
   * site is what `ReplaceGrantsDto` exists to allow (AU-032): «Administrador
   * de sede», scoped to one city. The two used to be indistinguishable to
   * `PATCH /organization/rooms/:id`, which is the defect the tests below fix.
   */
  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'RECEPCION',
    cedula: string,
    siteId: string | null = null,
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
    if (roleCode === 'ADMIN' && siteId === null) adminUserId = user.id;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const base = '/api/v1/organization';

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

  const patch = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .patch(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const destroy = (path: string, auth = token) =>
    request(app.getHttpServer())
      .delete(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`);

  let siteSequence = 0;
  const nextMspCode = (): string => {
    siteSequence += 1;
    return `MSP-${String(siteSequence).padStart(4, '0')}`;
  };

  async function saveEstablishment(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const response = await put('/establishment', {
      mspUnicode: 'MSP-EST-001',
      typology: 'Centro de Salud Tipo A',
      legalName: 'Clínica de Prueba S.A.',
      ...overrides,
    }).expect(200);
    return response.body as { id: string };
  }

  async function createSite(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; mspUnicode: string }> {
    const response = await post('/sites', {
      mspUnicode: nextMspCode(),
      name: `Sede ${nextMspCode()}`,
      ...overrides,
    }).expect(201);
    return response.body as { id: string; mspUnicode: string };
  }

  async function createRoom(
    siteId: string,
    name = 'Consultorio 1',
  ): Promise<{ id: string }> {
    const response = await post(`/sites/${siteId}/rooms`, { name }).expect(201);
    return response.body as { id: string };
  }

  /**
   * An appointment, so the RESTRICT foreign keys have something to refuse.
   *
   * Written straight to the table and WITHOUT a `practitioner_site` row: what
   * these tests need is a reference to the site and the room, and AG-014 —
   * which is what that link is for — is the agenda's requirement, exercised in
   * its own suite.
   */
  async function bookInto(siteId: string, roomId?: string, hour = 13) {
    const patient = await createPatient(prisma);
    return prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId,
        practitionerId,
        patientId: patient.id,
        roomId,
        // The hour is a parameter because the practitioner is the same in
        // every call and `agenda_entry_no_practitioner_overlap` is real: two
        // appointments at 13:00 would be refused for the RIGHT reason, and the
        // test would look like the wrong one had failed.
        startsAt: new Date(`2026-09-14T${String(hour).padStart(2, '0')}:00:00Z`), // prettier-ignore
        endsAt: new Date(`2026-09-14T${String(hour).padStart(2, '0')}:20:00Z`),
        bookingChannel: 'PHONE',
      },
    });
  }

  describe('el establecimiento', () => {
    it('OR-001 registra la tipología y el código único del MSP, y OR-003 los expone', async () => {
      await saveEstablishment();

      const response = await get('/establishment').expect(200);
      expect(response.body).toMatchObject({
        mspUnicode: 'MSP-EST-001',
        typology: 'Centro de Salud Tipo A',
        legalName: 'Clínica de Prueba S.A.',
        active: true,
      });
    });

    it('OR-001 no permite operar sin tipología ni código: el alta sin ellos se rechaza', async () => {
      const response = await put('/establishment', {
        legalName: 'Clínica sin papeles',
      }).expect(422);

      const fields = (response.body as Problem).errors?.map((e) => e.field);
      expect(fields).toContain('mspUnicode');
      expect(fields).toContain('typology');
    });

    it('OR-001 responde ESTABLISHMENT_NOT_FOUND mientras no se haya registrado', async () => {
      const response = await get('/establishment').expect(404);

      expect((response.body as Problem).code).toBe('ESTABLISHMENT_NOT_FOUND');
    });

    it('OR-001 el mismo PUT edita el establecimiento ya registrado, sin crear un segundo', async () => {
      const created = await saveEstablishment();
      const edited = await saveEstablishment({ typology: 'Hospital Básico' });

      expect(edited.id).toBe(created.id);
      expect(await prisma.establishment.count()).toBe(1);
    });

    it('OR-002 la base impide dos establecimientos con el mismo código único del MSP', async () => {
      await saveEstablishment();

      // Straight into the table, dodging service and DTO: only
      // `establishment_msp_unicode_unique` can refuse this one.
      await expect(
        prisma.establishment.create({
          data: {
            mspUnicode: 'MSP-EST-001',
            typology: 'Hospital Básico',
            legalName: 'Otra clínica',
          },
        }),
      ).rejects.toThrowError(/establishment_msp_unicode_unique|Unique/i);
    });

    it('OR-009 rechaza con INVALID_RUC el RUC de persona natural con verificador equivocado', async () => {
      const response = await put('/establishment', {
        mspUnicode: 'MSP-EST-001',
        typology: 'Centro de Salud Tipo A',
        legalName: 'Clínica de Prueba S.A.',
        // The cedula 1710034065 with its check digit altered by one.
        ruc: '1710034060001',
      }).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_RUC');
      expect(problem.errors?.[0]?.field).toBe('ruc');
      expect(await prisma.establishment.count()).toBe(0);
    });

    it('OR-008 admite las tres clases de RUC del SRI: natural, público y privado', async () => {
      for (const ruc of ['1710034065001', VALID_PUBLIC_RUC, VALID_RUC]) {
        const saved = await saveEstablishment({ ruc });
        expect(
          await prisma.establishment.findUniqueOrThrow({
            where: { id: saved.id },
            select: { ruc: true },
          }),
        ).toEqual({ ruc });
      }
    });

    it('OR-009 guarda el RUC de una sociedad que no pasa módulo 11, como los emite el SRI desde 2021', async () => {
      // Published by the Mintel as SRI-issued numbers (D-057). The control:
      // the same request with a malformed RUC is refused, so what makes the
      // difference is the check digit and nothing else.
      await put('/establishment', {
        mspUnicode: 'MSP-EST-001',
        typology: 'Centro de Salud Tipo A',
        legalName: 'Clínica de Prueba S.A.',
        ruc: '179318990600',
      }).expect(422);

      for (const ruc of ['1793189906001', '0993366721001']) {
        const saved = await saveEstablishment({ ruc });
        expect(
          await prisma.establishment.findUniqueOrThrow({
            where: { id: saved.id },
            select: { ruc: true },
          }),
        ).toEqual({ ruc });
      }
    });

    it('OR-008 la base rechaza por su cuenta un RUC con forma imposible', async () => {
      // A `psql` at two in the morning dodges every Zod and every value
      // object; `establishment_ruc_format` is what is left.
      await expect(
        prisma.$executeRaw`
          INSERT INTO establishment (msp_unicode, typology, legal_name, ruc)
          VALUES ('MSP-RAW', 'Centro de Salud Tipo A', 'Clínica', '17900015630')
        `,
      ).rejects.toThrowError(/establishment_ruc_format/);
    });

    it('OR-005 deja el alta y la edición del establecimiento en la bitácora, con autor e instante', async () => {
      const establishment = await saveEstablishment();
      await saveEstablishment({ typology: 'Hospital Básico' });

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'organization' },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(trail[0]).toMatchObject({
        userId: adminUserId,
        resourceId: establishment.id,
      });
      expect(trail[0]!.occurredAt).toBeInstanceOf(Date);
    });
  });

  describe('las sedes', () => {
    it('OR-004 crea una sede con nombre, dirección, teléfono y parroquia del DPA', async () => {
      const establishment = await saveEstablishment();
      const parish = await prisma.catalogConcept.findFirst({
        select: { id: true },
      });

      const site = await createSite({
        name: 'Sede Norte',
        addressLine: 'Av. de los Granados y 6 de Diciembre',
        phone: '02 000 0000',
        parishConceptId: parish?.id ?? null,
      });

      const response = await get(`/sites/${site.id}`).expect(200);
      expect(response.body).toMatchObject({
        name: 'Sede Norte',
        addressLine: 'Av. de los Granados y 6 de Diciembre',
        phone: '02 000 0000',
        // OR-004: the site hangs off the establishment that is registered.
        establishmentId: establishment.id,
      });
    });

    it('OR-002 rechaza con MSP_UNICODE_DUPLICATE una sede con un código del MSP ya usado', async () => {
      const first = await createSite();

      const response = await post('/sites', {
        mspUnicode: first.mspUnicode,
        name: 'Sede repetida',
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('MSP_UNICODE_DUPLICATE');
      expect(problem.errors?.[0]?.field).toBe('mspUnicode');
    });

    it('OR-009 admite en una sede el RUC de una sociedad que no pasa módulo 11', async () => {
      const response = await post('/sites', {
        mspUnicode: nextMspCode(),
        name: 'Sede de sociedad nueva',
        ruc: '1793189906001',
      }).expect(201);

      expect(
        await prisma.site.findUniqueOrThrow({
          where: { id: (response.body as { id: string }).id },
          select: { ruc: true },
        }),
      ).toEqual({ ruc: '1793189906001' });
    });

    it('OR-008 rechaza con INVALID_RUC el RUC de una sede que factura', async () => {
      const response = await post('/sites', {
        mspUnicode: nextMspCode(),
        name: 'Sede con RUC malo',
        ruc: '1234567890123',
      }).expect(422);

      expect((response.body as Problem).code).toBe('INVALID_RUC');
    });

    it('OR-006 rechaza borrar una sede referenciada por una cita con SITE_IN_USE y ofrece desactivarla', async () => {
      const site = await createSite();
      await bookInto(site.id);

      const response = await destroy(`/sites/${site.id}`).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SITE_IN_USE');
      // The other half of the requirement: the refusal offers deactivation.
      expect(problem.title).toContain('desactivarla');
      // And the row survived.
      expect(
        await prisma.site.findUnique({ where: { id: site.id } }),
      ).not.toBeNull();
    });

    it('OR-006 borra una sede sin referencias y deja bitácora', async () => {
      const site = await createSite();

      await destroy(`/sites/${site.id}`).expect(204);

      expect(await prisma.site.findUnique({ where: { id: site.id } })).toBeNull(); // prettier-ignore
      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'organization', resourceId: site.id },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    });

    it('OR-007 una sede desactivada sale del listado por defecto y conserva sus referencias', async () => {
      const site = await createSite();
      const appointment = await bookInto(site.id);

      await patch(`/sites/${site.id}`, { active: false }).expect(200);

      const byDefault = await get('/sites').expect(200);
      const everything = await get('/sites?includeInactive=true').expect(200);
      const idsOf = (body: unknown) =>
        (body as { items: { id: string }[] }).items.map((item) => item.id);

      expect(idsOf(byDefault.body)).not.toContain(site.id);
      expect(idsOf(everything.body)).toContain(site.id);
      // «DEBERÁ conservar intactas las referencias existentes»: the appointment
      // is still there and still points at the site.
      const kept = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: appointment.id },
      });
      expect(kept.siteId).toBe(site.id);
    });

    it('OR-005 deja en la bitácora toda mutación de sedes, con autor', async () => {
      const site = await createSite();
      await patch(`/sites/${site.id}`, { name: 'Sede renombrada' }).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'organization' },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
    });
  });

  describe('los consultorios', () => {
    it('OR-020 rechaza con SITE_ROOM_DUPLICATE dos consultorios con el mismo nombre en la sede', async () => {
      const site = await createSite();
      await createRoom(site.id, 'Consultorio 1');

      const response = await post(`/sites/${site.id}/rooms`, {
        name: 'Consultorio 1',
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SITE_ROOM_DUPLICATE');
      expect(problem.errors?.[0]?.field).toBe('name');
    });

    it('OR-020 el mismo nombre en OTRA sede sí se admite: la unicidad es por sede', async () => {
      const north = await createSite();
      const south = await createSite();
      await createRoom(north.id, 'Consultorio 1');

      await post(`/sites/${south.id}/rooms`, { name: 'Consultorio 1' }).expect(201); // prettier-ignore
    });

    it('OR-021 la base impide usar en una cita un consultorio de otra sede', async () => {
      // THE POINT OF THIS TEST. Until this delivery the only thing stopping it
      // was an `if` in the agenda service, so a data import or a psql session
      // could occupy a physical room of another site and the appointment would
      // never appear in either agenda. Raw SQL on purpose: it dodges the
      // service the same way those writes do.
      const north = await createSite();
      const south = await createSite();
      const southRoom = await createRoom(south.id, 'Consultorio 1');
      const patient = await createPatient(prisma);

      await expect(
        prisma.$executeRaw`
          INSERT INTO agenda_entry
            (kind, site_id, practitioner_id, patient_id, room_id,
             starts_at, ends_at, booking_channel, updated_at)
          VALUES
            ('APPOINTMENT', ${north.id}::uuid, ${practitionerId}::uuid,
             ${patient.id}::uuid, ${southRoom.id}::uuid,
             '2026-09-14T13:00:00Z', '2026-09-14T13:20:00Z',
             'PHONE'::booking_channel, now())
        `,
      ).rejects.toThrowError(/agenda_entry_room_in_site/);
    });

    it('OR-021 la misma clave foránea deja pasar la cita sin consultorio y la del consultorio correcto', async () => {
      // `MATCH SIMPLE` with a nullable `room_id`: a block occupies no room, and
      // refusing it would have been the wrong fix.
      const site = await createSite();
      const room = await createRoom(site.id, 'Consultorio 1');

      await bookInto(site.id, undefined, 13);
      await expect(bookInto(site.id, room.id, 14)).resolves.toMatchObject({
        roomId: room.id,
        siteId: site.id,
      });
    });

    it('OR-022 un consultorio desactivado sale del listado por defecto y conserva sus citas', async () => {
      const site = await createSite();
      const room = await createRoom(site.id, 'Consultorio 1');
      const appointment = await bookInto(site.id, room.id);

      await patch(`/rooms/${room.id}`, { active: false }).expect(200);

      const byDefault = await get(`/sites/${site.id}/rooms`).expect(200);
      const everything = await get(
        `/sites/${site.id}/rooms?includeInactive=true`,
      ).expect(200);
      const idsOf = (body: unknown) =>
        (body as { items: { id: string }[] }).items.map((item) => item.id);

      expect(idsOf(byDefault.body)).not.toContain(room.id);
      expect(idsOf(everything.body)).toContain(room.id);
      expect(
        await prisma.agendaEntry.findUniqueOrThrow({
          where: { id: appointment.id },
        }),
      ).toMatchObject({ roomId: room.id });
    });

    it('OR-022 rechaza borrar un consultorio con citas con SITE_ROOM_IN_USE y ofrece desactivarlo', async () => {
      const site = await createSite();
      const room = await createRoom(site.id, 'Consultorio 1');
      await bookInto(site.id, room.id);

      const response = await destroy(`/rooms/${room.id}`).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SITE_ROOM_IN_USE');
      expect(problem.title).toContain('desactivarlo');
    });

    it('OR-026 deja en la bitácora toda mutación de consultorios, con autor', async () => {
      const site = await createSite();
      const room = await createRoom(site.id, 'Consultorio 1');
      await patch(`/rooms/${room.id}`, { name: 'Consultorio A' }).expect(200);
      await destroy(`/rooms/${room.id}`).expect(204);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'organization', resourceId: room.id },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual([
        'CREATE',
        'UPDATE',
        'UPDATE',
      ]);
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
    });
  });

  describe('los puntos de emisión', () => {
    it('OR-023 mantiene los puntos de emisión del SRI por sede, con su código de tres dígitos', async () => {
      const site = await createSite();

      await post(`/sites/${site.id}/emission-points`, {
        code: '001',
        description: 'Caja principal',
      }).expect(201);

      const response = await get(`/sites/${site.id}/emission-points`).expect(200); // prettier-ignore
      expect((response.body as { items: unknown[] }).items).toEqual([
        expect.objectContaining({ code: '001', description: 'Caja principal' }),
      ]);
    });

    it('OR-023 rechaza un código que no son exactamente tres dígitos', async () => {
      const site = await createSite();

      for (const code of ['1', '0001', 'abc']) {
        const response = await post(`/sites/${site.id}/emission-points`, {
          code,
        }).expect(422);
        expect((response.body as Problem).errors?.[0]?.field).toBe('code');
      }
    });

    it('OR-024 rechaza con EMISSION_POINT_DUPLICATE dos puntos con el mismo código en la sede', async () => {
      const site = await createSite();
      await post(`/sites/${site.id}/emission-points`, { code: '001' }).expect(201); // prettier-ignore

      const response = await post(`/sites/${site.id}/emission-points`, {
        code: '001',
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('EMISSION_POINT_DUPLICATE');
      expect(problem.errors?.[0]?.field).toBe('code');
    });

    it('OR-024 el mismo código en OTRA sede sí se admite: la unicidad es por sede', async () => {
      const north = await createSite();
      const south = await createSite();
      await post(`/sites/${north.id}/emission-points`, { code: '001' }).expect(201); // prettier-ignore

      await post(`/sites/${south.id}/emission-points`, { code: '001' }).expect(201); // prettier-ignore
    });

    it('OR-025 expone RUC y punto de emisión como DATO, sin numerar ningún comprobante', async () => {
      await saveEstablishment({ ruc: VALID_RUC });
      const site = await createSite({ ruc: VALID_RUC });
      await post(`/sites/${site.id}/emission-points`, { code: '001' }).expect(201); // prettier-ignore

      const establishment = await get('/establishment').expect(200);
      const points = await get(`/sites/${site.id}/emission-points`).expect(200);

      expect((establishment.body as { ruc: string }).ruc).toBe(VALID_RUC);
      const item = (points.body as { items: Record<string, unknown>[] }).items[0]; // prettier-ignore
      expect(item).toMatchObject({ code: '001', siteId: site.id });
      // The ABSENCE is the requirement: nothing here numbers a comprobante.
      // That is billing's business (REQ-085), and this module must not have
      // grown a sequential behind its back.
      expect(Object.keys(item ?? {}).join(',')).not.toMatch(/sequen|numer/i);
    });

    it('OR-026 deja en la bitácora toda mutación de puntos de emisión, con autor', async () => {
      const site = await createSite();
      const created = await post(`/sites/${site.id}/emission-points`, {
        code: '001',
      }).expect(201);
      const pointId = (created.body as { id: string }).id;
      await patch(`/emission-points/${pointId}`, { active: false }).expect(200);
      await destroy(`/emission-points/${pointId}`).expect(204);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'organization', resourceId: pointId },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual([
        'CREATE',
        'UPDATE',
        'UPDATE',
      ]);
      expect(trail.every((row) => row.userId === adminUserId)).toBe(true);
    });
  });

  describe('los permisos (D-002, ADR-011)', () => {
    it('OR-005 exige el permiso de administración: RECEPCION no puede crear una sede', async () => {
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '0926687856'); // prettier-ignore

      const response = await post(
        '/sites',
        { mspUnicode: nextMspCode(), name: 'Sede clandestina' },
        recepcion,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
      expect(await prisma.site.count()).toBe(0);
    });

    it('OR-004 RECEPCION sí puede LEER las sedes: sin ellas no puede agendar', async () => {
      await createSite({ name: 'Sede Norte' });
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '0926687856'); // prettier-ignore

      const response = await get('/sites', recepcion).expect(200);

      expect((response.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('OR-023 RECEPCION no puede crear un punto de emisión', async () => {
      const site = await createSite();
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '0926687856'); // prettier-ignore

      const response = await post(
        `/sites/${site.id}/emission-points`,
        { code: '002' },
        recepcion,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('el alcance por sede (ADR-007)', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA DIMENSIÓN QUE PRODUCE ACCESO INDEBIDO EN UNA CLÍNICA MULTISEDE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `PATCH`/`DELETE` de consultorios y de puntos de emisión se declaraban
     * `global` con esta justificación: «un permiso de administración que
     * DEFAULT_ROLES concede a nivel de clínica y a un solo rol». Los roles son
     * DATO —`ReplaceGrantsDto` existe justamente para concederlos POR SEDE—,
     * así que una clínica que crea «Administrador de sede» y lo acota a una
     * ciudad obtenía un rol capaz de renombrar y borrar los consultorios de
     * otra. `POST /sites/:siteId/rooms`, sobre el mismo recurso, sí lo
     * impedía: la incoherencia era la pista.
     *
     * `route-authorisation.spec.ts` no lo veía y no podía verlo: comprueba que
     * la declaración EXISTA, no que sea la correcta.
     */
    const SEDE_ADMIN_EMAIL = 'admin.norte@clinica.ec';
    const SEDE_ADMIN_CEDULA = '1804822136';

    /** Norte y Sur, y una administradora que sólo administra Norte. */
    async function twoSites() {
      const norte = await createSite({ name: 'Sede Norte' });
      const sur = await createSite({ name: 'Sede Sur' });
      const scoped = await signIn(
        SEDE_ADMIN_EMAIL,
        'ADMIN',
        SEDE_ADMIN_CEDULA,
        norte.id,
      );
      return { norte, sur, scoped };
    }

    it('OR-026 quien administra Norte no puede renombrar un consultorio de Sur', async () => {
      const { sur, scoped } = await twoSites();
      const room = await createRoom(sur.id, 'Consultorio ajeno');

      const response = await patch(
        `/rooms/${room.id}`,
        { name: 'Renombrado a distancia' },
        scoped,
      ).expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      // Y no se escribió nada: el nombre sigue siendo el suyo.
      expect(
        await prisma.siteRoom.findUniqueOrThrow({ where: { id: room.id } }),
      ).toMatchObject({ name: 'Consultorio ajeno' });
    });

    it('OR-022 tampoco puede borrarlo', async () => {
      const { sur, scoped } = await twoSites();
      const room = await createRoom(sur.id, 'Consultorio ajeno');

      const response = await destroy(`/rooms/${room.id}`, scoped).expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      expect(
        await prisma.siteRoom.findUnique({ where: { id: room.id } }),
      ).not.toBeNull();
    });

    it('OR-026 sí puede con los consultorios de SU sede: la comprobación no es un muro', async () => {
      const { norte, scoped } = await twoSites();
      const room = await createRoom(norte.id, 'Consultorio propio');

      await patch(`/rooms/${room.id}`, { name: 'Consultorio 2' }, scoped).expect(200); // prettier-ignore
      await destroy(`/rooms/${room.id}`, scoped).expect(204);
    });

    it('OR-026 no puede editar ni borrar un punto de emisión de otra sede', async () => {
      const { sur, scoped } = await twoSites();
      const created = await post(`/sites/${sur.id}/emission-points`, {
        code: '001',
      }).expect(201);
      const pointId = (created.body as { id: string }).id;

      const edited = await patch(
        `/emission-points/${pointId}`,
        { active: false },
        scoped,
      ).expect(403);
      const deleted = await destroy(`/emission-points/${pointId}`, scoped).expect(403); // prettier-ignore

      expect((edited.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      expect((deleted.body as Problem).code).toBe('SITE_SCOPE_DENIED');
      expect(
        await prisma.emissionPoint.findUniqueOrThrow({
          where: { id: pointId },
        }),
      ).toMatchObject({ active: true });
    });

    it('OR-007 el listado de sedes muestra las suyas y no las de la otra ciudad', async () => {
      const { norte, sur, scoped } = await twoSites();

      const response = await get('/sites', scoped).expect(200);

      const ids = (response.body as { items: { id: string }[] }).items.map(
        (item) => item.id,
      );
      expect(ids).toEqual([norte.id]);
      expect(ids).not.toContain(sur.id);
      // Y la ruta por id sigue negando la sede ajena, como ya hacía.
      await get(`/sites/${sur.id}`, scoped).expect(403);
    });

    it('OR-004 una concesión sin sede sigue viendo todas: acotar no es romper', async () => {
      await twoSites();

      const response = await get('/sites').expect(200);

      expect((response.body as { items: unknown[] }).items).toHaveLength(2);
    });
  });

  describe('el RUC y quién puede verlo (OR-025)', () => {
    /**
     * Los diez primeros dígitos de un RUC de persona natural SON la cédula de
     * su titular, dígito verificador incluido — `ruc.vo.ts` lo documenta al
     * explicar por qué `InvalidRucError` no incluye el valor que rechaza. En
     * una clínica de un solo profesional registrada con el RUC de su dueño,
     * servirlo bajo `site:read` entrega su documento de identidad a recepción,
     * a enfermería y a cualquier rol clínico. El RUC es para facturar
     * (OR-025); agendar una cita no es facturar.
     */
    const NATURAL_PERSON_RUC = '1710034065001';

    it('OR-025 RECEPCION no recibe el RUC de la sede ni el del establecimiento', async () => {
      await saveEstablishment({ ruc: NATURAL_PERSON_RUC });
      const site = await createSite({ ruc: NATURAL_PERSON_RUC });
      const recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '0926687856'); // prettier-ignore

      const establishment = await get('/establishment', recepcion).expect(200);
      const sites = await get('/sites', recepcion).expect(200);
      const one = await get(`/sites/${site.id}`, recepcion).expect(200);

      const listed = (sites.body as { items: Record<string, unknown>[] }).items[0]; // prettier-ignore
      // AUSENTE, no `null`: `null` significa «esta sede no tiene RUC», que es
      // un estado real sobre el que una pantalla actúa.
      expect(establishment.body).not.toHaveProperty('ruc');
      expect(listed).not.toHaveProperty('ruc');
      expect(one.body).not.toHaveProperty('ruc');
      // Y el resto de la sede sigue viajando: sin ella no se puede agendar.
      expect(one.body).toMatchObject({ id: site.id, name: expect.any(String) });
      expect(JSON.stringify(sites.body)).not.toContain(NATURAL_PERSON_RUC);
    });

    it('OR-025 quien administra sedes sí lo recibe: es dato de facturación', async () => {
      await saveEstablishment({ ruc: NATURAL_PERSON_RUC });
      const site = await createSite({ ruc: NATURAL_PERSON_RUC });

      const establishment = await get('/establishment').expect(200);
      const one = await get(`/sites/${site.id}`).expect(200);

      expect((establishment.body as { ruc: string }).ruc).toBe(NATURAL_PERSON_RUC); // prettier-ignore
      expect((one.body as { ruc: string }).ruc).toBe(NATURAL_PERSON_RUC);
    });
  });

  describe('la semilla de desarrollo', () => {
    it('OR-004 enlaza las sedes existentes al establecimiento y es idempotente', async () => {
      // A site created BEFORE the seed, with no establishment: the backfill the
      // nullable column exists for.
      const orphan = await prisma.site.create({
        data: { mspUnicode: 'MSP-ORPHAN', name: 'Sede huérfana' },
      });

      const first = await seedOrganization(prisma);
      expect(first.establishmentCreated).toBe(true);
      expect(first.sitesBackfilled).toBe(1);
      // No site was invented: there already was one.
      expect(first.sitesCreated).toBe(0);

      const adopted = await prisma.site.findUniqueOrThrow({
        where: { id: orphan.id },
        select: { establishmentId: true },
      });
      expect(adopted.establishmentId).not.toBeNull();

      const second = await seedOrganization(prisma);
      expect(second.establishmentCreated).toBe(false);
      expect(second.sitesBackfilled).toBe(0);
      expect(second.roomsCreated).toBe(0);
      expect(second.emissionPointsCreated).toBe(0);
      expect(await prisma.establishment.count()).toBe(1);
    });

    it('OR-023 la semilla deja un punto de emisión 001 por sede y consultorios donde probar', async () => {
      const result = await seedOrganization(prisma);

      // Nothing existed, so the seed created the one site the screens need.
      expect(result.sitesCreated).toBe(1);
      expect(result.emissionPointsCreated).toBe(1);
      expect(result.roomsCreated).toBeGreaterThan(0);
      expect(
        await prisma.emissionPoint.findFirstOrThrow({ select: { code: true } }),
      ).toEqual({ code: '001' });
    });
  });
});
