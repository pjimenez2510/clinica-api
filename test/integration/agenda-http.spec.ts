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
import { closeApp, listenForTests } from './setup/http-server';

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

/** Fijo, para que la especialidad se cree una sola vez por prueba. */
const SPECIALTY_ID = '00000000-0000-4000-8000-0000000000a1';

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
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    // Se siembra ANTES DE CADA PRUEBA: `useDatabase` trunca entre pruebas, así
    // que sembrar una sola vez deja la primera con datos y el resto sin nada.
    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
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
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
      );
    }

    // AG-031, desde E7: la sede admite reservar en el pasado, y es lo que
    // mantiene vivo el lunes fijo de este fichero. Las citas se fijan al 14 de
    // septiembre de 2026 para que la regla semanal y las horas de Ecuador sean
    // deterministas, y esa fecha deja de ser futura en cuanto el calendario la
    // pasa: sin esto, la mitad de este fichero empezaría a responder
    // `BOOKING_IN_THE_PAST` un martes cualquiera. La ventana de reserva tiene
    // su propio fichero, `agenda-parameters.spec.ts`.
    await prisma.siteParameter.update({
      where: { siteId: site.id },
      // D-021: veinte minutos de átomo, que es la rejilla con la que se
      // escribió este fichero entero. La sede nace con diez.
      data: { allowPastBooking: true, slotAtomMinutes: 20 },
    });

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
        // Enlace e instante van juntos: `patient_merged_at_matches_link` lo
        // exige, para que un deshacer esté completo o no ocurra (PA-047).
        data: { mergedIntoId: surviving.id, mergedAt: new Date() },
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

    it('AG-110 responde 201 con la advertencia del feriado, y nunca un 4xx', async () => {
      // La contradicción que encontró la revisión adversarial de E7: la
      // disponibilidad decía «cerrado» y la reserva respondía 201 sin decir
      // nada. Sigue respondiendo 201 —el feriado no bloquea (D-019)— y ahora
      // lo dice.
      await prisma.holiday.create({
        // Día civil, no instante: una `date` viaja como medianoche UTC.
        data: { date: new Date('2026-09-14T00:00:00.000Z'), name: 'Navidad' },
      });

      const response = await book(anAppointment()).expect(201);

      const body = response.body as { id: string; warnings: string[] };
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain('Navidad');
      // Una respuesta correcta, no un problema: nada de RFC 9457 aquí.
      expect(response.headers['content-type']).not.toContain('problem+json');
      await expect(
        prisma.agendaEntry.findUnique({ where: { id: body.id } }),
      ).resolves.not.toBeNull();
    });

    it('AG-110 no advierte nada en una reserva de un día ordinario', async () => {
      const response = await book(anAppointment()).expect(201);

      // Presente y vacío: el cliente no tiene que distinguir «sin
      // advertencias» de «este endpoint no las trae».
      expect((response.body as { warnings: string[] }).warnings).toEqual([]);
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

  describe('abrir la ficha desde la cita', () => {
    const openChart = (patient: string, query = '') =>
      request(app.getHttpServer())
        .get(`/api/v1/patients/${patient}${query}`)
        .set('Authorization', `Bearer ${token}`)
        .set('User-Agent', 'mostrador-3');

    const bookedEntryId = async (): Promise<string> =>
      ((await book(anAppointment()).expect(201)).body as { id: string }).id;

    it('AG-073 deja una fila con quién, qué, cuándo, desde qué equipo y desde qué cita', async () => {
      const entryId = await bookedEntryId();

      await openChart(patientId, `?agendaEntryId=${entryId}`).expect(200);

      const rows = await prisma.accessAudit.findMany({
        where: { resourceType: 'patient', resourceId: patientId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId,
        action: 'READ',
        userAgent: 'mostrador-3',
        contextType: 'agenda_entry',
        contextId: entryId,
      });
      expect(rows[0]?.ip).toBeTruthy();
      expect(rows[0]?.occurredAt).toBeInstanceOf(Date);
    });

    it('AG-073 abierta desde Pacientes, la fila no dice que se llegó desde la agenda', async () => {
      await openChart(patientId).expect(200);

      const row = await prisma.accessAudit.findFirstOrThrow({
        where: { resourceType: 'patient', resourceId: patientId },
      });
      expect(row.contextType).toBeNull();
      expect(row.contextId).toBeNull();
    });

    it('AG-073 rechaza abrir desde la cita de otro paciente, y no deja fila', async () => {
      const entryId = await bookedEntryId();
      const stranger = await createPatient(prisma);

      const response = await openChart(
        stranger.id,
        `?agendaEntryId=${entryId}`,
      ).expect(404);

      expect((response.body as Problem).code).toBe('ACCESS_CONTEXT_NOT_FOUND');
      await expect(
        prisma.accessAudit.count({ where: { resourceId: stranger.id } }),
      ).resolves.toBe(0);
    });

    it('AG-073 rechaza abrir desde una cita de una sede sin alcance, con el mismo código', async () => {
      await linkPractitionerToSite(prisma, secondPractitionerId, otherSiteId);
      const foreign = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: otherSiteId,
          practitionerId: secondPractitionerId,
          patientId,
          startsAt: new Date(FIRST_SLOT.startsAt),
          endsAt: new Date(FIRST_SLOT.endsAt),
        },
      });

      const response = await openChart(
        patientId,
        `?agendaEntryId=${foreign.id}`,
      ).expect(404);

      expect((response.body as Problem).code).toBe('ACCESS_CONTEXT_NOT_FOUND');
      await expect(prisma.accessAudit.count()).resolves.toBe(0);
    });

    it('AG-073 rechaza una cita que no existe con el mismo código que una ajena', async () => {
      const response = await openChart(
        patientId,
        '?agendaEntryId=00000000-0000-4000-8000-00000000dead',
      ).expect(404);

      expect((response.body as Problem).code).toBe('ACCESS_CONTEXT_NOT_FOUND');
    });

    it('AG-073 rechaza un identificador de cita mal escrito antes de tocar la base', async () => {
      const response = await openChart(patientId, '?agendaEntryId=ayer').expect(
        422,
      );

      expect((response.body as Problem).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('las listas de referencia', () => {
    interface AgendaSpecialty {
      id: string;
      name: string;
      isPrimary: boolean;
    }

    /** Dos especialidades del catálogo, para poder distinguir «las suyas». */
    async function createSpecialties(): Promise<{
      cardiologia: string;
      pediatria: string;
    }> {
      const [cardiologia, pediatria] = await Promise.all([
        prisma.specialty.create({
          data: { code: 'cardiologia', name: 'Cardiología' },
        }),
        prisma.specialty.create({
          data: { code: 'pediatria', name: 'Pediatría' },
        }),
      ]);
      return { cardiologia: cardiologia.id, pediatria: pediatria.id };
    }

    /** SP-005: una fila de `practitioner_specialty`, con o sin la marca. */
    const assign = (
      practitioner: string,
      specialtyId: string,
      { isPrimary }: { isPrimary: boolean },
    ) =>
      prisma.practitionerSpecialty.create({
        data: { practitionerId: practitioner, specialtyId, isPrimary },
      });

    async function practitionersOf(
      site = siteId,
    ): Promise<{ id: string; specialties: AgendaSpecialty[] }[]> {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${site}/practitioners`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return (
        response.body as {
          items: { id: string; specialties: AgendaSpecialty[] }[];
        }
      ).items;
    }

    const serviceTypesOf = (specialtyId: string, site = siteId) =>
      request(app.getHttpServer())
        .get(
          `/api/v1/agenda/sites/${site}/specialties/${specialtyId}/service-types`,
        )
        .set('Authorization', `Bearer ${token}`);

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
        // Nombre, especialidades y nada más: ni cédula, ni ACESS, ni correo
        // (AG-108). `specialties` entró con AG-111 y trae id, nombre y la
        // marca de principal — nada de la ficha del profesional.
        expect(Object.keys(item).sort()).toEqual([
          'fullName',
          'id',
          'specialties',
          'userId',
        ]);
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

    it('AG-111 acompaña a cada profesional de sus especialidades y señala la principal', async () => {
      const { cardiologia, pediatria } = await createSpecialties();
      await assign(practitionerId, cardiologia, { isPrimary: false });
      await assign(practitionerId, pediatria, { isPrimary: true });

      const items = await practitionersOf();

      const mine = items.find((item) => item.id === practitionerId)!;
      // La PRINCIPAL primero, para que el desplegable la ofrezca sin que la
      // pantalla tenga que reordenar lo que el servidor ya sabe.
      expect(mine.specialties).toEqual([
        { id: pediatria, name: 'Pediatría', isPrimary: true },
        { id: cardiologia, name: 'Cardiología', isPrimary: false },
      ]);
      // Y son SUYAS: el otro profesional no hereda las de éste, que es lo que
      // hacía el diálogo cuando ofrecía el catálogo entero.
      expect(
        items.find((item) => item.id === secondPractitionerId)!.specialties,
      ).toEqual([]);
    });

    it('AG-111 no ofrece una especialidad desactivada aunque el profesional la tenga asignada', async () => {
      // SP-004: desactivada no se ofrece para citas nuevas. La asignación no
      // se borra —AG-111 no toca `practitioner_specialty`—, deja de salir.
      const { cardiologia } = await createSpecialties();
      await assign(practitionerId, cardiologia, { isPrimary: true });
      await prisma.specialty.update({
        where: { id: cardiologia },
        data: { active: false },
      });

      const items = await practitionersOf();

      expect(
        items.find((item) => item.id === practitionerId)!.specialties,
      ).toEqual([]);
      await expect(
        prisma.practitionerSpecialty.count({ where: { practitionerId } }),
      ).resolves.toBe(1);
    });

    it('AG-112 lista los tipos de atención activos de la especialidad con su duración base', async () => {
      const { cardiologia } = await createSpecialties();
      await prisma.serviceType.createMany({
        data: [
          { specialtyId: cardiologia, name: 'Control', durationMinutes: 20 },
          {
            specialtyId: cardiologia,
            name: 'Primera vez',
            durationMinutes: 40,
          },
          {
            specialtyId: cardiologia,
            name: 'Retirado',
            durationMinutes: 20,
            active: false,
          },
        ],
      });

      const response = await serviceTypesOf(cardiologia).expect(200);

      const body = response.body as {
        items: Record<string, unknown>[];
      };
      // El desactivado no está: ofrecerlo sería ofrecer un rechazo (SP-004).
      expect(body.items.map((item) => item.name)).toEqual([
        'Control',
        'Primera vez',
      ]);
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'durationMinutes',
          'id',
          'name',
        ]);
      }
      expect(body.items[0]).toMatchObject({ durationMinutes: 20 });
      expect(body.items[1]).toMatchObject({ durationMinutes: 40 });
    });

    it('AG-112 rechaza la sede fuera del alcance con SITE_SCOPE_DENIED', async () => {
      const { cardiologia } = await createSpecialties();

      const response = await serviceTypesOf(cardiologia, otherSiteId).expect(
        403,
      );

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });

    it('AG-112 exige sesión', async () => {
      const { cardiologia } = await createSpecialties();

      await request(app.getHttpServer())
        .get(
          `/api/v1/agenda/sites/${siteId}/specialties/${cardiologia}/service-types`,
        )
        .expect(401);
    });

    /**
     * EL DEFECTO QUE ESTA ENTREGA CIERRA, dicho como una sola prueba.
     *
     * El selector de especialidad y tipo se construyó en C4 contra
     * `GET /specialties` y `GET /specialties/{id}/service-types`, las dos con
     * `config:read`. El rol que reserva es `RECEPCION` y no lo tiene, así que
     * el desplegable que se hizo PARA recepción era inalcanzable POR recepción
     * y fallaba en silencio.
     *
     * La sesión de este fichero es la de una recepcionista de verdad —rol
     * `RECEPCION` sembrado por `syncAuthorisation`, con su grant en una sede—,
     * y por eso el 403 de abajo es la reproducción del defecto y no un
     * decorado: si alguien concediera `config:read` a recepción, esta prueba
     * fallaría y habría que releerla, que es exactamente lo que se quiere.
     */
    it('AG-111, AG-112 recepción arma el selector de reserva sin config:read', async () => {
      const { cardiologia } = await createSpecialties();
      await assign(practitionerId, cardiologia, { isPrimary: true });
      await prisma.serviceType.create({
        data: {
          specialtyId: cardiologia,
          name: 'Control',
          durationMinutes: 20,
        },
      });

      // La puerta de administración sigue cerrada para quien reserva: es el
      // defecto, no un efecto colateral.
      await request(app.getHttpServer())
        .get('/api/v1/specialties?includeInactive=false')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/specialties/${cardiologia}/service-types`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      // Y la de la agenda, abierta: las dos mitades que el diálogo necesita.
      const specialties = (await practitionersOf()).find(
        (item) => item.id === practitionerId,
      )!.specialties;
      expect(specialties).toEqual([
        { id: cardiologia, name: 'Cardiología', isPrimary: true },
      ]);

      const types = (await serviceTypesOf(cardiologia).expect(200)).body as {
        items: { id: string; name: string; durationMinutes: number }[];
      };
      expect(types.items.map((type) => type.name)).toEqual(['Control']);

      // Y lo elegido reserva de verdad: el selector no vale de nada si el
      // identificador que entrega no cabe en el POST (SP-028).
      const booked = await book(
        anAppointment({ serviceTypeId: types.items[0]!.id }),
      ).expect(201);
      expect((booked.body as { serviceTypeId: string }).serviceTypeId).toBe(
        types.items[0]!.id,
      );
    });
  });

  /**
   * C4: la agenda obedece la configuración (SP-023, SP-028).
   *
   * CONTRA POSTGRESQL DE VERDAD, y no contra un doble, porque lo que se
   * comprueba aquí es precisamente lo que un doble no puede demostrar: que
   * `duration_exception` y `service_type` son las filas que alimentan los dos
   * primeros peldaños, que la clave foránea de `agenda_entry.service_type_id`
   * existe, y que el tipo queda de verdad EN LA FILA de la cita.
   */
  describe('la duración resuelta y el tipo en la cita', () => {
    /** «Control» de Cardiología, veinte minutos: encaja en la rejilla. */
    async function createServiceType(durationMinutes = 20, name = 'Control') {
      const specialty = await prisma.specialty.upsert({
        where: { id: SPECIALTY_ID },
        create: {
          id: SPECIALTY_ID,
          code: 'cardiologia',
          name: 'Cardiología',
        },
        update: {},
      });
      return prisma.serviceType.create({
        data: { specialtyId: specialty.id, name, durationMinutes },
      });
    }

    const durationOf = (query: Record<string, string>, site = siteId) =>
      request(app.getHttpServer())
        .get(
          `/api/v1/agenda/sites/${site}/duration?${new URLSearchParams({
            practitionerId,
            startsAt: FIRST_SLOT.startsAt,
            ...query,
          }).toString()}`,
        )
        .set('Authorization', `Bearer ${token}`);

    it('SP-023 propone la duración base del especialidad·tipo cuando el médico no tiene excepción', async () => {
      const type = await createServiceType(40, 'Primera vez');

      const response = await durationOf({ serviceTypeId: type.id }).expect(200);

      // 40 y no 20: el peldaño del turno de la sede queda por debajo del tipo.
      expect(response.body).toEqual({ minutes: 40 });
    });

    it('SP-023 la excepción del médico gana a la duración base, leída de duration_exception', async () => {
      const type = await createServiceType(40, 'Primera vez');
      await prisma.durationException.create({
        data: {
          practitionerId,
          serviceTypeId: type.id,
          durationMinutes: 60,
        },
      });

      const response = await durationOf({ serviceTypeId: type.id }).expect(200);

      expect(response.body).toEqual({ minutes: 60 });
    });

    it('SP-023 la excepción es de UN médico: el otro sigue con la duración base', async () => {
      const type = await createServiceType(40, 'Primera vez');
      await prisma.durationException.create({
        data: {
          practitionerId: secondPractitionerId,
          serviceTypeId: type.id,
          durationMinutes: 60,
        },
      });

      const response = await durationOf({ serviceTypeId: type.id }).expect(200);

      expect(response.body).toEqual({ minutes: 40 });
    });

    it('SP-023 sin tipo elegido propone el turno de la sede', async () => {
      // D-021 movió el tercer peldaño de la regla a la sede. Sigue
      // condicionado a que HAYA una regla abierta a esa hora: la sede tiene
      // átomo a cualquier hora de la semana y proponer minutos para un domingo
      // que nadie trabaja respondería a otra pregunta.
      const response = await durationOf({}).expect(200);

      expect(response.body).toEqual({ minutes: 20 });
    });

    it('SERVICE_TYPE_NOT_FOUND cuando el tipo elegido no existe', async () => {
      const response = await durationOf({
        serviceTypeId: '00000000-0000-4000-8000-0000000000ff',
      }).expect(404);

      expect((response.body as Problem).code).toBe('SERVICE_TYPE_NOT_FOUND');
    });

    it('AG-071 rechaza proponer una duración en una sede fuera de alcance', async () => {
      const response = await durationOf({}, otherSiteId).expect(403);
      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });

    it('SP-028 reserva con la duración resuelta y deja el tipo registrado en la cita', async () => {
      const type = await createServiceType(40, 'Primera vez');
      const { minutes } = (
        await durationOf({ serviceTypeId: type.id }).expect(200)
      ).body as { minutes: number };

      const response = await book(
        anAppointment({
          serviceTypeId: type.id,
          endsAt: new Date(
            new Date(FIRST_SLOT.startsAt).getTime() + minutes * 60_000,
          ).toISOString(),
        }),
      ).expect(201);

      const created = response.body as { id: string; serviceTypeId: string };
      expect(created.serviceTypeId).toBe(type.id);

      // EN LA FILA, no sólo en la respuesta: es lo que SP-025 necesita para
      // poder rechazar el borrado, y lo que SP-028 llama «dejar el tipo
      // registrado en la cita».
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.serviceTypeId).toBe(type.id);
      // 08:00–08:40 de Ecuador: la duración resuelta, no los veinte de la regla.
      expect(stored.endsAt.toISOString()).toBe('2026-09-14T13:40:00.000Z');
    });

    /**
     * AG-012 SIGUE SIENDO LA GARANTÍA, Y D-021 LE QUITÓ UNA FORMA DE
     * DISPARARSE. Antes, una duración base de 30 sobre una rejilla de 20 era
     * una configuración alcanzable —SP-021 admitía cualquier múltiplo de 5— y
     * la reserva de la propuesta se rechazaba en el mostrador. Hoy esa
     * configuración no se puede guardar (ver `specialties-durations.spec.ts`),
     * así que lo que queda de AG-012 es lo que ningún guardado puede impedir:
     * la API recibe `startsAt` y `endsAt`, no una duración, y un intervalo
     * compuesto a mano sigue estando a un POST de distancia.
     */
    it('AG-012 rechaza un intervalo que no es múltiplo del turno de la sede', async () => {
      const type = await createServiceType(20, 'Control');

      const response = await book(
        anAppointment({
          serviceTypeId: type.id,
          // 08:00–08:30: media hora sobre una rejilla de veinte.
          endsAt: '2026-09-14T13:30:00Z',
        }),
      ).expect(422);

      expect((response.body as Problem).code).toBe('INVALID_SLOT_DURATION');
      expect((response.body as Problem).errors?.[0]?.field).toBe('endsAt');
    });

    it('SP-028 rechaza un tipo de atención que no existe: la clave foránea es la garantía', async () => {
      const response = await book(
        anAppointment({
          serviceTypeId: '00000000-0000-4000-8000-0000000000ff',
        }),
      ).expect(422);

      // Traducido del rechazo de PostgreSQL, igual que un paciente inexistente:
      // la cita no se guarda apuntando a un tipo que no está, y nada se
      // comprobó antes de escribir — la clave foránea es lo que arbitra.
      expect((response.body as Problem).code).toBe('RELATED_RECORD_MISSING');
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });
  });
});
