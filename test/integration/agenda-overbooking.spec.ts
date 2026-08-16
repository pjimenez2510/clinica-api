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
import { DEFAULT_BOOKING_PARAMETERS } from '../../src/modules/agenda/domain/booking-policy';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import {
  type ClinicalDate,
  WallClockTime,
  addDays,
  atWallClock,
  clinicalDateOf,
  isoWeekdayOf,
} from '../../src/shared/domain/clinic-time';
import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
  setSlotAtom,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * E4 — el sobrecupo y los bloqueos, de extremo a extremo: AG-035 a AG-039,
 * AG-100, AG-101 y AG-103.
 *
 * POR QUÉ CONTRA POSTGRESQL Y NO CONTRA DOBLES. Casi todo lo que E4 garantiza
 * lo garantiza la base o lo deciden filas de otras tablas:
 *
 *   - Que un sobrecupo no pueda existir sin motivo ni autorizador es
 *     `agenda_entry_overbooking_coherence`, un `CHECK`.
 *   - Que quien autoriza TENGA el permiso depende de `user_role_grant`,
 *     `role_permission` y `permission`, tres tablas de otro módulo que la
 *     agenda sólo alcanza por su adaptador.
 *   - Que el tope se cuente por FECHA CLÍNICA es una consulta con dos
 *     instantes resueltos en `America/Guayaquil`: contada en UTC, un sobrecupo
 *     de las 19:30 cae en el día siguiente y el tope deja de limitar las
 *     tardes. Un doble que devuelve el número que le pedimos no distingue las
 *     dos versiones.
 *   - Que un bloqueo obedezca las mismas reglas de solapamiento que una cita
 *     (AG-037) ES el `EXCLUDE USING gist`, cuyo predicado nunca miró `kind`.
 *
 * LAS FECHAS SE CALCULAN, no se fijan: la ventana de reserva de la sede compara
 * contra el instante actual (AG-031 a AG-033), y un lunes fijo se convierte en
 * pasado en cuanto el calendario lo alcanza.
 */
const PASSWORD = 'el caballo come alfalfa';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';
const MEDICO_EMAIL = 'medico.autoriza@clinica.ec';
/** Cédulas sintéticas con dígito verificador CALCULADO; de nadie real. */
const RECEPCION_CEDULA = '1710034065';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

/** El primer lunes al menos `minDaysAhead` días después, en Ecuador. */
function mondayAhead(from: Date, minDaysAhead: number): ClinicalDate {
  let date = addDays(clinicalDateOf(from), minDaysAhead);
  while (isoWeekdayOf(date) !== 1) date = addDays(date, 1);
  return date;
}

/** Esa fecha ecuatoriana a esa hora de pared, como el instante que de verdad es. */
const at = (date: ClinicalDate, time: string): Date =>
  atWallClock(date, WallClockTime.parse(time));

describe('el sobrecupo y los bloqueos', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  /** Quien RESERVA: recepción, con `agenda:write` sobre la sede. */
  let token: string;
  let recepcionUserId: string;
  /** Quien AUTORIZA: el médico que atenderá la urgencia (D-005). */
  let doctorUserId: string;

  let siteId: string;
  let practitionerId: string;
  let patientId: string;
  let monday: ClinicalDate;

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

    monday = mondayAhead(new Date(), 14);
    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    siteId = site.id;
    practitionerId = practitioner.id;
    patientId = patient.id;

    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    // Lunes, 08:00–12:00. Cupos de veinte minutos, para que un inicio a las
    // 08:10 sea justo lo que AG-104 rechaza y el sobrecupo excusa.
    await setSlotAtom(prisma, site.id, 20);
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
    );

    await syncAuthorisation(prisma);
    // La caché de rol→permisos se indexa por id, y al truncar se recrean con
    // ids nuevos: sin esto todas las peticiones responden 403.
    registry.invalidate();

    recepcionUserId = await createUser(RECEPCION_EMAIL, RECEPCION_CEDULA);
    doctorUserId = await createUser(MEDICO_EMAIL, null);
    await grant(recepcionUserId, 'RECEPCION');
    await grant(doctorUserId, 'MEDICO');

    token = await signIn(RECEPCION_EMAIL);
  }

  async function createUser(
    email: string,
    cedula: string | null,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    return user.id;
  }

  async function grant(userId: string, roleCode: string): Promise<void> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId, roleId: role.id, siteId },
    });
  }

  /** Concede un permiso a un rol A MANO, como haría la pantalla de roles. */
  async function grantPermissionToRole(
    roleCode: string,
    permissionCode: string,
  ): Promise<void> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionCode },
    });
    registry.invalidate();
  }

  async function signIn(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const book = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const blockAgenda = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/blocks`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Veinte minutos desde ese instante: un cupo de la regla. */
  const aSlotAt = (startsAt: Date) => ({
    patientId,
    practitionerId,
    bookingChannel: 'PHONE',
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 20 * 60_000).toISOString(),
  });

  /** Ese mismo cupo, declarado sobrecupo y autorizado por el médico. */
  const anOverbookingAt = (
    startsAt: Date,
    overrides: Record<string, unknown> = {},
  ) => ({
    ...aSlotAt(startsAt),
    overbooking: true,
    overbookingReason: 'Urgencia dental',
    overbookingAuthorisedById: doctorUserId,
    ...overrides,
  });

  describe('AG-035, AG-036 · la constancia de la excepción', () => {
    it('AG-035 crea el sobrecupo con motivo y autorizador, y quien reserva no es quien autoriza', async () => {
      // Y a las 08:10, que es lo que AG-104 rechaza en una reserva normal: el
      // sobrecupo es la vía que conserva ese caso DENTRO del sistema (D-007).
      const response = await book(anOverbookingAt(at(monday, '08:10'))).expect(
        201,
      );

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      expect(stored.blocksCalendar).toBe(false);
      expect(stored.overbookingReason).toBe('Urgencia dental');
      expect(stored.overbookingAuthorisedById).toBe(doctorUserId);
      // LA SEPARACIÓN, en la fila: dos columnas, dos personas distintas.
      expect(stored.createdById).toBe(recepcionUserId);
      expect(stored.overbookingAuthorisedById).not.toBe(stored.createdById);
    });

    it('AG-036 expone el indicador y el motivo en el listado del día, sin exponer el motivo de consulta', async () => {
      await book(
        anOverbookingAt(at(monday, '08:10'), { reason: 'Dolor torácico' }),
      ).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${siteId}/entries`)
        .query({ date: monday })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const [entry] = (response.body as { items: Record<string, unknown>[] })
        .items;
      // Distinguible SIN consultar otra vez, que es lo que pide AG-036.
      expect(entry).toMatchObject({
        blocksCalendar: false,
        overbookingReason: 'Urgencia dental',
        overbookingAuthorisedById: doctorUserId,
      });
      // Y el motivo de CONSULTA sigue fuera del listado (AG-072, AG-074):
      // son dos columnas distintas justamente para que esto sea cierto sin
      // ninguna condición en el serializador.
      expect(JSON.stringify(response.body)).not.toContain('Dolor torácico');
    });

    it('AG-035 la BASE rechaza un sobrecupo sin constancia, venga de donde venga', async () => {
      // El servicio lo exige, el DTO lo exige, y esto es lo que queda cuando
      // la escritura llega por `psql` o por una importación de datos.
      await expect(
        prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            siteId,
            practitionerId,
            patientId,
            startsAt: at(monday, '09:00'),
            endsAt: at(monday, '09:20'),
            bookingChannel: 'PHONE',
            blocksCalendar: false,
          },
        }),
      ).rejects.toThrow(/agenda_entry_overbooking_coherence/);
    });

    it('AG-035 la BASE rechaza una cita normal que diga haber sido autorizada', async () => {
      // La otra dirección de la bicondicional: una cita que ocupa calendario
      // con un autorizador escrito afirma que alguien autorizó algo que no
      // hacía falta autorizar.
      await expect(
        prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            siteId,
            practitionerId,
            patientId,
            startsAt: at(monday, '09:00'),
            endsAt: at(monday, '09:20'),
            bookingChannel: 'PHONE',
            overbookingReason: 'Urgencia',
            overbookingAuthorisedById: doctorUserId,
          },
        }),
      ).rejects.toThrow(/agenda_entry_overbooking_coherence/);
    });

    it('AG-035 rechaza el sobrecupo sin motivo por campo, y no escribe nada', async () => {
      const response = await book(
        anOverbookingAt(at(monday, '08:10'), { overbookingReason: undefined }),
      ).expect(422);

      expect((response.body as Problem).errors?.[0]).toMatchObject({
        field: 'overbookingReason',
      });
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });
  });

  describe('AG-101, AG-103 · quién autoriza', () => {
    it('AG-103 rechaza que quien reserva se autorice a sí mismo y NO crea la entrada', async () => {
      const response = await book(
        anOverbookingAt(at(monday, '08:10'), {
          overbookingAuthorisedById: recepcionUserId,
        }),
      ).expect(403);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SELF_AUTHORISATION_DENIED');
      expect(problem.title).toBe(
        'Un sobrecupo lo autoriza otra persona, no quien lo agenda. Indique al profesional que lo autoriza',
      );
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-103 admite la autoautorización de quien tiene `agenda:overbook:self`', async () => {
      // El médico de guardia a las 21:00 sin nadie más conectado (D-005). El
      // permiso se concede A MANO, como AU-035 hace con `user:reset-mfa`:
      // ningún rol lo trae de fábrica.
      await grantPermissionToRole('RECEPCION', 'agenda:overbook');
      await grantPermissionToRole('RECEPCION', 'agenda:overbook:self');

      const response = await book(
        anOverbookingAt(at(monday, '08:10'), {
          overbookingAuthorisedById: recepcionUserId,
        }),
      ).expect(201);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      // El rastro no depende de por qué camino se pasó: sigue diciendo QUIÉN.
      expect(stored.overbookingAuthorisedById).toBe(recepcionUserId);
    });

    it('AG-101 rechaza al autorizador que no tiene el permiso, y NO crea la entrada', async () => {
      const strangerId = await createUser('sin.permiso@clinica.ec', null);

      const response = await book(
        anOverbookingAt(at(monday, '08:10'), {
          overbookingAuthorisedById: strangerId,
        }),
      ).expect(403);

      expect((response.body as Problem).code).toBe(
        'OVERBOOKING_NOT_AUTHORISED',
      );
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-101 rechaza igual a un autorizador que no existe: no es un oráculo de cuentas', async () => {
      const response = await book(
        anOverbookingAt(at(monday, '08:10'), {
          overbookingAuthorisedById: '00000000-0000-4000-8000-00000000dead',
        }),
      ).expect(403);

      expect((response.body as Problem).code).toBe(
        'OVERBOOKING_NOT_AUTHORISED',
      );
    });

    it('AG-101 rechaza al autorizador cuyo permiso vale en OTRA sede', async () => {
      // AU-011: un `user_role_grant` con sede no autoriza fuera de ella, y el
      // sobrecupo se autoriza donde ocurre.
      const other = await createSite(prisma, 'Sede Sur');
      const foreignId = await createUser('medico.otra@clinica.ec', null);
      const medico = await prisma.role.findUniqueOrThrow({
        where: { code: 'MEDICO' },
      });
      await prisma.userRoleGrant.create({
        data: { userId: foreignId, roleId: medico.id, siteId: other.id },
      });

      await book(
        anOverbookingAt(at(monday, '08:10'), {
          overbookingAuthorisedById: foreignId,
        }),
      ).expect(403);
    });

    it('AG-101 obedece el permiso que la SEDE configura, no uno quemado en el código', async () => {
      // Si la sede exige `agenda:overbook:self`, el médico que sólo tiene
      // `agenda:overbook` deja de poder autorizar. Sin esto, el parámetro
      // sería decorado.
      await prisma.siteParameter.update({
        where: { siteId },
        data: { overbookingPermission: 'agenda:overbook:self' },
      });

      const response = await book(anOverbookingAt(at(monday, '08:10'))).expect(
        403,
      );

      expect((response.body as Problem).code).toBe(
        'OVERBOOKING_NOT_AUTHORISED',
      );
    });
  });

  describe('AG-100 · el tope por fecha clínica', () => {
    it('AG-100 cuenta el tope en America/Guayaquil: el sobrecupo de las 19:30 es del MISMO día', async () => {
      /**
       * EL BORDE QUE OBLIGA A CONTAR EN ECUADOR. Las 19:30 del lunes son
       * `T00:30Z` del martes. Con el tope de D-001 en dos, si el segundo
       * sobrecupo contara contra el martes, este tercero de las 10:10 del
       * lunes se aceptaría — y el tope dejaría de limitar las tardes, que es
       * justo cuando se abusa de él.
       */
      await book(anOverbookingAt(at(monday, '08:10'))).expect(201);
      await book(anOverbookingAt(at(monday, '19:30'))).expect(201);

      const response = await book(anOverbookingAt(at(monday, '10:10'))).expect(
        409,
      );

      const problem = response.body as Problem;
      expect(problem.code).toBe('OVERBOOKING_LIMIT_REACHED');
      expect(problem.title).toBe(
        'Este profesional ya tiene los 2 sobrecupos que admite la sede ese día',
      );
      // Dos escritos, el tercero rechazado antes de escribir nada.
      await expect(
        prisma.agendaEntry.count({ where: { blocksCalendar: false } }),
      ).resolves.toBe(2);
    });

    it('AG-100 no arrastra el tope al día siguiente', async () => {
      // La misma regla semanal cubre el lunes siguiente: no caduca.
      const nextMonday = addDays(monday, 7);

      await book(anOverbookingAt(at(monday, '08:10'))).expect(201);
      await book(anOverbookingAt(at(monday, '19:30'))).expect(201);

      // Otro día clínico, tope entero disponible.
      await book(anOverbookingAt(at(nextMonday, '08:10'))).expect(201);
    });

    it('AG-100 devuelve el cupo al liberarse: una anulación no gasta el tope del día', async () => {
      const first = await book(anOverbookingAt(at(monday, '08:10'))).expect(
        201,
      );
      await book(anOverbookingAt(at(monday, '09:10'))).expect(201);

      await request(app.getHttpServer())
        .post(
          `/api/v1/agenda/sites/${siteId}/entries/${(first.body as { id: string }).id}/status`,
        )
        .set('Authorization', `Bearer ${token}`)
        .send({ to: 'CANCELLED', reason: 'El paciente no puede venir' })
        .expect(200);

      // Gastar un tope en una cita que nadie va a atender rechazaría una
      // urgencia real por una excepción que ya se devolvió.
      await book(anOverbookingAt(at(monday, '10:10'))).expect(201);
    });
  });

  describe('AG-039, AG-094 · el interruptor de la sede', () => {
    it('AG-094 crea la sede con el sobrecupo HABILITADO, y es la base quien lo escribe', async () => {
      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId },
      });

      // Y coincide con el defecto que el dominio de la agenda opera cuando no
      // hay fila: dos copias que no pueden separarse en silencio.
      expect(stored.overbookingEnabled).toBe(
        DEFAULT_BOOKING_PARAMETERS.overbookingEnabled,
      );
      expect(stored.overbookingPermission).toBe(
        DEFAULT_BOOKING_PARAMETERS.overbookingPermission,
      );
      expect(stored.overbookingCap).toBe(
        DEFAULT_BOOKING_PARAMETERS.overbookingCap,
      );
    });

    it('AG-039 rechaza cualquier sobrecupo en una sede que lo tiene deshabilitado', async () => {
      await prisma.siteParameter.update({
        where: { siteId },
        data: { overbookingEnabled: false },
      });

      const response = await book(anOverbookingAt(at(monday, '08:10'))).expect(
        422,
      );

      const problem = response.body as Problem;
      expect(problem.code).toBe('OVERBOOKING_NOT_ALLOWED');
      expect(problem.title).toBe(
        'Esta sede no admite sobrecupos. Busque un cupo libre o pida que se habilite el sobrecupo para la sede',
      );
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-039 no impide la reserva ordinaria en esa misma sede', async () => {
      // Deshabilitar el sobrecupo cierra la excepción, no la agenda.
      await prisma.siteParameter.update({
        where: { siteId },
        data: { overbookingEnabled: false },
      });

      await book(aSlotAt(at(monday, '08:00'))).expect(201);
    });
  });

  describe('AG-037, AG-038 · los bloqueos', () => {
    it('AG-037 crea el bloqueo sin paciente, sin canal y en estado BLOCKED', async () => {
      const response = await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '10:00').toISOString(),
        reason: 'Quirófano',
      }).expect(201);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      expect(stored.kind).toBe('BLOCK');
      expect(stored.status).toBe('BLOCKED');
      expect(stored.patientId).toBeNull();
      expect(stored.bookingChannel).toBeNull();
      expect(stored.blocksCalendar).toBe(true);
    });

    it('AG-037 hace que el bloqueo ocupe calendario como una cita: el cupo deja de poder reservarse', async () => {
      // ES EL `EXCLUDE`, cuyo predicado nunca miró `kind`. Sin él, bloquear un
      // quirófano no impediría agendar dentro.
      await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '10:00').toISOString(),
      }).expect(201);

      const response = await book(aSlotAt(at(monday, '08:20'))).expect(409);

      expect((response.body as Problem).code).toBe('PRACTITIONER_SLOT_TAKEN');
    });

    it('AG-037 tampoco deja bloquear dos veces el mismo intervalo', async () => {
      await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '10:00').toISOString(),
      }).expect(201);

      await blockAgenda({
        practitionerId,
        startsAt: at(monday, '09:00').toISOString(),
        endsAt: at(monday, '11:00').toISOString(),
      }).expect(409);
    });

    it('AG-038 rechaza el bloqueo ENUMERANDO las citas que lo impiden', async () => {
      await book(aSlotAt(at(monday, '08:00'))).expect(201);
      await book(aSlotAt(at(monday, '09:00'))).expect(201);

      const response = await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '12:00').toISOString(),
      }).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('BLOCK_OVERLAPS_APPOINTMENTS');
      // La lista es la mitad útil del requisito: sin ella hay que buscarlas a
      // mano, cita por cita, en la agenda del día.
      // LA ENUMERACIÓN QUE LLEGA AL CLIENTE ES LA FRASE, y son las horas: el
      // documento RFC 9457 de este sistema sirve `code`, `title`, `detail` y
      // `errors`, nunca los `params` del error. Con la hora, recepción abre
      // esas citas en la agenda del día; sin la lista tendría que buscarlas
      // una a una, que es lo que AG-038 viene a evitar.
      expect(problem.errors?.[0]?.message).toBe(
        'Hay 2 citas dentro de ese intervalo: 08:00, 09:00',
      );
      // Y no se escribió el bloqueo.
      await expect(
        prisma.agendaEntry.count({ where: { kind: 'BLOCK' } }),
      ).resolves.toBe(0);
    });

    it('AG-072, AG-074 no dice el nombre ni el motivo de consulta de esas citas', async () => {
      // SC-006. El mensaje llega al registro del servidor y a una captura de
      // soporte; AG-109 concede el nombre al LISTADO del día, que es otra ruta
      // con su permiso y su alcance por sede.
      await book({
        ...aSlotAt(at(monday, '08:00')),
        reason: 'Dolor torácico',
      }).expect(201);

      const response = await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '12:00').toISOString(),
      }).expect(409);

      const served = JSON.stringify(response.body);
      expect(served).not.toContain('Guamán');
      expect(served).not.toContain('María');
      expect(served).not.toContain('Dolor torácico');
      expect(served).not.toContain(patientId);
    });

    it('AG-038 no cuenta las citas liberadas: una anulada no impide bloquear', async () => {
      const booked = await book(aSlotAt(at(monday, '08:00'))).expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/agenda/sites/${siteId}/entries/${(booked.body as { id: string }).id}/status`,
        )
        .set('Authorization', `Bearer ${token}`)
        .send({ to: 'CANCELLED', reason: 'El paciente no puede venir' })
        .expect(200);

      await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '12:00').toISOString(),
      }).expect(201);
    });

    it('AG-038 no cuenta un sobrecupo: no ocupa calendario y no impide bloquear', async () => {
      // Coherente con el `EXCLUDE`, que tampoco lo mira: el sobrecupo es una
      // excepción declarada, y el bloqueo no tiene por qué arbitrar sobre ella.
      await book(anOverbookingAt(at(monday, '08:10'))).expect(201);

      await blockAgenda({
        practitionerId,
        startsAt: at(monday, '08:00').toISOString(),
        endsAt: at(monday, '12:00').toISOString(),
      }).expect(201);
    });

    it('AG-022 rechaza por campo un bloqueo que termina antes de empezar', async () => {
      const response = await blockAgenda({
        practitionerId,
        startsAt: at(monday, '10:00').toISOString(),
        endsAt: at(monday, '08:00').toISOString(),
      }).expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('endsAt');
    });
  });
});
