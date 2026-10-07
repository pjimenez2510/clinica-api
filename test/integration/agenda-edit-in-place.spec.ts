import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import {
  CLINIC_TIME_ZONE,
  WallClockTime,
  addDays,
  atWallClock,
  clinicalDateOf,
  isoWeekdayOf,
} from '../../src/shared/domain/clinic-time';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createRoom,
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * D-127 en la agenda, contra un PostgreSQL real: la cita y el bloqueo se
 * editan en la MISMA fila y la versión anterior la guarda la base.
 *
 * QUÉ SÓLO ESTA SUITE PUEDE DEMOSTRAR:
 *  - AG-050: que mover la cita es un UPDATE de la misma fila y que el cupo que
 *    deja vuelve a pasar por los `EXCLUDE` (se puede reservar).
 *  - AG-051: que `trg_agenda_entry_record_version` archiva la fila anterior y
 *    rechaza la edición sin sello, y que una transición de estado no la pide.
 *  - AG-052: que un destino ocupado deja la cita donde estaba.
 *  - AG-132, AG-163, AG-164, AG-117, AG-035: lo que la base admite ahora.
 *
 * LAS CITAS SON DE UN LUNES PASADO, derivado del reloj y no escrito a mano: la
 * sede habilita AG-031 para que el reloj real no decida nada.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';

/** The Monday at least a week before today, in Guayaquil. */
function pastMonday() {
  let date = addDays(clinicalDateOf(new Date(), CLINIC_TIME_ZONE), -7);
  while (isoWeekdayOf(date) !== 1) date = addDays(date, -1);
  return date;
}
const MONDAY = pastMonday();
const at = (time: string) => atWallClock(MONDAY, WallClockTime.parse(time));

/** 08:00–08:20 en Guayaquil. */
const ORIGINAL_SLOT = {
  startsAt: at('08:00').toISOString(),
  endsAt: at('08:20').toISOString(),
};

/** 09:00–09:20 el mismo día: borde de cupo de la misma regla. */
const NEW_SLOT = {
  startsAt: at('09:00').toISOString(),
  endsAt: at('09:20').toISOString(),
};

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface EntryBody {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  releasedAt: string | null;
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
  practitionerId: string;
  roomId: string | null;
  bookingChannel: string;
  emergencyFlaggedAt: string | null;
}

describe('editar en el sitio la cita y el bloqueo (D-127)', () => {
  /**
   * AG-173 (D-153.6). An arrival is recorded only on the appointment's own
   * day, so the clock of this file stands on MONDAY at 12:30, after every slot
   * it books and on the same day.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: at('12:30') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let userId: string;
  let siteId: string;
  let otherSiteId: string;
  let practitionerId: string;
  let patientId: string;
  let otherPatientId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones, por lo mismo que en agenda-http.spec.ts:
        // se sustituye el ALMACÉN y no el guard, porque `APP_GUARD` cubre
        // también el de autorización, que aquí sí se comprueba.
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
    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const otherPatient = await createPatient(prisma);

    siteId = site.id;
    otherSiteId = otherSite.id;
    practitionerId = practitioner.id;
    patientId = patient.id;
    otherPatientId = otherPatient.id;

    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    // Lunes, 08:00–12:00: cubre los dos huecos de arriba.
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
    );

    // AG-031: reservar en el pasado está cerrado de fábrica y todas las citas
    // de este fichero son del pasado, para que el reloj real no decida nada.
    await prisma.siteParameter.update({
      where: { siteId: site.id },
      data: { allowPastBooking: true },
    });

    token = await signIn();
  }

  async function signIn(): Promise<string> {
    await syncAuthorisation(prisma);
    registry.invalidate();

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        // Cédula sintética con dígito verificador calculado: nunca la de una
        // persona real.
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    userId = user.id;

    const recepcion = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: recepcion.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const book = (overrides: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId,
        practitionerId,
        bookingChannel: 'PHONE',
        ...ORIGINAL_SLOT,
        ...overrides,
      });

  async function bookedEntry(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await book(overrides).expect(201);
    return (response.body as EntryBody).id;
  }

  const historyOf = (entryId: string) =>
    prisma.agendaStatusHistory.findMany({
      where: { agendaEntryId: entryId },
      orderBy: { id: 'asc' },
    });

  const api = () => request(app.getHttpServer());
  const auth = { Authorization: '' };
  const withAuth = <T extends { set: (k: string, v: string) => T }>(r: T) =>
    r.set('Authorization', `Bearer ${token}`);
  void auth;

  const edit = (entryId: string, body: Record<string, unknown>) =>
    withAuth(api().patch(`/api/v1/agenda/sites/${siteId}/entries/${entryId}`)).send(body); // prettier-ignore

  const transition = (entryId: string, body: Record<string, unknown>) =>
    withAuth(api().post(`/api/v1/agenda/sites/${siteId}/entries/${entryId}/status`)).send(body); // prettier-ignore

  const versionsOf = (entryId: string) =>
    prisma.recordVersion.findMany({
      where: { resourceType: 'agenda_entry', resourceId: entryId },
      orderBy: { version: 'asc' },
    });

  describe('mover y editar la cita', () => {
    it('AG-050 mueve la MISMA cita y el cupo que deja se puede volver a reservar', async () => {
      const entryId = await bookedEntry();

      const response = await edit(entryId, NEW_SLOT).expect(200);
      const body = response.body as EntryBody;

      expect(body.id).toBe(entryId);
      expect(new Date(body.startsAt)).toEqual(new Date(NEW_SLOT.startsAt));
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
      expect(stored.editedById).toBe(userId);
      // Ninguna fila nueva, ninguna anulada.
      expect(await prisma.agendaEntry.count()).toBe(1);

      // La hora que dejó vuelve a pasar por los `EXCLUDE`.
      await book().expect(201);
    });

    it('AG-051 guarda la fila anterior en record_version, con quién y cuándo', async () => {
      const entryId = await bookedEntry();

      await edit(entryId, NEW_SLOT).expect(200);

      const [version] = await versionsOf(entryId);
      expect(version?.version).toBe(1);
      expect(version?.changedById).toBe(userId);
      expect((version?.data as { starts_at: string }).starts_at).toBe(
        new Date(ORIGINAL_SLOT.startsAt)
          .toISOString()
          .replace('.000Z', '+00:00'),
      );
    });

    it('AG-051 la base rechaza la edición sin sello y no la pide a una transición de estado', async () => {
      const entryId = await bookedEntry();

      // Sin sello: rechazada, venga de donde venga.
      await expect(
        prisma.$executeRaw`UPDATE agenda_entry SET reason = 'otro' WHERE id = ${entryId}::uuid`,
      ).rejects.toThrow(/record_version_change_is_stamped/);

      // Control positivo: con sello se admite y se archiva.
      await prisma.$executeRaw`UPDATE agenda_entry SET reason = 'otro', edited_by_id = ${userId}::uuid, edited_at = now() WHERE id = ${entryId}::uuid`;
      expect(await versionsOf(entryId)).toHaveLength(1);

      // Una transición no es una edición: ni sello ni versión.
      await transition(entryId, { to: 'CONFIRMED' }).expect(200);
      expect(await versionsOf(entryId)).toHaveLength(1);
    });

    it('AG-052 con el destino ocupado la cita queda donde estaba', async () => {
      const entryId = await bookedEntry();
      await book({ ...NEW_SLOT, patientId: otherPatientId }).expect(201);

      const response = await edit(entryId, NEW_SLOT).expect(409);
      expect((response.body as Problem).status).toBe(409);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.startsAt).toEqual(new Date(ORIGINAL_SLOT.startsAt));
      expect(await versionsOf(entryId)).toHaveLength(0);
    });

    it('AG-052 fuera del horario del profesional la cita queda intacta', async () => {
      const entryId = await bookedEntry();

      const response = await edit(entryId, {
        startsAt: at('15:00').toISOString(),
        endsAt: at('15:20').toISOString(),
      }).expect(422);
      expect((response.body as Problem).code).toBe('OUTSIDE_SCHEDULE_RULE');
      expect(await versionsOf(entryId)).toHaveLength(0);
    });

    it('AG-115 la mueve a otro profesional con las comprobaciones de una reserva', async () => {
      const entryId = await bookedEntry();
      const other = await createPractitioner(prisma);

      // Sin vínculo con la sede ni horario: se rechaza como una reserva.
      await edit(entryId, { ...NEW_SLOT, practitionerId: other.id }).expect(
        (res) => expect(res.status).toBeGreaterThanOrEqual(409),
      );

      await linkPractitionerToSite(prisma, other.id, siteId);
      await createScheduleRule(
        prisma,
        { practitionerId: other.id, siteId },
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
      );
      const moved = await edit(entryId, {
        ...NEW_SLOT,
        practitionerId: other.id,
      }).expect(200);
      expect((moved.body as EntryBody).practitionerId).toBe(other.id);
    });

    it('AG-162 corrige motivo, consultorio, canal y paciente antes de la llegada', async () => {
      const entryId = await bookedEntry();
      const room = await createRoom(prisma, siteId);

      const response = await edit(entryId, {
        reason: 'Control de presión',
        roomId: room.id,
        bookingChannel: 'WALK_IN',
        patientId: otherPatientId,
      }).expect(200);

      const body = response.body as EntryBody;
      expect(body.roomId).toBe(room.id);
      expect(body.bookingChannel).toBe('WALK_IN');
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.reason).toBe('Control de presión');
      expect(stored.patientId).toBe(otherPatientId);
    });

    it('AG-162 tras la llegada no cambia el paciente ni la hora, y sí el motivo', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore

      const refused = await edit(entryId, { patientId: otherPatientId }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('AGENDA_ENTRY_NOT_EDITABLE');
      await edit(entryId, NEW_SLOT).expect(409);

      await edit(entryId, { reason: 'Dolor de cabeza' }).expect(200);
    });

    it('AG-162 corrige el paciente de una cita cuya hora ya pasó, con la sede cerrada al pasado', async () => {
      const entryId = await bookedEntry({
        reason: 'Dato del paciente anterior',
      });
      // La sede de fábrica no reserva en el pasado (D-001): corregir el
      // paciente no es reservar, y se admite igual.
      await prisma.siteParameter.update({
        where: { siteId },
        data: { allowPastBooking: false },
      });

      await edit(entryId, { patientId: otherPatientId }).expect(200);
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.patientId).toBe(otherPatientId);
      // El motivo era del paciente anterior: no viaja al nuevo.
      expect(stored.reason).toBeNull();

      // Control positivo: MOVERLA sí es reservar, y el pasado sigue cerrado.
      const moved = await edit(entryId, NEW_SLOT).expect(422);
      expect((moved.body as Problem).code).toBe('BOOKING_IN_THE_PAST');
    });

    it('AG-162 un sobrecupo que no cambia de hora conserva su excepción', async () => {
      await bookedEntry();
      const over = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId,
          patientId: otherPatientId,
          startsAt: ORIGINAL_SLOT.startsAt,
          endsAt: ORIGINAL_SLOT.endsAt,
          bookingChannel: 'PHONE',
          blocksCalendar: false,
          overbookingAuthorisedById: userId,
          createdById: userId,
        },
      });

      await edit(over.id, { bookingChannel: 'WALK_IN' }).expect(200);
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: over.id },
      });
      expect(stored.blocksCalendar).toBe(false);
      expect(stored.overbookingAuthorisedById).toBe(userId);
    });

    it('AG-063 una cita que salió de la lista de espera no cambia de paciente, ni por HTTP ni en la base', async () => {
      const entryId = await bookedEntry();
      const waiting = await prisma.waitlistEntry.create({
        data: {
          patientId,
          siteId,
          preferredFrom: new Date(ORIGINAL_SLOT.startsAt),
          preferredTo: new Date(ORIGINAL_SLOT.startsAt),
        },
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: waiting.id,
          recordedById: userId,
          outcome: 'ACCEPTED',
        },
      });
      await prisma.waitlistEntry.update({
        where: { id: waiting.id },
        data: { status: 'SCHEDULED', convertedEntryId: entryId },
      });

      const refused = await edit(entryId, { patientId: otherPatientId }).expect(
        409,
      );
      expect((refused.body as Problem).code).toBe('APPOINTMENT_FROM_WAITLIST');
      await expect(
        prisma.$executeRaw`UPDATE agenda_entry SET patient_id = ${otherPatientId}::uuid, edited_by_id = ${userId}::uuid, edited_at = now() WHERE id = ${entryId}::uuid`,
      ).rejects.toThrow(/agenda_entry_waitlist_patient_fixed/);

      // Control positivo: lo demás se sigue corrigiendo.
      await edit(entryId, { bookingChannel: 'WALK_IN' }).expect(200);
    });

    it('AG-045 no mueve una cita con atención', async () => {
      const entryId = await bookedEntry();
      await createEncounter(prisma, {
        siteId,
        practitionerId,
        patientId,
        agendaEntryId: entryId,
      });

      const response = await edit(entryId, NEW_SLOT).expect(409);
      expect((response.body as Problem).code).toBe(
        'AGENDA_ENTRY_HAS_ENCOUNTER',
      );
    });

    it('AG-168 sirve las versiones de la cita, sin el motivo de consulta', async () => {
      const entryId = await bookedEntry({ reason: 'Dato de salud' });
      await edit(entryId, NEW_SLOT).expect(200);

      const response = await withAuth(
        api().get(`/api/v1/agenda/sites/${siteId}/entries/${entryId}/versions`),
      ).expect(200);

      const body = response.body as {
        items: { startsAt: string; replacedBy: { id: string } }[];
      };
      expect(body.items).toHaveLength(1);
      expect(new Date(body.items[0]!.startsAt)).toEqual(
        new Date(ORIGINAL_SLOT.startsAt),
      );
      expect(body.items[0]!.replacedBy.id).toBe(userId);
      expect(JSON.stringify(body)).not.toContain('Dato de salud');
    });

    it('AG-071 responde 404 para la cita de otra sede y 403 por la URL ajena', async () => {
      const foreign = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: otherSiteId,
          practitionerId,
          patientId,
          startsAt: ORIGINAL_SLOT.startsAt,
          endsAt: ORIGINAL_SLOT.endsAt,
          bookingChannel: 'PHONE',
          createdById: userId,
        },
      });

      const notFound = await edit(foreign.id, NEW_SLOT).expect(404);
      expect((notFound.body as Problem).code).toBe('AGENDA_ENTRY_NOT_FOUND');
      await withAuth(
        api().patch(
          `/api/v1/agenda/sites/${otherSiteId}/entries/${foreign.id}`,
        ),
      )
        .send(NEW_SLOT)
        .expect(403);
    });
  });

  describe('lo que deja de pedir motivo (D-126)', () => {
    it('AG-044 anula sin motivo y libera el cupo', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'CANCELLED' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.cancellationNote).toBeNull();
      expect(stored.releasedAt).toBeInstanceOf(Date);
    });

    it('AG-117 retira una cita registrada por error sin motivo, y la base lo admite', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'ENTERED_IN_ERROR' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('ENTERED_IN_ERROR');
      expect(stored.enteredInErrorReason).toBeNull();
    });

    it('AG-035 la base admite el sobrecupo sin motivo y sigue exigiendo el autorizador', async () => {
      const base = {
        kind: 'APPOINTMENT' as const,
        siteId,
        practitionerId,
        patientId,
        startsAt: ORIGINAL_SLOT.startsAt,
        endsAt: ORIGINAL_SLOT.endsAt,
        bookingChannel: 'PHONE' as const,
        blocksCalendar: false,
        createdById: userId,
      };

      // Sin autorizador: rechazado.
      await expect(prisma.agendaEntry.create({ data: base })).rejects.toThrow(
        /agenda_entry_overbooking_coherence/,
      );
      // Con autorizador y sin motivo: admitido.
      const created = await prisma.agendaEntry.create({
        data: { ...base, overbookingAuthorisedById: userId },
      });
      expect(created.overbookingReason).toBeNull();
    });
  });

  describe('deshacer «No asistió» (AG-163)', () => {
    const undo = (entryId: string) =>
      withAuth(
        api().post(
          `/api/v1/agenda/sites/${siteId}/entries/${entryId}/no-show/undo`,
        ),
      );

    it('AG-163 el mismo día devuelve la cita a su estado y vuelve a ocupar el cupo', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CONFIRMED' }).expect(200);
      await transition(entryId, { to: 'NO_SHOW' }).expect(200);

      const response = await undo(entryId).expect(200);
      expect((response.body as EntryBody).status).toBe('CONFIRMED');

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.noShowAt).toBeNull();
      expect(stored.releasedAt).toBeNull();
      const history = await historyOf(entryId);
      expect(history.at(-1)).toMatchObject({
        fromStatus: 'NO_SHOW',
        toStatus: 'CONFIRMED',
        changedById: userId,
      });
      // Vuelve a ocupar: la misma hora ya no se puede reservar.
      await book({ patientId: otherPatientId }).expect(409);
    });

    it('AG-163 si el cupo se reservó entretanto, la inasistencia se queda', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'NO_SHOW' }).expect(200);
      await book({ patientId: otherPatientId }).expect(201);

      await undo(entryId).expect(409);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('NO_SHOW');
    });

    it('AG-163 rechaza deshacerla al día siguiente', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'NO_SHOW' }).expect(200);
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await prisma.agendaEntry.update({
        where: { id: entryId },
        data: { noShowAt: twoDaysAgo, releasedAt: twoDaysAgo },
      });

      const response = await undo(entryId).expect(409);
      expect((response.body as Problem).code).toBe('NO_SHOW_UNDO_EXPIRED');
    });
  });

  describe('editar el bloqueo (AG-164)', () => {
    const block = () =>
      withAuth(api().post(`/api/v1/agenda/sites/${siteId}/blocks`)).send({
        practitionerId,
        startsAt: at('10:00').toISOString(),
        endsAt: at('11:00').toISOString(),
        reason: 'Reunión',
      });
    const editBlock = (entryId: string, body: Record<string, unknown>) =>
      withAuth(api().patch(`/api/v1/agenda/sites/${siteId}/blocks/${entryId}`)).send(body); // prettier-ignore

    it('AG-164 alarga el mismo bloqueo y guarda la versión', async () => {
      const blockId = ((await block().expect(201)).body as EntryBody).id;

      const response = await editBlock(blockId, {
        startsAt: at('10:00').toISOString(),
        endsAt: at('11:40').toISOString(),
        reason: 'Congreso',
      }).expect(200);

      expect((response.body as EntryBody).id).toBe(blockId);
      expect(new Date((response.body as EntryBody).endsAt)).toEqual(
        at('11:40'),
      );
      expect(await versionsOf(blockId)).toHaveLength(1);
    });

    it('AG-164 rechaza alargarlo sobre una cita y la enumera', async () => {
      const blockId = ((await block().expect(201)).body as EntryBody).id;
      await bookedEntry({
        startsAt: at('11:20').toISOString(),
        endsAt: at('11:40').toISOString(),
      });

      const response = await editBlock(blockId, {
        startsAt: at('10:00').toISOString(),
        endsAt: at('12:00').toISOString(),
      }).expect(409);

      expect((response.body as Problem).code).toBe(
        'BLOCK_OVERLAPS_APPOINTMENTS',
      );
      // AG-038: la hora de la cita que lo impide, en Ecuador.
      expect((response.body as Problem).errors?.[0]?.message).toContain(
        '11:20',
      );
      expect(await versionsOf(blockId)).toHaveLength(0);
    });
  });

  describe('corregir la calificación de emergencia (AG-132)', () => {
    const correct = (entryId: string, body: Record<string, unknown>) =>
      withAuth(api().patch(`/api/v1/agenda/sites/${siteId}/entries/${entryId}/emergency`)).send(body); // prettier-ignore

    it('AG-132 corrige la calificación y la anterior queda en la versión', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore

      const response = await correct(entryId, {
        emergency: true,
        emergencyNote: 'Dolor torácico',
      }).expect(200);

      expect((response.body as EntryBody).emergencyFlaggedAt).not.toBeNull();
      // La calificación del arribo se queda en la fila (Ley 77 art. 10).
      const before = await versionsOf(entryId);
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.emergencyAssessedAt?.toISOString()).toBe(
        new Date(
          (before[0]?.data as { emergency_assessed_at: string })
            .emergency_assessed_at,
        ).toISOString(),
      );
      const [version] = before;
      expect(
        (version?.data as { emergency_flagged_at: string | null })
          .emergency_flagged_at,
      ).toBeNull();
    });

    it('AG-132 la base no deja borrar la calificación, y la primera no pide sello', async () => {
      const entryId = await bookedEntry();
      // Control positivo: calificar al llegar no es una edición.
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
      expect(await versionsOf(entryId)).toHaveLength(0);

      await expect(
        prisma.$executeRaw`UPDATE agenda_entry SET emergency_assessed_at = NULL, emergency_assessed_by_id = NULL, edited_by_id = ${userId}::uuid, edited_at = now() WHERE id = ${entryId}::uuid`,
      ).rejects.toThrow(/agenda_entry_emergency_call_is_immutable/);
    });

    it('AG-132 no la corrige cuando el paciente ya no está en la clínica', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
      await transition(entryId, { to: 'LEFT_WITHOUT_BEING_SEEN' }).expect(200);

      const response = await correct(entryId, { emergency: true }).expect(409);
      expect((response.body as Problem).code).toBe('AGENDA_ENTRY_NOT_EDITABLE');
    });

    it('AG-132 no corrige una calificación que no se hizo', async () => {
      const entryId = await bookedEntry();

      const response = await correct(entryId, { emergency: true }).expect(409);
      expect((response.body as Problem).code).toBe('AGENDA_ENTRY_NOT_EDITABLE');
    });
  });
});
