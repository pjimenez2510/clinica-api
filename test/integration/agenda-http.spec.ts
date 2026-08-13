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
import {
  createPatient,
  createPractitioner,
  createRoom,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';

/**
 * The agenda as the browser consumes it.
 *
 * WHAT THIS ADDS over the repository and domain suites: everything BETWEEN the
 * browser and the database — the permission, the site scope, the shape of a
 * refusal under RFC 9457, and the exact `code` a client branches on. Half of
 * these requirements already had a domain test and no proof that the rule ever
 * reaches an HTTP response with the code the specification names.
 *
 * Every appointment below is on Monday 14 September 2026, and the times are
 * Ecuadorian: 08:00 there is 13:00Z. The schedule rule is 08:00–12:00 in slots
 * of twenty minutes.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';

/** 08:00–08:20 in Guayaquil: the first slot of the rule. */
const FIRST_SLOT = {
  startsAt: '2026-09-14T13:00:00Z',
  endsAt: '2026-09-14T13:20:00Z',
};

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

describe('la agenda por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let userId: string;
  let siteId: string;
  let otherSiteId: string;
  let practitionerId: string;
  let secondPractitionerId: string;
  let roomId: string;
  let patientId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        /**
         * Sin límite de peticiones AQUÍ, por lo mismo que en
         * `catalog-http.spec.ts`: el límite real son cinco por segundo y este
         * fichero hace una veintena seguidas. Se sustituye el ALMACÉN, no el
         * guard: `APP_GUARD` cubre también el de autorización, que es
         * precisamente lo que estas pruebas comprueban.
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
      await app.init();
      registry = app.get(RolePermissionRegistry);
    }

    // Se siembra ANTES DE CADA PRUEBA: `useDatabase` trunca entre pruebas, así
    // que sembrar una sola vez deja la primera con datos y el resto sin nada.
    await seed();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seed(): Promise<void> {
    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const practitioner = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);
    const room = await createRoom(prisma, site.id);
    const patient = await createPatient(prisma);

    siteId = site.id;
    otherSiteId = otherSite.id;
    practitionerId = practitioner.id;
    secondPractitionerId = second.id;
    roomId = room.id;
    patientId = patient.id;

    for (const id of [practitioner.id, second.id]) {
      await linkPractitionerToSite(prisma, id, site.id);
      // Lunes, 08:00–12:00, cupos de veinte minutos.
      await createScheduleRule(
        prisma,
        { practitionerId: id, siteId: site.id },
        { weekday: 1, startTime: '08:00', endTime: '12:00', slotMinutes: 20 },
      );
    }

    token = await signIn();
  }

  async function signIn(): Promise<string> {
    await syncAuthorisation(prisma);
    // La caché de rol→permisos se indexa por id, y al truncar los roles se
    // recrean con ids nuevos: sin esto todas las peticiones responden 403.
    registry.invalidate();

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        // Cédula sintética con dígito verificador calculado, como el resto de
        // las pruebas: nunca la de una persona real.
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
    // EN UNA SEDE, no en todas: es lo que hace comprobable AG-071.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: recepcion.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const book = (body: Record<string, unknown>, site = siteId) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${site}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const anAppointment = (overrides: Record<string, unknown> = {}) => ({
    patientId,
    practitionerId,
    bookingChannel: 'PHONE',
    ...FIRST_SLOT,
    ...overrides,
  });

  const dayOf = (site = siteId, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/agenda/sites/${site}/entries?date=2026-09-14${query}`)
      .set('Authorization', `Bearer ${token}`);

  interface AvailabilityBody {
    siteId: string;
    practitionerId: string;
    from: string;
    to: string;
    slots: {
      ruleId: string;
      startsAt: string;
      endsAt: string;
      slotMinutes: number;
      serviceTypeConceptId: string | null;
    }[];
    occupied: { startsAt: string; endsAt: string }[];
  }

  const availabilityOf = (
    query: Record<string, string> = {},
    site = siteId,
  ) => {
    const search = new URLSearchParams({
      practitionerId,
      from: '2026-09-14',
      to: '2026-09-14',
      ...query,
    });
    return request(app.getHttpServer())
      .get(`/api/v1/agenda/sites/${site}/availability?${search.toString()}`)
      .set('Authorization', `Bearer ${token}`);
  };

  describe('quién puede entrar', () => {
    it('AG-070 rechaza la agenda sin sesión', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${siteId}/entries?date=2026-09-14`)
        .expect(401);

      await request(app.getHttpServer())
        .post(`/api/v1/agenda/sites/${siteId}/entries`)
        .send(anAppointment())
        .expect(401);
    });

    it('AG-071 rechaza reservar en una sede fuera del alcance del usuario', async () => {
      // Recepción contratada en la sede norte no agenda en la sur, aunque
      // tenga el permiso `agenda:write`.
      const response = await book(anAppointment(), otherSiteId).expect(403);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SITE_SCOPE_DENIED');
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
    });

    it('AG-071 rechaza consultar la agenda de una sede fuera de alcance', async () => {
      const response = await dayOf(otherSiteId).expect(403);
      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });

    it('AG-071 rechaza consultar la disponibilidad de una sede fuera de alcance', async () => {
      // La sede va en la ruta justamente para esto: el guard corre antes que
      // ninguna tubería de validación y decide sin mirar la consulta.
      const response = await availabilityOf({}, otherSiteId).expect(403);
      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });

    it('AG-070 rechaza la disponibilidad sin sesión', async () => {
      await request(app.getHttpServer())
        .get(
          `/api/v1/agenda/sites/${siteId}/availability?practitionerId=${practitionerId}&from=2026-09-14&to=2026-09-14`,
        )
        .expect(401);
    });
  });

  describe('los cupos disponibles', () => {
    it('AG-003 devuelve los cupos derivados de la regla y no materializa ninguna fila', async () => {
      const response = await availabilityOf().expect(200);
      const body = response.body as AvailabilityBody;

      // 08:00–12:00 en cupos de veinte: doce, y el primero empieza a las
      // 08:00 de Ecuador, que son las 13:00Z.
      expect(body.slots).toHaveLength(12);
      expect(body.slots[0]).toMatchObject({
        startsAt: '2026-09-14T13:00:00.000Z',
        endsAt: '2026-09-14T13:20:00.000Z',
        slotMinutes: 20,
      });
      expect(body.occupied).toEqual([]);
      expect(body).toMatchObject({
        siteId,
        practitionerId,
        from: '2026-09-14',
        to: '2026-09-14',
      });

      // La prohibición del requisito: ofrecer doce cupos no escribió nada.
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-003 resta de los cupos la cita que ocupa calendario', async () => {
      await book(anAppointment()).expect(201);

      const body = (await availabilityOf().expect(200))
        .body as AvailabilityBody;

      expect(body.slots).toHaveLength(11);
      expect(body.slots.map((slot) => slot.startsAt)).not.toContain(
        '2026-09-14T13:00:00.000Z',
      );
      // Y el hueco se dice: cuándo empieza y cuánto dura, para que el cliente
      // pinte el día sin volver a preguntar.
      expect(body.occupied).toEqual([
        {
          startsAt: '2026-09-14T13:00:00.000Z',
          endsAt: '2026-09-14T13:20:00.000Z',
        },
      ]);
    });

    it('AG-010 sólo ofrece cupos en las fechas que cubre la regla vigente', async () => {
      // Del lunes al miércoles: la regla es de lunes, así que los doce cupos
      // caen todos el día 14 y los otros dos días no ofrecen ninguno.
      const body = (
        await availabilityOf({ from: '2026-09-14', to: '2026-09-16' }).expect(
          200,
        )
      ).body as AvailabilityBody;

      expect(body.slots).toHaveLength(12);
      expect(
        body.slots.every((slot) => slot.startsAt.startsWith('2026-09-14')),
      ).toBe(true);
    });

    it('AG-010 no ofrece cupos de una regla desactivada', async () => {
      await prisma.practitionerScheduleRule.updateMany({
        where: { practitionerId, siteId },
        data: { active: false },
      });

      const body = (await availabilityOf().expect(200))
        .body as AvailabilityBody;
      expect(body.slots).toEqual([]);
    });

    it('AG-013 no ofrece cupos de un profesional no agendable', async () => {
      // Un patólogo tiene perfil clínico y no tiene agenda.
      await prisma.practitioner.update({
        where: { id: practitionerId },
        data: { schedulable: false },
      });

      const body = (await availabilityOf().expect(200))
        .body as AvailabilityBody;

      expect(body.slots).toEqual([]);
    });

    it('AG-014 no ofrece cupos en una sede a la que el profesional no está vinculado', async () => {
      await prisma.practitionerSite.delete({
        where: { practitionerId_siteId: { practitionerId, siteId } },
      });

      const body = (await availabilityOf().expect(200))
        .body as AvailabilityBody;

      expect(body.slots).toEqual([]);
    });

    it('AG-010 rechaza un rango imposible en lugar de responder 500', async () => {
      // `clinicalDatesBetween` corta en 366 días con un `RangeError`, que sin
      // esto llegaría al cliente como «el servidor se rompió» por un año mal
      // tecleado.
      const tooLong = await availabilityOf({
        from: '2026-01-01',
        to: '2027-12-31',
      }).expect(422);

      const problem = tooLong.body as Problem;
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0]).toMatchObject({
        field: 'to',
        message: 'El rango no puede superar 366 días',
      });

      const inverted = await availabilityOf({
        from: '2026-09-16',
        to: '2026-09-14',
      }).expect(422);
      expect((inverted.body as Problem).errors?.[0]).toMatchObject({
        field: 'to',
        message: 'La fecha final no puede ser anterior a la inicial',
      });
    });

    it('AG-074 no expone paciente ni motivo en los cupos ocupados', async () => {
      await book(anAppointment({ reason: 'Control de embarazo' })).expect(201);
      const patient = await prisma.patient.findUniqueOrThrow({
        where: { id: patientId },
      });

      const response = await availabilityOf().expect(200);

      expect(response.text).not.toContain('Control de embarazo');
      expect(response.text).not.toContain(patient.familyName);
      expect(response.text).not.toContain(patient.mrn);
      // Ni siquiera el identificador de la cita: sin él esta respuesta no se
      // puede cruzar con nada para deducir quién ocupa qué hora.
      expect(response.text).not.toContain(patientId);
    });

    it('AG-072 no registra un acceso a historia clínica al consultar la disponibilidad', async () => {
      await book(anAppointment()).expect(201);
      const before = await prisma.accessAudit.count();

      await availabilityOf().expect(200);

      await expect(prisma.accessAudit.count()).resolves.toBe(before);
    });
  });

  describe('reservar una cita', () => {
    it('AG-020 exige paciente, profesional, inicio y fin', async () => {
      const response = await book({ bookingChannel: 'PHONE' }).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('VALIDATION_FAILED');
      // Cada campo que falta se nombra: un 422 sin `errors[]` deja al
      // formulario sin saber qué resaltar.
      expect(problem.errors?.map((error) => error.field).sort()).toEqual([
        'endsAt',
        'patientId',
        'practitionerId',
        'startsAt',
      ]);
    });

    it('AG-020 exige la sede como ruta, no como dato del cuerpo', async () => {
      // La sede va en la URL para que el guard la compruebe antes de que corra
      // ninguna tubería de validación. Por eso una sede inventada se rechaza
      // ahí mismo con 403 —nadie tiene alcance sobre ella— y no llega nunca a
      // la reserva.
      await request(app.getHttpServer())
        .post('/api/v1/agenda/sites/no-es-un-uuid/entries')
        .set('Authorization', `Bearer ${token}`)
        .send(anAppointment())
        .expect(403);
    });

    it('AG-029 registra el canal de reserva y quién la creó', async () => {
      const response = await book(
        anAppointment({ bookingChannel: 'WALK_IN' }),
      ).expect(201);

      const entry = response.body as {
        id: string;
        bookingChannel: string;
        createdById: string;
        status: string;
        releasedAt: string | null;
      };
      expect(entry.bookingChannel).toBe('WALK_IN');
      // El autor sale de la sesión, nunca del cuerpo: un cliente no puede
      // atribuirle la reserva a otra persona.
      expect(entry.createdById).toBe(userId);
      expect(entry.status).toBe('BOOKED');
      expect(entry.releasedAt).toBeNull();

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(stored.bookingChannel).toBe('WALK_IN');
      expect(stored.createdById).toBe(userId);
    });

    it('AG-034 rechaza un canal de reserva fuera de los cuatro admitidos', async () => {
      const response = await book(
        anAppointment({ bookingChannel: 'telefono' }),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_BOOKING_CHANNEL');
      expect(problem.title).toBe(
        'Indique cómo se solicitó la cita: teléfono, ventanilla, web o referencia',
      );
      expect(problem.errors?.[0]).toMatchObject({
        field: 'bookingChannel',
        message: 'Valores admitidos: PHONE, WALK_IN, WEB, REFERRAL',
      });

      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-027 rechaza reservar para una historia fusionada, y no con 404', async () => {
      const surviving = await createPatient(prisma);
      await prisma.patient.update({
        where: { id: patientId },
        data: { mergedIntoId: surviving.id },
      });

      const response = await book(anAppointment()).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PATIENT_MERGED');
      expect(problem.title).toBe(
        'Esta historia se unificó con otra. Abra la vigente',
      );
      // Indica la historia vigente EN `errors[]`, que es lo único estructurado
      // que el filtro emite siempre: `detail` se omite en producción y `params`
      // no viaja nunca, así que afirmarlo sobre el texto crudo comprobaba el
      // entorno de pruebas y no el contrato.
      expect(problem.errors?.[0]).toEqual({
        field: 'patientId',
        code: 'PATIENT_MERGED',
        message: `La historia vigente es ${surviving.mrn}`,
      });
      // Y nada más del paciente: el número de historia vigente es lo que el
      // requisito manda decir (SC-006).
      expect(response.text).not.toContain(surviving.familyName);
      expect(response.text).not.toContain(surviving.givenName);

      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-028 rechaza un horario fuera de toda regla vigente', async () => {
      // 07:00 en Ecuador: la consulta abre a las ocho.
      const response = await book(
        anAppointment({
          startsAt: '2026-09-14T12:00:00Z',
          endsAt: '2026-09-14T12:20:00Z',
        }),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('OUTSIDE_SCHEDULE_RULE');
      expect(problem.title).toBe(
        'El horario solicitado no está dentro de la agenda del profesional. Elija un cupo disponible',
      );
    });

    it('AG-012 rechaza una duración que no es múltiplo del cupo', async () => {
      const response = await book(
        anAppointment({ endsAt: '2026-09-14T13:30:00Z' }),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_SLOT_DURATION');
      expect(problem.errors?.[0]).toMatchObject({
        field: 'endsAt',
        message: 'La duración debe ser un múltiplo de 20 minutos',
      });
    });

    it('AG-104 rechaza un inicio que no cae en el borde de un cupo', async () => {
      // 08:10–08:30 dura exactamente un cupo y aun así parte la rejilla en dos
      // huecos de diez minutos que ya nadie puede reservar.
      const response = await book(
        anAppointment({
          startsAt: '2026-09-14T13:10:00Z',
          endsAt: '2026-09-14T13:30:00Z',
        }),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SLOT_NOT_ALIGNED');
      // Los inicios admitidos se dicen en hora de pared ecuatoriana, que es lo
      // que lee quien está en el mostrador.
      expect(problem.errors?.[0]?.message).toBe(
        'Los inicios admitidos más próximos son 08:00 y 08:20',
      );
    });

    it('AG-105 rechaza reservar un consultorio de otra sede', async () => {
      // El cuerpo de la petición no puede alcanzar un recurso físico de una
      // sede sobre la que quien reserva no tiene alcance: la sede va en la
      // ruta justamente para eso, y el consultorio la esquivaba.
      const roomInOtherSite = await createRoom(prisma, otherSiteId);

      const response = await book(
        anAppointment({ roomId: roomInOtherSite.id }),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('ROOM_NOT_IN_SITE');
      expect(problem.title).toBe(
        'El consultorio no pertenece a esta sede. Elija uno de la sede en la que está agendando',
      );
      expect(problem.errors?.[0]).toMatchObject({
        field: 'roomId',
        message: 'Seleccione un consultorio de esta sede',
      });

      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-023 rechaza con 409 una cita que pisa a otra del mismo profesional', async () => {
      await book(anAppointment()).expect(201);

      const response = await book(
        anAppointment({ patientId: (await createPatient(prisma)).id }),
      ).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PRACTITIONER_SLOT_TAKEN');
      expect(problem.errors?.[0]).toMatchObject({
        field: 'startsAt',
        message: 'El profesional ya tiene una cita en ese horario',
      });
    });

    it('AG-024 rechaza con 409 dos citas en el mismo consultorio a la misma hora', async () => {
      await book(anAppointment({ roomId })).expect(201);

      // Otro profesional: la regla de profesional no aplica y sólo la de
      // consultorio se interpone entre dos pacientes y la misma puerta.
      const response = await book(
        anAppointment({
          roomId,
          practitionerId: secondPractitionerId,
          patientId: (await createPatient(prisma)).id,
        }),
      ).expect(409);

      expect((response.body as Problem).code).toBe('ROOM_SLOT_TAKEN');
    });

    it('AG-030 rechaza con 409 al paciente que ya tiene otra cita a esa hora', async () => {
      await book(anAppointment()).expect(201);

      const response = await book(
        anAppointment({ practitionerId: secondPractitionerId }),
      ).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PATIENT_DOUBLE_BOOKED');
      // Ni nombre, ni número de historia, ni el profesional de la otra cita:
      // lo lee alguien que puede no tener acceso a ella.
      expect(problem.errors?.[0]?.message).toBe(
        'El paciente ya tiene otra cita a esa hora: elija otro horario o anule la anterior',
      );
    });

    it('AG-026 responde 503 con Retry-After, y nunca como conflicto de cupo', async () => {
      /**
       * La reserva se aborta SIEMPRE por serialización.
       *
       * Es la forma exacta que PostgreSQL 18 entrega a través de este driver
       * —capturada de un `40001` real en `agenda-daily.spec.ts`— y aquí se
       * repone en cada intento, que es el caso del requisito: agotados los
       * reintentos. Un servidor vivo no lo produce a voluntad.
       */
      const original = prisma.agendaEntry.create.bind(prisma.agendaEntry);
      const conflict = Object.assign(new Error('TransactionWriteConflict'), {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '40001',
          originalMessage:
            'could not serialize access due to read/write dependencies among transactions',
          kind: 'TransactionWriteConflict',
        },
      });

      (prisma.agendaEntry as { create: unknown }).create = () =>
        Promise.reject(conflict);

      try {
        const response = await book(anAppointment()).expect(503);

        const problem = response.body as Problem;
        expect(problem.code).toBe('BOOKING_RETRY_EXHAUSTED');
        // NO se presenta como conflicto de cupo: un `40001` no dice nada del
        // horario, y decirle a recepción que elija otro movería la cita de un
        // paciente sin motivo.
        expect(problem.status).toBe(503);
        expect(problem.code).not.toBe('PRACTITIONER_SLOT_TAKEN');
        expect(problem.title).toBe(
          'La agenda está muy solicitada en este momento. Intente reservar de nuevo en unos segundos',
        );
        // Lo único de un 503 que un cliente puede automatizar.
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        (prisma.agendaEntry as { create: unknown }).create = original;
      }
    });
  });

  describe('la agenda del día', () => {
    it('AG-017 devuelve las citas del día ordenadas por inicio', async () => {
      const later = await book(
        anAppointment({
          startsAt: '2026-09-14T14:00:00Z',
          endsAt: '2026-09-14T14:20:00Z',
        }),
      ).expect(201);
      const earlier = await book(
        anAppointment({
          patientId: (await createPatient(prisma)).id,
        }),
      ).expect(201);

      const response = await dayOf().expect(200);
      const body = response.body as {
        siteId: string;
        date: string;
        includeReleased: boolean;
        items: { id: string }[];
      };

      expect(body.items.map((item) => item.id)).toEqual([
        (earlier.body as { id: string }).id,
        (later.body as { id: string }).id,
      ]);
      expect(body).toMatchObject({ siteId, date: '2026-09-14' });
    });

    it('AG-018 sólo incluye las liberadas si se piden, y las señala', async () => {
      const created = await book(anAppointment()).expect(201);
      const id = (created.body as { id: string }).id;
      await prisma.agendaEntry.update({
        where: { id },
        data: { releasedAt: new Date(), status: 'CANCELLED' },
      });

      const hidden = await dayOf().expect(200);
      expect((hidden.body as { items: unknown[] }).items).toEqual([]);

      // `includeReleased=false` tiene que apagarlo de verdad: con coerción de
      // JavaScript la cadena "false" es cierta y el filtro no serviría.
      const stillHidden = await dayOf(siteId, '&includeReleased=false').expect(
        200,
      );
      expect((stillHidden.body as { items: unknown[] }).items).toEqual([]);

      const asked = await dayOf(siteId, '&includeReleased=true').expect(200);
      const items = (asked.body as { items: { id: string; releasedAt: string | null }[] }).items; // prettier-ignore
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe(id);
      expect(items[0]?.releasedAt).not.toBeNull();
    });

    it('AG-072 no registra un acceso a historia clínica por cada fila listada', async () => {
      await book(anAppointment()).expect(201);
      await book(
        anAppointment({
          patientId: (await createPatient(prisma)).id,
          startsAt: '2026-09-14T14:00:00Z',
          endsAt: '2026-09-14T14:20:00Z',
        }),
      ).expect(201);

      const before = await prisma.accessAudit.count();
      await dayOf().expect(200);

      await expect(prisma.accessAudit.count()).resolves.toBe(before);
    });

    it('AG-109 devuelve el nombre del paciente y jamás su documento ni el motivo', async () => {
      // El nombre es identificación operativa: sin él la rejilla del
      // calendario es inoperable. El documento y el motivo son de la ficha,
      // que se abre por su ruta auditada (AG-073).
      await book(anAppointment({ reason: 'Control de embarazo' })).expect(201);
      const patient = await prisma.patient.findUniqueOrThrow({
        where: { id: patientId },
      });

      const response = await dayOf().expect(200);

      expect(response.text).toContain(
        `${patient.familyName}, ${patient.givenName}`,
      );
      expect(response.text).not.toContain(patient.mrn);
      // El motivo de consulta es dato de salud: cualquiera con `agenda:read`
      // en la sede leía el de las cuarenta filas del día sin que quedara
      // constancia de quién lo leyó (AG-072, SC-006).
      expect(response.text).not.toContain('Control de embarazo');
      // Y sigue guardado: no se expone, no se pierde.
      const stored = await prisma.agendaEntry.findFirstOrThrow();
      expect(stored.reason).toBe('Control de embarazo');
    });

    it('AG-017 rechaza una fecha mal escrita en lugar de devolver una lista vacía', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${siteId}/entries?date=ayer`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect((response.body as Problem).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('las listas de referencia', () => {
    it('AG-107 lista solo las sedes del alcance de quien llama', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/agenda/sites')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as { items: { id: string; name: string }[] };
      // La recepcionista tiene UNA sede: ver la otra sería revelar cómo se
      // organiza la clínica a quien no trabaja allí.
      expect(body.items.map((site) => site.id)).toEqual([siteId]);
      expect(body.items[0]).toEqual({
        id: siteId,
        name: expect.any(String) as string,
      });
    });

    it('AG-107 exige sesión', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/agenda/sites')
        .expect(401);
    });

    it('AG-108 lista los profesionales agendables de la sede, solo id y nombre', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${siteId}/practitioners`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as { items: Record<string, unknown>[] };
      expect(body.items).toHaveLength(2);
      for (const item of body.items) {
        // Nombre y nada más: ni cédula, ni ACESS, ni correo (AG-108).
        expect(Object.keys(item).sort()).toEqual(['fullName', 'id', 'userId']);
      }
      expect(body.items.map((item) => item.id).sort()).toEqual(
        [practitionerId, secondPractitionerId].sort(),
      );
    });

    it('AG-108 rechaza la sede fuera del alcance con SITE_SCOPE_DENIED', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${otherSiteId}/practitioners`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });
  });
});
