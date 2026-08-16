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
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
  setSlotAtom,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AG-113 — el alta de paciente sin abandonar la reserva, por el lado que le
 * toca al servidor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ MITAD SE PRUEBA AQUÍ, Y POR QUÉ NO ERA SUFICIENTE LA DE INTERFAZ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Sin abandonar la reserva» es una afirmación sobre un diálogo, y eso lo
 * clavan las pruebas de componente de `BookAppointmentDialog`. Pero
 * «DEBERÁ continuar la reserva con la ficha recién creada» es una afirmación
 * sobre el SERVIDOR: que la ficha que acaba de nacer sirva INMEDIATAMENTE
 * para reservar — misma sesión, mismo rol, sin un segundo permiso, sin un
 * paso de confirmación y sin que la clave foránea la rechace por no estar
 * «completa». Nada de eso lo puede demostrar un doble: es el registro de
 * pacientes, la agenda y la autorización de recepción a la vez.
 *
 * UNA SOLA PRUEBA Y NO DOS PEGADAS. El identificador que se usa para reservar
 * es EL QUE DEVOLVIÓ el alta, nunca uno leído de la base ni creado por un
 * fixture: si el registro devolviera un identificador que la agenda no admite,
 * dos pruebas independientes seguirían pasando las dos.
 */

const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';
/** Lunes 14 de septiembre de 2026, 08:00 en Guayaquil. */
const SLOT = {
  startsAt: '2026-09-14T13:00:00Z',
  endsAt: '2026-09-14T13:20:00Z',
};

interface CreatedPatient {
  id: string;
  mrn: string;
  givenName: string;
  familyName: string;
  isProvisional: boolean;
}

interface BookedAppointment {
  id: string;
  patientId: string;
  patientName: string | null;
  status: string;
}

describe('AG-113 reservar para un paciente que no existía', () => {
  const db = useDatabase();

  let app: NestExpressApplication | undefined;
  let registry: RolePermissionRegistry;
  let prisma: PrismaClient;

  let siteId: string;
  let practitionerId: string;
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
    siteId = site.id;
    await setSlotAtom(prisma, siteId, 20);

    const practitioner = await createPractitioner(prisma);
    practitionerId = practitioner.id;
    await linkPractitionerToSite(prisma, practitionerId, siteId);
    await createScheduleRule(
      prisma,
      { practitionerId, siteId },
      // Lunes de 08:00 a 12:00, hora de pared (AG-002).
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
    );

    token = await signIn();
  }

  async function signIn(): Promise<string> {
    await syncAuthorisation(prisma);
    // La caché rol→permisos se indexa por id y el truncado los recrea con ids
    // nuevos: sin invalidarla, todo responde 403.
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

    const recepcion = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
    });
    // Concedido EN UNA SEDE, que es como se contrata a recepción (AG-071).
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: recepcion.id, siteId },
    });

    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * El alta mínima: lo que recepción puede teclear con el paciente delante.
   *
   * SIN DOCUMENTO A PROPÓSITO. AG-113 dice «la misma ficha de `patients` con
   * lo mínimo, y lo que falte se completa después»; si la reserva exigiera una
   * cédula que el paciente no lleva encima, el alta rápida no serviría para el
   * caso que la motivó y recepción volvería al cuaderno.
   *
   * La cédula que sí aparece más abajo lleva dígito verificador calculado.
   */
  const registerPatient = (body: Record<string, unknown> = {}) =>
    request(app!.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({
        familyName: 'Andrade',
        givenName: 'Rosa',
        sex: 'FEMALE',
        birthDate: '1988-04-12',
        ...body,
      });

  const book = (patientId: string) =>
    request(app!.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, practitionerId, bookingChannel: 'WALK_IN', ...SLOT });

  it('AG-113 recepción crea la ficha y reserva con ella sin ningún paso intermedio', async () => {
    // ── 1. La ficha no existe: es el caso NORMAL en una clínica que crece.
    const created = (await registerPatient().expect(201))
      .body as CreatedPatient;

    expect(created.id).toBeTruthy();
    // LA MISMA FICHA DE `patients`, con número de historia clínica de verdad.
    // `isProvisional` marca que todavía no trae documento —lo que falta se
    // completa después— y NO un segundo modelo de paciente: es la misma tabla,
    // el mismo MRN y la misma ficha que se abrirá en consulta. Inventar una
    // entidad «provisional» aparte sería crear el duplicado que nadie fusiona
    // (AG-113).
    expect(created.mrn).toBeTruthy();
    expect(created.isProvisional).toBe(true);

    // ── 2. Y con ESE identificador, la reserva continúa. Mismo token, misma
    // sesión, sin volver a autenticarse y sin un permiso adicional.
    const booked = (await book(created.id).expect(201))
      .body as BookedAppointment;

    expect(booked.patientId).toBe(created.id);
    expect(booked.status).toBe('BOOKED');
    // AG-109: la rejilla enseña a quién pertenece la hora, y es la persona que
    // se acaba de dar de alta — no un identificador huérfano.
    expect(booked.patientName).toContain('Andrade');

    // ── 3. Y quedó UNA cita colgando de UNA ficha, la recién creada.
    const stored = await prisma.agendaEntry.findUniqueOrThrow({
      where: { id: booked.id },
      select: { patientId: true, siteId: true },
    });
    expect(stored.patientId).toBe(created.id);
    expect(stored.siteId).toBe(siteId);

    const patients = await prisma.patient.findMany({ select: { id: true } });
    expect(patients).toEqual([{ id: created.id }]);
  });

  it('AG-113 el rol de recepción alcanza para dar de alta: no hace falta un administrador', async () => {
    /**
     * LA COMPROBACIÓN QUE CONVIERTE ESTO EN UN REQUISITO Y NO EN UNA
     * CASUALIDAD. `RECEPCION` trae `patient:write` en `default-roles.ts`, y la
     * ruta de alta lo exige con alcance `'global'`. Si alguien estrechara
     * cualquiera de los dos, el diálogo de AG-113 seguiría abriéndose y el
     * botón «Registrar» respondería 403 al paciente que está en el mostrador.
     */
    const grants = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
      select: { permissions: { select: { permission: { select: { code: true } } } } }, // prettier-ignore
    });
    const codes = grants.permissions.map((row) => row.permission.code);

    expect(codes).toContain('patient:write');
    expect(codes).toContain('agenda:write');

    // Y no de palabra: la ruta responde.
    await registerPatient({ givenName: 'Luz', familyName: 'Vera' }).expect(201);
  });

  it('AG-113 un alta con documento sirve igual para reservar acto seguido', async () => {
    // El otro camino real del mostrador: el paciente SÍ trae la cédula. El
    // dígito verificador está calculado, nunca copiado de una persona real.
    const created = (
      await registerPatient({
        identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: '1710034065' }, // prettier-ignore
      }).expect(201)
    ).body as CreatedPatient;

    // Con documento ya no es provisional, y reserva por el mismo camino.
    expect(created.isProvisional).toBe(false);

    const booked = (await book(created.id).expect(201))
      .body as BookedAppointment;

    expect(booked.patientId).toBe(created.id);
  });

  it('AG-113 no deja reservar con un identificador que el alta no devolvió', async () => {
    /**
     * EL CONTRAEJEMPLO QUE HACE NO VACUA A LA PRIMERA PRUEBA. Si la agenda
     * admitiera cualquier UUID, «reservar con la ficha recién creada» no
     * afirmaría nada sobre la ficha: afirmaría que la reserva no mira. La
     * clave foránea contra `patient` es lo que hace que el identificador
     * devuelto por el alta sea el que importa.
     */
    await book('00000000-0000-4000-8000-0000000000ff').expect(422);

    const entries = await prisma.agendaEntry.count();
    expect(entries).toBe(0);
  });
});
