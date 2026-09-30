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
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AG-080, AG-081 against a real PostgreSQL, over HTTP, as recepción.
 *
 * WHY IT CANNOT BE A UNIT TEST. `no-show-metric.spec.ts` proves the rule over
 * a cube somebody handed it; what is proved HERE is that the cube the database
 * builds is the one the rule was written for — that the window is compared
 * against `timestamptz` in Ecuador and not through the session's zone, that a
 * block never lands in a cell, and that a site outside the caller's grant is
 * not in the answer.
 *
 * THE APPOINTMENTS ARE WRITTEN DIRECTLY. Booking each of them through the API
 * would need a schedule rule, a slot grid and a site that admits the past for
 * every row, and none of that is what this measures — the metric reads
 * `agenda_entry` and the columns it reads are set here explicitly.
 */

const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';

interface Rate {
  noShow: number;
  /** AG-140: fuera del numerador, dentro del denominador, y con recuento propio. */
  leftWithoutBeingSeen: number;
  total: number;
  pending: number;
  rate: number | null;
}
interface BySite extends Rate {
  siteId: string;
  siteName: string;
}
interface ByPractitioner extends Rate {
  practitionerId: string;
  practitionerName: string;
}
interface ByChannel extends Rate {
  bookingChannel: string;
}
interface Metric {
  from: string;
  to: string;
  countedUntil: string;
  overall: Rate;
  bySite: BySite[];
  byPractitioner: ByPractitioner[];
  byChannel: ByChannel[];
}

describe('la tasa de inasistencia por HTTP', () => {
  const db = useDatabase();

  let app: NestExpressApplication | undefined;
  let registry: RolePermissionRegistry;
  let prisma: PrismaClient;

  let siteId: string;
  let otherSiteId: string;
  let anaId: string;
  let luisId: string;
  let patientId: string;
  let userId: string;
  let token: string;

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

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    const site = await createSite(prisma, 'Sede Norte');
    const otherSite = await createSite(prisma, 'Sede Sur');
    siteId = site.id;
    otherSiteId = otherSite.id;

    const ana = await createPractitioner(prisma);
    const luis = await createPractitioner(prisma);
    anaId = ana.id;
    luisId = luis.id;
    await linkPractitionerToSite(prisma, anaId, siteId);
    await linkPractitionerToSite(prisma, luisId, siteId);
    await linkPractitionerToSite(prisma, luisId, otherSiteId);

    const patient = await createPatient(prisma);
    patientId = patient.id;

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
    // EN UNA SEDE, no en todas: es lo que hace comprobable AG-071 aquí.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: recepcion.id, siteId },
    });

    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  /** One appointment, written where the metric will find it. */
  async function appointment(input: {
    startsAt: string;
    status:
      | 'BOOKED'
      | 'CONFIRMED'
      | 'CHECKED_IN'
      | 'IN_PROGRESS'
      | 'FULFILLED'
      | 'CANCELLED'
      | 'NO_SHOW'
      // AG-140: los dos desenlaces nuevos entran en la métrica de formas
      // opuestas, y ésa es la razón de que sean dos estados y no uno.
      | 'LEFT_WITHOUT_BEING_SEEN'
      | 'ENTERED_IN_ERROR';
    channel?: 'PHONE' | 'WALK_IN' | 'WEB' | 'REFERRAL';
    practitionerId?: string;
    siteId?: string;
  }) {
    const startsAt = new Date(input.startsAt);
    return prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: input.siteId ?? siteId,
        practitionerId: input.practitionerId ?? anaId,
        patientId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 20 * 60_000),
        status: input.status,
        bookingChannel: input.channel ?? 'PHONE',
        createdById: userId,
        // AG-042, AG-044, AG-116, AG-117: los cuatro estados que devuelven el
        // cupo lo marcan.
        releasedAt: (
          [
            'NO_SHOW',
            'CANCELLED',
            'LEFT_WITHOUT_BEING_SEEN',
            'ENTERED_IN_ERROR',
          ] as string[]
        ).includes(input.status)
          ? startsAt
          : null,
        // AG-121: la base exige que el estado del paciente y su instante estén
        // los dos o ninguno, y quien se fue sin ser atendido salió (AG-127).
        ...(input.status === 'LEFT_WITHOUT_BEING_SEEN'
          ? {
              subjectStatus: 'DEPARTED' as const,
              subjectStatusAt: startsAt,
              // AG-116: desde `20260820121023_agenda_outcomes_and_board` el
              // desenlace tiene instante propio y la base lo exige, que es lo
              // que permite a esta misma métrica filtrar por fecha sobre
              // `agenda_entry` igual que hace con sus tres vecinos.
              leftWithoutBeingSeenAt: startsAt,
            }
          : {}),
        ...(input.status === 'ENTERED_IN_ERROR'
          ? {
              enteredInErrorAt: startsAt,
              enteredInErrorReason: 'Registro de prueba',
            }
          : {}),
      },
    });
  }

  const metricOf = (from: string, to: string) =>
    request(app!.getHttpServer())
      .get(`/api/v1/agenda/metrics/no-show?from=${from}&to=${to}`)
      .set('Authorization', `Bearer ${token}`);

  describe('quién puede pedirla', () => {
    it('AG-070 rechaza sin sesión', async () => {
      await request(app!.getHttpServer())
        .get('/api/v1/agenda/metrics/no-show?from=2026-09-01&to=2026-09-30')
        .expect(401);
    });

    it('AG-071 no incluye una sede sobre la que quien pregunta no tiene alcance', async () => {
      // La misma cita, la misma hora, en la sede que recepción NO tiene
      // concedida. La ruta declara `'query'`: si el handler no estrechara,
      // esta fila estaría en el desglose y recepción de Norte leería Sur.
      await appointment({
        startsAt: '2026-06-08T14:00:00Z',
        status: 'NO_SHOW',
        siteId: otherSiteId,
        practitionerId: luisId,
      });
      await appointment({
        startsAt: '2026-06-08T15:00:00Z',
        status: 'FULFILLED',
      });

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.bySite.map((site) => site.siteName)).toEqual(['Sede Norte']);
      expect(body.overall).toMatchObject({ noShow: 0, total: 1 });
    });
  });

  describe('el cálculo sobre la base', () => {
    it('AG-080 calcula la tasa por profesional, por sede y por canal del rango', async () => {
      await appointment({ startsAt: '2026-06-08T14:00:00Z', status: 'NO_SHOW', channel: 'PHONE' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-08T15:00:00Z', status: 'FULFILLED', channel: 'PHONE' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-09T14:00:00Z', status: 'FULFILLED', channel: 'WEB' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-10T14:00:00Z', status: 'NO_SHOW', channel: 'WALK_IN', practitionerId: luisId }); // prettier-ignore
      await appointment({ startsAt: '2026-06-10T15:00:00Z', status: 'FULFILLED', channel: 'WALK_IN', practitionerId: luisId }); // prettier-ignore
      await appointment({ startsAt: '2026-06-10T16:00:00Z', status: 'FULFILLED', channel: 'WALK_IN', practitionerId: luisId }); // prettier-ignore

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.overall).toMatchObject({
        noShow: 2,
        total: 6,
        rate: 0.3333,
      });

      // Por profesional: Ana 1 de 3, Luis 1 de 3 — y el nombre viaja, porque
      // un informe de identificadores no lo lee nadie.
      expect(body.byPractitioner).toHaveLength(2);
      expect(
        body.byPractitioner.every((row) => row.practitionerName.length > 0),
      ).toBe(true);
      expect(
        body.byPractitioner.find((row) => row.practitionerId === anaId),
      ).toMatchObject({ noShow: 1, total: 3 });

      // Por canal, en el orden de AG-034 y no en el alfabético.
      expect(body.byChannel.map((row) => row.bookingChannel)).toEqual([
        'PHONE',
        'WALK_IN',
        'WEB',
      ]);
      expect(
        body.byChannel.find((row) => row.bookingChannel === 'WALK_IN'),
      ).toMatchObject({ noShow: 1, total: 3 });

      expect(body.bySite).toEqual([
        expect.objectContaining({ siteId, siteName: 'Sede Norte', noShow: 2, total: 6 }), // prettier-ignore
      ]);
    });

    it('AG-081 no cuenta las citas anuladas ni el original de una reprogramación', async () => {
      await appointment({
        startsAt: '2026-06-08T14:00:00Z',
        status: 'NO_SHOW',
      });
      await appointment({ startsAt: '2026-06-08T15:00:00Z', status: 'FULFILLED' }); // prettier-ignore
      // Anuladas: cuatro citas que nunca fueron una inasistencia. Contadas en
      // el denominador la tasa caería a 1/6; contadas en el numerador subiría
      // a 5/6. Ninguna de las dos describe lo que pasó.
      await appointment({ startsAt: '2026-06-08T16:00:00Z', status: 'CANCELLED' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-08T17:00:00Z', status: 'CANCELLED' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-09T14:00:00Z', status: 'CANCELLED' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-09T15:00:00Z', status: 'CANCELLED' }); // prettier-ignore

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.overall).toMatchObject({ noShow: 1, total: 2, rate: 0.5 });
    });

    it('AG-081 cuenta solo las citas que alcanzaron su hora de inicio', async () => {
      /**
       * EL ÚNICO CASO QUE SE MIDE CONTRA EL RELOJ, así que sus fechas son
       * relativas a él: fijadas en el calendario, esta prueba afirmaría lo
       * contrario de lo que dice en cuanto el día que llamó «futuro» pasara.
       *
       * `Intl` directamente y no `clinicalDateOf`: construir con la función
       * que se está probando lo que se le va a preguntar no comprueba nada.
       */
      const ecuadorDate = (instant: Date): string =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Guayaquil',
        }).format(instant);
      const daysFromNow = (days: number): Date =>
        new Date(Date.now() + days * 86_400_000);

      await appointment({
        startsAt: daysFromNow(-10).toISOString(),
        status: 'NO_SHOW',
      });
      await appointment({
        startsAt: daysFromNow(-9).toISOString(),
        status: 'FULFILLED',
      });
      // Dentro de una semana: nadie ha podido faltar a ellas todavía. En el
      // denominador diluirían la tasa de cualquier rango abierto al futuro.
      await appointment({
        startsAt: daysFromNow(7).toISOString(),
        status: 'BOOKED',
      });
      await appointment({
        startsAt: daysFromNow(8).toISOString(),
        status: 'BOOKED',
      });

      const to = ecuadorDate(daysFromNow(30));
      const body = (
        await metricOf(ecuadorDate(daysFromNow(-30)), to).expect(200)
      ).body as Metric;

      expect(body.overall).toMatchObject({ noShow: 1, total: 2, rate: 0.5 });
      // Y lo dice: el periodo pedido llega a dentro de un mes, el contado se
      // detiene ahora.
      expect(new Date(body.countedUntil).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(body.to).toBe(to);
    });

    it('AG-081 mantiene en el denominador la cita cuyo desenlace nadie registró', async () => {
      await appointment({
        startsAt: '2026-06-08T14:00:00Z',
        status: 'NO_SHOW',
      });
      await appointment({ startsAt: '2026-06-08T15:00:00Z', status: 'FULFILLED' }); // prettier-ignore
      // Pasó su hora y sigue abierta. Sacarla del denominador dejaría que la
      // tasa mejorase sola con solo no registrar las ausencias.
      await appointment({ startsAt: '2026-06-08T16:00:00Z', status: 'BOOKED' });
      await appointment({ startsAt: '2026-06-08T17:00:00Z', status: 'CHECKED_IN' }); // prettier-ignore

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.overall).toMatchObject({
        noShow: 1,
        total: 4,
        pending: 2,
        rate: 0.25,
      });
    });

    it('AG-080 no cuenta los bloqueos de agenda como citas', async () => {
      await appointment({
        startsAt: '2026-06-08T14:00:00Z',
        status: 'NO_SHOW',
      });
      // Un bloqueo: sin paciente y sin canal. Nadie falta a un quirófano.
      await prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          siteId,
          practitionerId: anaId,
          startsAt: new Date('2026-06-08T16:00:00Z'),
          endsAt: new Date('2026-06-08T18:00:00Z'),
          status: 'BLOCKED',
          reason: 'Quirófano',
          createdById: userId,
        },
      });

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.overall).toMatchObject({ noShow: 1, total: 1, rate: 1 });
    });

    it('AG-080 responde sin tasa, y no con cero, cuando no hubo citas', async () => {
      const body = (await metricOf('2026-01-01', '2026-01-31').expect(200))
        .body as Metric;

      // `0` diría «nadie faltó» en un mes en que la clínica no abrió.
      expect(body.overall).toEqual({
        noShow: 0,
        leftWithoutBeingSeen: 0,
        total: 0,
        pending: 0,
        rate: null,
      });
      expect(body.bySite).toEqual([]);
    });

    it('AG-140 no cuenta como inasistencia a quien se fue sin ser atendido, y no mueve la tasa', async () => {
      // Vino y llegó a su hora: sacarlo del denominador rebajaría el total
      // sobre el que se mide y mejoraría la tasa de la clínica por el simple
      // hecho de tener gente cansada de esperar.
      await appointment({ startsAt: '2026-06-08T14:00:00Z', status: 'NO_SHOW' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-08T15:00:00Z', status: 'FULFILLED' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-08T16:00:00Z', status: 'LEFT_WITHOUT_BEING_SEEN' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-08T17:00:00Z', status: 'LEFT_WITHOUT_BEING_SEEN' }); // prettier-ignore

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.overall).toMatchObject({
        noShow: 1,
        leftWithoutBeingSeen: 2,
        total: 4,
        // Alguien registró lo que pasó: no es un desenlace pendiente.
        pending: 0,
        rate: 0.25,
      });
    });

    it('AG-140 publica el recuento de quienes se fueron sin ser atendidos en los tres desgloses', async () => {
      // Es lo que el usuario pidió: UNA MÉTRICA PARA PODER REDUCIRLA.
      await appointment({
        startsAt: '2026-06-08T16:00:00Z',
        status: 'LEFT_WITHOUT_BEING_SEEN',
        channel: 'WALK_IN',
      });

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.bySite[0]).toMatchObject({ leftWithoutBeingSeen: 1, total: 1 }); // prettier-ignore
      expect(body.byPractitioner[0]).toMatchObject({ leftWithoutBeingSeen: 1 });
      expect(body.byChannel[0]).toMatchObject({
        bookingChannel: 'WALK_IN',
        leftWithoutBeingSeen: 1,
      });
    });

    it('AG-140 saca ENTERED_IN_ERROR del conjunto entero: una cita que no ocurrió no mide a nadie', async () => {
      await appointment({ startsAt: '2026-06-08T14:00:00Z', status: 'NO_SHOW' }); // prettier-ignore
      await appointment({ startsAt: '2026-06-08T15:00:00Z', status: 'FULFILLED' }); // prettier-ignore
      // Ocho errores de tecleo. Contarlos en el denominador mediría la clínica
      // sobre pacientes imaginarios; contarlos como anulaciones leería la
      // tarde como una tarde en que la clínica canceló a sus pacientes.
      for (let hour = 16; hour < 24; hour += 1) {
        await appointment({
          startsAt: `2026-06-08T${String(hour).padStart(2, '0')}:00:00Z`,
          status: 'ENTERED_IN_ERROR',
        });
      }

      const body = (await metricOf('2026-06-01', '2026-06-30').expect(200))
        .body as Metric;

      expect(body.overall).toMatchObject({
        noShow: 1,
        leftWithoutBeingSeen: 0,
        total: 2,
        rate: 0.5,
      });
    });
  });

  describe('el huso', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL BORDE QUE ESTE PROYECTO YA PAGÓ DOS VECES
     * ═══════════════════════════════════════════════════════════════════════
     *
     * 00:30Z del 30 de septiembre son las 19:30 del 29 de junio en Guayaquil: una
     * consulta vespertina corriente. Un rango que termina el 29 tiene que
     * incluirla, y uno que empieza el 30 tiene que dejarla fuera. Leída en UTC
     * ocurre exactamente lo contrario, y la métrica de la tarde miente.
     */
    const EVENING_OF_THE_29TH = '2026-06-30T00:30:00Z';

    it('AG-001 cuenta la inasistencia de las 19:30 en su día ecuatoriano', async () => {
      await appointment({
        startsAt: EVENING_OF_THE_29TH,
        status: 'NO_SHOW',
      });

      const september = (await metricOf('2026-06-01', '2026-06-29').expect(200))
        .body as Metric;
      expect(september.overall).toMatchObject({ noShow: 1, total: 1 });

      const october = (await metricOf('2026-06-30', '2026-07-31').expect(200))
        .body as Metric;
      expect(october.overall).toMatchObject({ noShow: 0, total: 0 });
    });

    /**
     * LA OTRA MITAD DE ESTA GARANTÍA NO ESTÁ AQUÍ, y decirlo importa. Que el
     * instante ALMACENADO no dependa del huso configurado en el servidor es
     * una propiedad del adaptador, no de esta ruta, y se demuestra donde vive:
     * `clinical-date-timezone.spec.ts`, poniendo la zona por defecto de la
     * base en Asia/Tokyo y abriendo una conexión nueva. Repetirla aquí, con
     * un `SET` sobre una conexión suelta del pool, afirmaría algo que el pool
     * no garantiza y pasaría o fallaría según qué conexión tocara.
     */
  });

  describe('el rango pedido', () => {
    it('rechaza por campo un rango invertido', async () => {
      const problem = (await metricOf('2026-06-30', '2026-06-01').expect(422))
        .body as { code: string; errors?: { field: string }[] };

      expect(problem.errors?.[0]?.field).toBe('to');
    });

    it('rechaza por campo un rango de más de un año', async () => {
      const problem = (await metricOf('2026-01-01', '2028-01-01').expect(422))
        .body as { code: string; errors?: { field: string }[] };

      expect(problem.errors?.[0]?.field).toBe('to');
    });
  });
});
