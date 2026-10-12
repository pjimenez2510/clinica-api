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
import {
  type ClinicalDate,
  clinicalDateOf,
  clinicalDayBounds,
} from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createRoom,
  createSite,
  createUser,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The day board as the browser reaches it (E9): two projections under two
 * permissions with REAL sessions of the seeded roles, the view of each role,
 * the note, and the trail — against PostgreSQL, because the closed union of
 * fields, the note's stamp and the single audit row are the base's to prove.
 *
 * NO DATE IS WRITTEN BY HAND. Today is the clinical date of the application's
 * clock, and every instant is that day's midnight in Guayaquil plus some
 * minutes, so the rows are today's whatever the hour the suite runs at.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
}

interface StaffRow {
  id: string;
  kind: string;
  status: string;
  patientName: string | null;
  practitionerName: string | null;
  roomName: string | null;
  boardNote: string | null;
  boardNoteStamp: { byName: string; at: string } | null;
  stateSince: string | null;
  minutesInState: number | null;
  latenessMinutes: number | null;
  emergencyNeedsInPersonNotice: boolean;
  boardNoteEditable: boolean;
}

interface StaffBoard {
  fields: string[];
  generatedAt: string;
  items: StaffRow[];
}

interface PublicBoard {
  date: string;
  items: Record<string, unknown>[];
}

const MINUTE = 60_000;

describe('el tablero del día por HTTP (E9)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let otherSiteId: string;
  let practitionerId: string;
  let otherPractitionerId: string;
  let roomId: string;
  let today: ClinicalDate;
  let dayStart: Date;

  let receptionToken: string;
  let nurseToken: string;
  let screenToken: string;
  let adminToken: string;

  let cedulaSeed = 0;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
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

    // `useDatabase` truncates between tests: the roles, their permissions and
    // their starting board views are written again, by the same sync the
    // deploy runs (so the views of a fresh install are what is under test).
    await syncAuthorisation(prisma);
    registry.invalidate();

    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    siteId = site.id;
    otherSiteId = otherSite.id;
    practitionerId = (await createPractitioner(prisma)).id;
    otherPractitionerId = (await createPractitioner(prisma)).id;
    await linkPractitionerToSite(prisma, practitionerId, siteId);
    await linkPractitionerToSite(prisma, otherPractitionerId, siteId);
    roomId = (await createRoom(prisma, siteId)).id;

    today = clinicalDateOf(new Date());
    dayStart = clinicalDayBounds(today).startsAt;

    receptionToken = await signIn('RECEPCION', 'recepcion@clinica.ec');
    nurseToken = await signIn('ENFERMERIA', 'enfermeria@clinica.ec');
    screenToken = await signIn('PANTALLA_SALA', 'sala@clinica.ec');
    adminToken = await signIn('ADMIN', 'admin@clinica.ec');
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** A synthetic cedula with its check digit computed, never a real person's. */
  function syntheticCedula(): string {
    cedulaSeed += 1;
    const base = `17${String(1_000_000 + cedulaSeed).slice(-7)}`;
    let sum = 0;
    for (let i = 0; i < 9; i += 1) {
      const doubled = Number(base[i]) * (i % 2 === 0 ? 2 : 1);
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
    return `${base}${(10 - (sum % 10)) % 10}`;
  }

  async function signIn(
    roleCode: string,
    email: string,
    extra: { roleCode: string; siteId: string }[] = [],
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Luis',
        lastName: 'Paredes',
        cedula: syntheticCedula(),
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
    });
    for (const grant of extra) {
      const other = await prisma.role.findUniqueOrThrow({
        where: { code: grant.roleCode },
      });
      await prisma.userRoleGrant.create({
        data: { userId: user.id, roleId: other.id, siteId: grant.siteId },
      });
    }
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);
  const put = (path: string, token: string, body: object) =>
    request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const at = (minutes: number) =>
    new Date(dayStart.getTime() + minutes * MINUTE);

  /** An appointment of today, `minutes` after midnight in Guayaquil. */
  async function appointment(
    minutes: number,
    overrides: {
      status?: 'BOOKED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'NO_SHOW';
      subjectStatus?: 'ARRIVED' | 'IN_PREPARATION' | 'ON_LEAVE';
      practitionerId?: string;
      siteId?: string;
      givenName?: string;
      familyName?: string;
      boardNote?: string;
      /** In the site's room; off by default so two rows never share it. */
      withRoom?: boolean;
    } = {},
  ) {
    const patient = await createPatient(prisma);
    if (overrides.givenName || overrides.familyName) {
      await prisma.patient.update({
        where: { id: patient.id },
        data: {
          givenName: overrides.givenName ?? patient.givenName,
          familyName: overrides.familyName ?? patient.familyName,
        },
      });
    }
    const status = overrides.status ?? 'BOOKED';
    const arrived = status === 'CHECKED_IN' || status === 'IN_PROGRESS';
    const assessor = arrived ? (await createUser(prisma)).id : null;
    const entry = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: overrides.siteId ?? siteId,
        practitionerId: overrides.practitionerId ?? practitionerId,
        roomId: overrides.withRoom ? roomId : null,
        patientId: patient.id,
        startsAt: at(minutes),
        endsAt: at(minutes + 20),
        status,
        bookingChannel: 'PHONE',
        boardNote: overrides.boardNote ?? null,
        ...(arrived
          ? {
              checkedInAt: at(minutes - 5),
              subjectStatus: overrides.subjectStatus ?? 'ARRIVED',
              subjectStatusAt: at(minutes - 5),
              emergencyAssessedAt: at(minutes - 5),
              emergencyAssessedById: assessor,
            }
          : {}),
      },
    });
    await prisma.agendaStatusHistory.create({
      data: {
        agendaEntryId: entry.id,
        fromStatus: null,
        toStatus: status,
        changedAt: at(minutes - 60),
      },
    });
    return entry;
  }

  describe('AG-138 el esquema de las vistas', () => {
    it('AG-138 la base rechaza un campo fuera de la unión cerrada y admite uno de ella', async () => {
      const role = await prisma.role.create({
        data: { code: 'PRUEBA_VISTA', name: 'Prueba de vista' },
      });

      // Control positivo: un campo del catálogo entra.
      await expect(
        prisma.boardViewField.create({
          data: { roleId: role.id, field: 'ROOM', createdAt: new Date() },
        }),
      ).resolves.toBeDefined();

      await expect(
        prisma.boardViewField.create({
          data: { roleId: role.id, field: 'DIAGNOSIS', createdAt: new Date() },
        }),
      ).rejects.toThrow(/board_view_field_known_field/);
    });

    it('AG-138 la sincronización deja a cada rol de fábrica su vista de arranque', async () => {
      const views = await prisma.boardViewField.findMany({
        select: { field: true, role: { select: { code: true } } },
      });
      const of = (code: string) =>
        views
          .filter((view) => view.role.code === code)
          .map((view) => view.field)
          .sort();

      expect(of('RECEPCION')).toEqual(
        [
          'BOARD_NOTE',
          'LATENESS',
          'PRACTITIONER',
          'ROOM',
          'TIME_IN_STATE',
        ].sort(),
      );
      expect(of('ENFERMERIA')).toEqual(['BOARD_NOTE', 'ROOM', 'TIME_IN_STATE']);
      expect(of('MEDICO')).toEqual([
        'BOARD_NOTE',
        'LATENESS',
        'ROOM',
        'TIME_IN_STATE',
      ]);
      expect(of('PANTALLA_SALA')).toEqual([]);
    });
  });

  describe('AG-138 AG-176 las demás garantías de la migración', () => {
    it('AG-176 la base exige que la nota diga quién y cuándo, los dos o ninguno', async () => {
      const entry = await appointment(9 * 60);
      const writer = await createUser(prisma);

      // Control positivo: el par completo entra, y ninguno de los dos también.
      await prisma.agendaEntry.update({
        where: { id: entry.id },
        data: {
          boardNote: 'Algo',
          boardNoteById: writer.id,
          boardNoteAt: new Date(),
        },
      });
      await expect(
        prisma.agendaEntry.update({
          where: { id: entry.id },
          data: { boardNoteById: null },
        }),
      ).rejects.toThrow(/agenda_entry_board_note_stamped/);
      await expect(
        prisma.agendaEntry.update({
          where: { id: entry.id },
          data: { boardNoteAt: null },
        }),
      ).rejects.toThrow(/agenda_entry_board_note_stamped/);
    });

    it('AG-176 quien escribió una nota no se borra de la base (RESTRICT)', async () => {
      const entry = await appointment(9 * 60);
      const writer = await createUser(prisma);
      const bystander = await createUser(prisma);
      await prisma.agendaEntry.update({
        where: { id: entry.id },
        data: {
          boardNote: 'Algo',
          boardNoteById: writer.id,
          boardNoteAt: new Date(),
        },
      });

      // Control positivo: una cuenta sin notas se borra.
      await prisma.user.delete({ where: { id: bystander.id } });
      await expect(
        prisma.user.delete({ where: { id: writer.id } }),
      ).rejects.toThrow();
    });

    it('AG-138 la vista es del rol: un rol sin usar se borra con ella, y un campo no se repite', async () => {
      const role = await prisma.role.create({
        data: { code: 'PRUEBA_CASCADA', name: 'Prueba de cascada' },
      });
      const author = await createUser(prisma);
      await prisma.boardViewField.create({
        data: {
          roleId: role.id,
          field: 'ROOM',
          createdAt: new Date(),
          createdById: author.id,
        },
      });

      await expect(
        prisma.boardViewField.create({
          data: { roleId: role.id, field: 'ROOM', createdAt: new Date() },
        }),
      ).rejects.toThrow();
      // Quien la configuró no se borra mientras la fila exista (RESTRICT).
      await expect(
        prisma.user.delete({ where: { id: author.id } }),
      ).rejects.toThrow();

      await prisma.role.delete({ where: { id: role.id } });
      expect(
        await prisma.boardViewField.count({ where: { roleId: role.id } }),
      ).toBe(0);
    });

    it('AG-162 AG-176 corregir el paciente de la cita vacía la nota, que era del otro', async () => {
      const entry = await appointment(11 * 60, {
        boardNote: 'Viene con su hija',
      });
      const other = await createPatient(prisma);
      const untouched = await appointment(12 * 60, { boardNote: 'Se queda' });

      // Control positivo: cambiar sólo el canal no toca la nota.
      await request(app.getHttpServer())
        .patch(`/api/v1/agenda/sites/${siteId}/entries/${untouched.id}`)
        .set('Authorization', `Bearer ${receptionToken}`)
        .send({ bookingChannel: 'WALK_IN' })
        .expect(200);
      expect(
        (
          await prisma.agendaEntry.findUniqueOrThrow({
            where: { id: untouched.id },
          })
        ).boardNote,
      ).toBe('Se queda');

      await request(app.getHttpServer())
        .patch(`/api/v1/agenda/sites/${siteId}/entries/${entry.id}`)
        .set('Authorization', `Bearer ${receptionToken}`)
        .send({ patientId: other.id })
        .expect(200);

      const after = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(after.patientId).toBe(other.id);
      expect(after.boardNote).toBeNull();
      expect(after.boardNoteById).not.toBeNull();
    });

    it('AG-138 dos administradores guardando a la vez la misma vista: gana el último, sin error', async () => {
      const nursing = await prisma.role.findUniqueOrThrow({
        where: { code: 'ENFERMERIA' },
      });

      const [first, second] = await Promise.all([
        put(`/agenda/board-views/${nursing.id}`, adminToken, {
          fields: ['ROOM'],
        }),
        put(`/agenda/board-views/${nursing.id}`, adminToken, {
          fields: ['BOARD_NOTE'],
        }),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      const stored = await prisma.boardViewField.findMany({
        where: { roleId: nursing.id },
      });
      expect(stored).toHaveLength(1);
    });
  });

  describe('AG-133 a AG-135 el tablero del personal', () => {
    it('AG-133 sólo citas de la sede y del día, por hora, con las liberadas dentro', async () => {
      const late = await appointment(11 * 60);
      const early = await appointment(9 * 60, { status: 'CHECKED_IN' });
      const absent = await appointment(8 * 60, { status: 'NO_SHOW' });
      await prisma.agendaEntry.update({
        where: { id: absent.id },
        data: { releasedAt: at(8 * 60 + 30) },
      });
      await appointment(10 * 60, { siteId: otherSiteId, practitionerId: otherPractitionerId }); // prettier-ignore
      await prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          siteId,
          practitionerId: otherPractitionerId,
          startsAt: at(7 * 60),
          endsAt: at(8 * 60),
          status: 'BLOCKED',
          reason: 'Reunión',
        },
      });

      const response = await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken).expect(200); // prettier-ignore
      const board = response.body as StaffBoard;

      expect(board.items.map((row) => row.id)).toEqual([
        absent.id,
        early.id,
        late.id,
      ]);
      expect(board.items.every((row) => row.kind === 'APPOINTMENT')).toBe(true);
    });

    it('AG-133 la especialidad acota por los profesionales que la ejercen', async () => {
      const specialty = await prisma.specialty.create({
        data: { code: 'CARD', name: 'Cardiología' },
      });
      await prisma.practitionerSpecialty.create({
        data: { practitionerId, specialtyId: specialty.id, isPrimary: true },
      });
      const theirs = await appointment(9 * 60);
      await appointment(9 * 60, { practitionerId: otherPractitionerId });

      const response = await get(`/agenda/sites/${siteId}/board?date=${today}&specialtyId=${specialty.id}`, receptionToken).expect(200); // prettier-ignore

      expect((response.body as StaffBoard).items.map((row) => row.id)).toEqual([theirs.id]); // prettier-ignore
    });

    it('AG-134 AG-135 la fila trae nombres, nota y el tiempo calculado en el servidor', async () => {
      const entry = await appointment(9 * 60, {
        status: 'CHECKED_IN',
        boardNote: 'Espera a su hija',
        withRoom: true,
      });

      const before = Date.now();
      const response = await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken).expect(200); // prettier-ignore
      const row = (response.body as StaffBoard).items.find((item) => item.id === entry.id); // prettier-ignore

      expect(row?.practitionerName).toBe('Ana Villacís');
      expect(row?.roomName).not.toBeNull();
      expect(row?.boardNote).toBe('Espera a su hija');
      // The patient's axis wins over the appointment's (AG-135).
      expect(row?.stateSince).toBe(at(9 * 60 - 5).toISOString());
      const expected = Math.floor((before - at(9 * 60 - 5).getTime()) / MINUTE);
      expect(row?.minutesInState).toBeGreaterThanOrEqual(Math.max(0, expected));
      expect(row?.minutesInState).toBeLessThanOrEqual(
        Math.max(0, expected) + 1,
      );
    });

    it('AG-138 dos roles reciben conjuntos de campos distintos sobre la misma fila', async () => {
      await appointment(9 * 60, { status: 'CHECKED_IN', boardNote: 'Silla de ruedas' }); // prettier-ignore

      const reception = (await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken).expect(200)).body as StaffBoard; // prettier-ignore
      const nursing = (await get(`/agenda/sites/${siteId}/board?date=${today}`, nurseToken).expect(200)).body as StaffBoard; // prettier-ignore

      expect(reception.fields).toEqual(['PRACTITIONER', 'ROOM', 'TIME_IN_STATE', 'LATENESS', 'BOARD_NOTE']); // prettier-ignore
      expect(nursing.fields).toEqual(['ROOM', 'TIME_IN_STATE', 'BOARD_NOTE']);
      expect(reception.items[0]?.practitionerName).toBe('Ana Villacís');
      expect(nursing.items[0]?.practitionerName).toBeNull();
      expect(nursing.items[0]?.boardNote).toBe('Silla de ruedas');
    });
  });

  describe('AG-138 la vista sale de los roles de ESTA sede', () => {
    it('AG-138 un rol concedido en otra sede no cambia el tablero de ésta; dos en la misma suman', async () => {
      await appointment(9 * 60, { status: 'CHECKED_IN' });
      await appointment(9 * 60, { status: 'CHECKED_IN', siteId: otherSiteId, practitionerId: otherPractitionerId }); // prettier-ignore
      // ENFERMERIA aquí y RECEPCION sólo en la otra sede.
      const token = await signIn('ENFERMERIA', 'doble@clinica.ec', [
        { roleCode: 'RECEPCION', siteId: otherSiteId },
      ]);

      const here = (await get(`/agenda/sites/${siteId}/board?date=${today}`, token).expect(200)).body as StaffBoard; // prettier-ignore
      expect(here.fields).toEqual(['ROOM', 'TIME_IN_STATE', 'BOARD_NOTE']);

      // Control positivo: en la otra sede manda recepción, y se suman.
      await prisma.userRoleGrant.create({
        data: {
          userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'doble@clinica.ec' } })).id, // prettier-ignore
          roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'ENFERMERIA' } })).id, // prettier-ignore
          siteId: otherSiteId,
        },
      });
      registry.invalidate();
      const there = (await get(`/agenda/sites/${otherSiteId}/board?date=${today}`, token).expect(200)).body as StaffBoard; // prettier-ignore
      expect(there.fields).toEqual(['PRACTITIONER', 'ROOM', 'TIME_IN_STATE', 'LATENESS', 'BOARD_NOTE']); // prettier-ignore
    });

    it('AG-133 el filtro de profesional deja sólo sus citas', async () => {
      const theirs = await appointment(9 * 60);
      await appointment(9 * 60, { practitionerId: otherPractitionerId });

      const response = await get(`/agenda/sites/${siteId}/board?date=${today}&practitionerId=${practitionerId}`, receptionToken).expect(200); // prettier-ignore

      expect((response.body as StaffBoard).items.map((row) => row.id)).toEqual([theirs.id]); // prettier-ignore
    });
  });

  describe('AG-136 AG-137 la pantalla de la sala', () => {
    it('AG-137 sólo los presentes, con primer nombre e inicial, y ningún dato de la ficha', async () => {
      await appointment(9 * 60, {
        status: 'CHECKED_IN',
        givenName: 'Rosa Elena',
        familyName: 'Andrade López',
        boardNote: 'No debe salir',
      });
      await appointment(10 * 60, { status: 'IN_PROGRESS', subjectStatus: 'IN_PREPARATION', givenName: 'Pedro', familyName: 'Cevallos' }); // prettier-ignore
      await appointment(10 * 60 + 30, { status: 'IN_PROGRESS', subjectStatus: 'ON_LEAVE', givenName: 'Fuera', familyName: 'Zambrano' }); // prettier-ignore
      await appointment(11 * 60, { givenName: 'Aún', familyName: 'Nollega' });
      await appointment(11 * 60, { status: 'CHECKED_IN', siteId: otherSiteId, practitionerId: otherPractitionerId, givenName: 'Otra', familyName: 'Sede' }); // prettier-ignore
      const released = await appointment(12 * 60, { status: 'CHECKED_IN', givenName: 'Liberada', familyName: 'Ya' }); // prettier-ignore
      await prisma.agendaEntry.update({
        where: { id: released.id },
        data: { releasedAt: at(12 * 60 + 10) },
      });

      const response = await get(`/agenda/sites/${siteId}/board/public`, screenToken).expect(200); // prettier-ignore
      const board = response.body as PublicBoard;

      expect(board.date).toBe(today);
      expect(board.items.map((row) => row.displayName)).toEqual(['Rosa A.', 'Pedro C.']); // prettier-ignore
      expect(board.items.map((row) => row.state)).toEqual(['WAITING', 'IN_PREPARATION']); // prettier-ignore
      for (const row of board.items) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'displayName',
            'practitionerName',
            'roomName',
            'startsAt',
            'state',
          ].sort(),
        );
      }
      expect(JSON.stringify(board)).not.toContain('No debe salir');
      expect(JSON.stringify(board)).not.toContain('Andrade López');
    });

    it('AG-136 la sesión de la sala no alcanza el tablero del personal', async () => {
      // Control positivo: la misma sesión SÍ lee su proyección.
      await get(`/agenda/sites/${siteId}/board/public`, screenToken).expect(
        200,
      );

      const refused = await get(`/agenda/sites/${siteId}/board?date=${today}`, screenToken).expect(403); // prettier-ignore
      expect((refused.body as Problem).status).toBe(403);
    });

    it('AG-136 el personal sin el permiso de la sala no lee su proyección', async () => {
      await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken).expect(200); // prettier-ignore

      await get(`/agenda/sites/${siteId}/board/public`, receptionToken).expect(
        403,
      );
    });

    it('AG-136 la sala tiene su lista de sedes, acotada a su alcance', async () => {
      const response = await get('/agenda/board/public/sites', screenToken).expect(200); // prettier-ignore

      expect((response.body as { items: { id: string }[] }).items.map((site) => site.id)).toEqual([siteId]); // prettier-ignore
      await get(`/agenda/sites/${otherSiteId}/board/public`, screenToken).expect(403); // prettier-ignore
    });
  });

  describe('AG-139 una fila de bitácora por consulta', () => {
    it('AG-139 una consulta con varias citas deja UNA fila, con la proyección y desde dónde', async () => {
      await appointment(8 * 60, { status: 'CHECKED_IN' });
      await appointment(9 * 60, { status: 'CHECKED_IN' });
      await appointment(10 * 60, { status: 'CHECKED_IN' });

      await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken)
        .set('User-Agent', 'monitor-de-recepcion')
        .expect(200);
      await get(`/agenda/sites/${siteId}/board/public`, screenToken).expect(
        200,
      );

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: { startsWith: 'agenda_board' } },
        orderBy: { id: 'asc' },
      });
      expect(
        trail.map((row) => [row.resourceType, row.resourceId, row.action]),
      ).toEqual([
        ['agenda_board_staff', siteId, 'READ'],
        ['agenda_board_public', siteId, 'READ'],
      ]);
      expect(trail[0]?.userAgent).toBe('monitor-de-recepcion');
      expect(trail[0]?.ip).not.toBeNull();
    });
  });

  describe('AG-176 la nota corta', () => {
    it('AG-176 enfermería la escribe sin agenda:write y no toca nada más de la cita', async () => {
      const entry = await appointment(9 * 60, { status: 'CHECKED_IN' });
      const before = await prisma.agendaEntry.findUniqueOrThrow({ where: { id: entry.id } }); // prettier-ignore

      const response = await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, nurseToken, { boardNote: '  Pasa a curación ' }).expect(200); // prettier-ignore

      expect(response.body).toMatchObject({
        boardNote: 'Pasa a curación',
        boardNoteStamp: { byName: 'Luis Paredes' },
      });
      const after = await prisma.agendaEntry.findUniqueOrThrow({ where: { id: entry.id } }); // prettier-ignore
      expect(after.boardNote).toBe('Pasa a curación');
      expect(after.boardNoteById).not.toBeNull();
      expect(after.boardNoteAt).not.toBeNull();
      // Everything else is untouched. `updatedAt` is Prisma's own
      // `@updatedAt`, bumped by any write, so it is left out with the note.
      const untouched = (row: typeof before) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !key.startsWith('boardNote') && key !== 'updatedAt',
          ),
        );
      expect(untouched(after)).toEqual(untouched(before));
      // Annotating is not editing: no version of the appointment was archived.
      expect(await prisma.recordVersion.count({ where: { resourceId: entry.id } })).toBe(0); // prettier-ignore
    });

    it('AG-176 en blanco la vacía y deja quién la vació', async () => {
      const entry = await appointment(9 * 60, { boardNote: 'Algo' });

      await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, receptionToken, { boardNote: '   ' }).expect(200); // prettier-ignore

      const after = await prisma.agendaEntry.findUniqueOrThrow({ where: { id: entry.id } }); // prettier-ignore
      expect(after.boardNote).toBeNull();
      expect(after.boardNoteById).not.toBeNull();
    });

    it('AG-176 sobre un bloqueo se rechaza con BOARD_NOTE_NEEDS_A_PATIENT', async () => {
      const ok = await appointment(9 * 60);
      await put(`/agenda/sites/${siteId}/entries/${ok.id}/board-note`, nurseToken, { boardNote: 'Control' }).expect(200); // prettier-ignore

      const block = await prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          siteId,
          practitionerId: otherPractitionerId,
          startsAt: at(7 * 60),
          endsAt: at(8 * 60),
          status: 'BLOCKED',
        },
      });
      const refused = await put(`/agenda/sites/${siteId}/entries/${block.id}/board-note`, nurseToken, { boardNote: 'No' }).expect(409); // prettier-ignore

      expect((refused.body as Problem).code).toBe('BOARD_NOTE_NEEDS_A_PATIENT');
    });

    it('AG-176 la cita de otra sede no existe para esta ruta, y la sala no escribe notas', async () => {
      const elsewhere = await appointment(9 * 60, { siteId: otherSiteId, practitionerId: otherPractitionerId }); // prettier-ignore

      const missing = await put(`/agenda/sites/${siteId}/entries/${elsewhere.id}/board-note`, nurseToken, { boardNote: 'X' }).expect(404); // prettier-ignore
      expect((missing.body as Problem).code).toBe('AGENDA_ENTRY_NOT_FOUND');

      const ours = await appointment(10 * 60);
      await put(`/agenda/sites/${siteId}/entries/${ours.id}/board-note`, screenToken, { boardNote: 'X' }).expect(403); // prettier-ignore
    });

    it('AG-176 más de 120 caracteres no entra', async () => {
      const entry = await appointment(9 * 60);

      await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, nurseToken, { boardNote: 'x'.repeat(120) }).expect(200); // prettier-ignore
      await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, nurseToken, { boardNote: 'x'.repeat(121) }).expect(422); // prettier-ignore
    });
  });

  describe('AG-184 AG-185 la nota sólo hoy, con bitácora y sin versión', () => {
    it('AG-184 en una cita de ayer o cerrada se rechaza con BOARD_NOTE_NOT_TODAY sin escribir nada; hoy y abierta, sí', async () => {
      const open = await appointment(9 * 60, { status: 'CHECKED_IN' });
      const yesterday = await appointment(9 * 60 - 24 * 60, { boardNote: 'Antigua' }); // prettier-ignore
      const closed = await appointment(8 * 60, { status: 'NO_SHOW' });

      // Control positivo: la de hoy, abierta, por la misma ruta.
      await put(`/agenda/sites/${siteId}/entries/${open.id}/board-note`, nurseToken, { boardNote: 'Pasa a curación' }).expect(200); // prettier-ignore

      for (const entry of [yesterday, closed]) {
        const refused = await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, nurseToken, { boardNote: 'Tarde' }).expect(409); // prettier-ignore
        expect((refused.body as Problem).code).toBe('BOARD_NOTE_NOT_TODAY');
        const after = await prisma.agendaEntry.findUniqueOrThrow({ where: { id: entry.id } }); // prettier-ignore
        expect(after.boardNote).toBe(entry.boardNote);
        expect(after.boardNoteAt).toBeNull();
        expect(await prisma.accessAudit.count({ where: { resourceId: entry.id } })).toBe(0); // prettier-ignore
      }

      // The board says, row by row, where the field may be offered.
      const board = (await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken).expect(200)).body as StaffBoard; // prettier-ignore
      const editable = Object.fromEntries(board.items.map((row) => [row.id, row.boardNoteEditable])); // prettier-ignore
      expect(editable[open.id]).toBe(true);
      expect(editable[closed.id]).toBe(false);
    });

    it('AG-185 cada escritura deja una fila de bitácora sin el contenido, también al vaciarla', async () => {
      const entry = await appointment(9 * 60);

      await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, nurseToken, { boardNote: 'Espera a su hija' }).expect(200); // prettier-ignore
      await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, receptionToken, { boardNote: '' }).expect(200); // prettier-ignore

      const trail = await prisma.accessAudit.findMany({
        where: {
          resourceType: 'agenda_entry_board_note',
          resourceId: entry.id,
        },
        orderBy: { id: 'asc' },
      });
      expect(trail).toHaveLength(2);
      expect(trail.map((row) => row.action)).toEqual(['UPDATE', 'UPDATE']);
      expect(trail[0]?.userId).not.toBe(trail[1]?.userId);
      // Without the content: nothing in the row repeats what was written.
      expect(JSON.stringify(trail, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain('hija'); // prettier-ignore
    });

    it('AG-185 la versión que archiva una edición de la cita no lleva la nota, y sí su sello', async () => {
      const entry = await appointment(9 * 60);
      await put(`/agenda/sites/${siteId}/entries/${entry.id}/board-note`, nurseToken, { boardNote: 'Espera a su hija' }).expect(200); // prettier-ignore
      const editor = await createUser(prisma);

      // An edit of the appointment (AG-051): the hour moves, stamped.
      await prisma.agendaEntry.update({
        where: { id: entry.id },
        data: {
          startsAt: at(10 * 60),
          endsAt: at(10 * 60 + 20),
          editedById: editor.id,
          editedAt: new Date(),
        },
      });

      const versions = await prisma.recordVersion.findMany({
        where: { resourceType: 'agenda_entry', resourceId: entry.id },
      });
      expect(versions).toHaveLength(1);
      const data = versions[0]!.data as Record<string, unknown>;
      // Control: the version IS the row as it was.
      expect(data.starts_at).toBeDefined();
      expect(data.board_note_at).not.toBeNull();
      expect(Object.keys(data)).not.toContain('board_note');
    });
  });

  describe('AG-183 la emergencia sin «Enterado» a los 2 minutos', () => {
    /** An emergency in the waiting room, with one notice `alertedMinutesAgo`. */
    async function emergency(
      minutes: number,
      alertedMinutesAgo: number,
      acknowledged = false,
    ) {
      const entry = await appointment(minutes, { status: 'CHECKED_IN' });
      const flaggedAt = new Date(Date.now() - (alertedMinutesAgo + 1) * MINUTE);
      const assessor = await createUser(prisma);
      await prisma.agendaEntry.update({
        where: { id: entry.id },
        data: {
          emergencyAssessedAt: flaggedAt,
          emergencyAssessedById: assessor.id,
          emergencyFlaggedAt: flaggedAt,
          emergencyFlaggedById: assessor.id,
          // Correcting the call is stamped (AG-132).
          editedById: assessor.id,
          editedAt: flaggedAt,
        },
      });
      const recipient = await createUser(prisma);
      const alertedAt = new Date(Date.now() - alertedMinutesAgo * MINUTE);
      await prisma.agendaEmergencyAlert.create({
        data: {
          agendaEntryId: entry.id,
          siteId,
          recipientId: recipient.id,
          raisedById: assessor.id,
          alertedAt,
          acknowledgedAt: acknowledged ? alertedAt : null,
        },
      });
      return entry;
    }

    it('AG-183 el tablero marca la fila pasados 2 minutos sin «Enterado», no antes, y no si alguien lo marcó', async () => {
      const overdue = await emergency(9 * 60, 3);
      const recent = await emergency(10 * 60, 1);
      const seen = await emergency(11 * 60, 3, true);

      const board = (await get(`/agenda/sites/${siteId}/board?date=${today}`, receptionToken).expect(200)).body as StaffBoard; // prettier-ignore
      const mark = Object.fromEntries(board.items.map((row) => [row.id, row.emergencyNeedsInPersonNotice])); // prettier-ignore

      expect(mark[overdue.id]).toBe(true);
      expect(mark[recent.id]).toBe(false);
      expect(mark[seen.id]).toBe(false);
    });
  });

  describe('AG-138 administrar las vistas', () => {
    it('AG-138 administración cambia la vista de enfermería y el tablero de enfermería cambia', async () => {
      await appointment(9 * 60, { status: 'CHECKED_IN', withRoom: true });
      const nursing = await prisma.role.findUniqueOrThrow({ where: { code: 'ENFERMERIA' } }); // prettier-ignore

      const listed = await get('/agenda/board-views', adminToken).expect(200);
      expect(
        (
          listed.body as { roles: { roleCode: string; fields: string[] }[] }
        ).roles.find((role) => role.roleCode === 'ENFERMERIA')?.fields,
      ).toEqual(['ROOM', 'TIME_IN_STATE', 'BOARD_NOTE']);

      await put(`/agenda/board-views/${nursing.id}`, adminToken, { fields: ['BOARD_NOTE', 'PRACTITIONER'] }).expect(200); // prettier-ignore

      const board = (await get(`/agenda/sites/${siteId}/board?date=${today}`, nurseToken).expect(200)).body as StaffBoard; // prettier-ignore
      expect(board.fields).toEqual(['PRACTITIONER', 'BOARD_NOTE']);
      expect(board.items[0]?.roomName).toBeNull();
      expect(
        await prisma.accessAudit.count({
          where: {
            resourceType: 'agenda_board_view',
            resourceId: nursing.id,
            action: 'UPDATE',
          },
        }),
      ).toBe(1);
    });

    it('AG-138 recepción no cambia vistas y un rol inexistente es BOARD_VIEW_ROLE_NOT_FOUND', async () => {
      const nursing = await prisma.role.findUniqueOrThrow({ where: { code: 'ENFERMERIA' } }); // prettier-ignore
      await put(`/agenda/board-views/${nursing.id}`, receptionToken, { fields: [] }).expect(403); // prettier-ignore

      const unknown = await put(`/agenda/board-views/${siteId}`, adminToken, { fields: [] }).expect(404); // prettier-ignore
      expect((unknown.body as Problem).code).toBe('BOARD_VIEW_ROLE_NOT_FOUND');

      await put(`/agenda/board-views/${nursing.id}`, adminToken, { fields: ['DIAGNOSIS'] }).expect(422); // prettier-ignore
    });
  });
});
