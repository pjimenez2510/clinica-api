import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import {
  addDays,
  clinicalDateOf,
  startOfClinicalDay,
} from '../../src/shared/domain/clinic-time';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE CAJA TIENE PENDIENTE DE COBRO, CONTRA POSTGRESQL Y POR HTTP (B10).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El defecto que lo origina (revisión del autor, 04-10-2026): una atención
 * cerrada no aparecía en ningún sitio de caja, porque caja sólo listaba
 * cuentas y la cuenta nace del paso a caja que nada alcanzaba.
 *
 * Por HTTP y no contra el servicio: BI-183 promete que la lista NO escribe en
 * la bitácora de accesos, y quien la escribe es la capa de la ficha. Con
 * control positivo: abrir la ficha del mismo paciente sí deja su fila, así que
 * el «cero» de la lista no es una bitácora que no funciona.
 *
 * Ninguna fecha escrita a mano: todo instante se deriva del reloj de la
 * corrida y de la ventana de siete días en Ecuador que calcula `clinic-time`.
 */

const PASSWORD = 'el caballo come alfalfa';

interface Identity {
  id: string;
  mrn: string;
  familyName: string;
  givenName: string;
  document: { type: string; value: string } | null;
}
interface AwaitingRow {
  encounterId: string;
  status: string;
  endedAt: string;
  clinicallyAttended: boolean;
  patient: Identity;
  account: { id: string; status: string } | null;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

describe('caja: lo pendiente de cobro (B10)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let siteId: string;
  let otherSiteId: string;
  let practitionerId: string;
  let authorId: string;
  let payerId: string;
  let priceListId: string;
  /** The first instant of the seven-day window, as the server computes it. */
  let windowStart: Date;
  let now: Date;

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

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    registry.invalidate();

    siteId = (await createSite(prisma)).id;
    otherSiteId = (await createSite(prisma, 'Sede Sur')).id;
    practitionerId = (await createPractitioner(prisma)).id;
    authorId = (await createUser(prisma)).id;
    const payer = await prisma.payer.findUniqueOrThrow({
      where: { code: 'PARTICULAR' },
      select: { id: true, priceLists: { select: { id: true } } },
    });
    payerId = payer.id;
    priceListId = payer.priceLists[0]!.id;

    token = await signIn('caja@clinica.ec', 'CAJA', siteId, '1710034065');

    now = new Date();
    windowStart = startOfClinicalDay(addDays(clinicalDateOf(now), -6));
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: string,
    grantedSiteId: string | null,
    cedula: string,
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
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grantedSiteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /** A patient with a cédula on file, as most charts are. */
  async function patientWithCedula(cedula = '1710034065') {
    const patient = await createPatient(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: patient.id, type: 'CEDULA', value: cedula },
    });
    return patient;
  }

  /**
   * A visit that ended `endedAt`, in the state asked. Written straight to the
   * table: how a visit ends is the encounter module's business, and what is
   * under test is what caja reads afterwards.
   */
  async function visit(options: {
    patientId: string;
    status:
      'OPEN' | 'DISCHARGED' | 'DISCONTINUED' | 'COMPLETED' | 'ENTERED_IN_ERROR';
    endedAt: Date;
    site?: string;
    /** Writes in the note while the visit is still open (BI-180). */
    written?: boolean;
  }): Promise<string> {
    const encounter = await prisma.encounter.create({
      data: {
        siteId: options.site ?? siteId,
        practitionerId,
        patientId: options.patientId,
        startedAt: new Date(options.endedAt.getTime() - 30 * MINUTE_MS),
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
    // Written while open: a note cannot be added to a visit that is over.
    if (options.written) await somethingWasWritten(encounter.id);
    if (options.status === 'OPEN') return encounter.id;

    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: options.status,
        endedAt: options.endedAt,
        ...(options.status === 'DISCHARGED' || options.status === 'COMPLETED'
          ? { dischargeCondition: 'ALIVE' }
          : {}),
        ...(options.status === 'DISCONTINUED'
          ? {
              discontinuedReason: 'Se fue antes de ser atendido',
              discontinuedOrigin: 'PATIENT',
              discontinuedById: authorId,
              discontinuedAt: options.endedAt,
            }
          : {}),
        ...(options.status === 'ENTERED_IN_ERROR'
          ? {
              enteredInErrorReason: 'Paciente equivocado',
              enteredInErrorById: authorId,
              enteredInErrorAt: options.endedAt,
            }
          : {}),
      },
    });
    return encounter.id;
  }

  /** A note with something written: the visit counts as attended (BI-180). */
  async function somethingWasWritten(encounterId: string): Promise<void> {
    const id = randomUUID();
    await prisma.clinicalNote.create({
      data: {
        id,
        chainId: id,
        encounterId,
        formCode: '002',
        formVersion: '1',
        content: { motivoConsulta: 'Dolor de garganta' },
        authorId: practitionerId,
      },
    });
  }

  async function account(
    encounterId: string,
    patientId: string,
    status: 'OPEN' | 'SETTLED' | 'CANCELLED',
  ): Promise<string> {
    const row = await prisma.patientAccount.create({
      data: {
        siteId,
        patientId,
        encounterId,
        payerId,
        priceListId,
        status,
        closedAt: status === 'OPEN' ? null : now,
      },
    });
    return row.id;
  }

  async function awaitingPage(): Promise<{
    items: AwaitingRow[];
    olderCount: number;
  }> {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/billing/sites/${siteId}/encounters/awaiting-checkout`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as { items: AwaitingRow[]; olderCount: number };
  }

  async function awaiting(): Promise<AwaitingRow[]> {
    return (await awaitingPage()).items;
  }

  it('BI-181 lista la atención que el médico cerró y todavía no pasó por caja, sin cuenta', async () => {
    const patient = await patientWithCedula();
    const encounterId = await visit({
      patientId: patient.id,
      status: 'DISCHARGED',
      endedAt: new Date(now.getTime() - HOUR_MS),
      written: true,
    });

    const [row, ...rest] = await awaiting();

    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      encounterId,
      status: 'DISCHARGED',
      clinicallyAttended: true,
      account: null,
    });
  });

  it('BI-181 cuenta siete días de Ecuador contando hoy: el minuto antes de la ventana no está y el de después sí', async () => {
    const patient = await patientWithCedula();
    const before = await visit({
      patientId: patient.id,
      status: 'DISCHARGED',
      endedAt: new Date(windowStart.getTime() - MINUTE_MS),
    });
    const inside = await visit({
      patientId: patient.id,
      status: 'DISCHARGED',
      endedAt: new Date(windowStart.getTime() + MINUTE_MS),
    });

    const page = await awaitingPage();
    const ids = page.items.map((row) => row.encounterId);

    expect(ids).toContain(inside);
    expect(ids).not.toContain(before);
    // D-119: the older one is not dropped in silence — it is counted, and
    // listed when asked for.
    expect(page.olderCount).toBe(1);
    const all = await request(app.getHttpServer())
      .get(
        `/api/v1/billing/sites/${siteId}/encounters/awaiting-checkout?includeOlder=true`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (all.body as { items: AwaitingRow[] }).items.map(
        (row) => row.encounterId,
      ),
    ).toEqual(expect.arrayContaining([inside, before]));
  });

  it('BI-181 la terminada por caja (COMPLETED) sin liquidar se lista, y la de cuenta anulada sale como sin cuenta', async () => {
    const patient = await patientWithCedula();
    const completed = await visit({ patientId: patient.id, status: 'COMPLETED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore
    const cancelled = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - 2 * HOUR_MS) }); // prettier-ignore
    await account(cancelled, patient.id, 'CANCELLED');

    const rows = await awaiting();

    expect(rows.map((row) => row.encounterId)).toContain(completed);
    expect(
      rows.find((row) => row.encounterId === cancelled)?.account,
    ).toBeNull();
  });

  it('BI-181 con cuenta abierta sigue pendiente y dice cuál; liquidada, anulada, en curso o de otra sede no se lista', async () => {
    const patient = await patientWithCedula();
    const recent = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);

    const withOpen = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: recent(1) }); // prettier-ignore
    const openAccountId = await account(withOpen, patient.id, 'OPEN');
    const settled = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: recent(2) }); // prettier-ignore
    await account(settled, patient.id, 'SETTLED');
    const voided = await visit({ patientId: patient.id, status: 'ENTERED_IN_ERROR', endedAt: recent(3) }); // prettier-ignore
    const ongoing = await visit({ patientId: patient.id, status: 'OPEN', endedAt: recent(4) }); // prettier-ignore
    const elsewhere = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: recent(5), site: otherSiteId }); // prettier-ignore

    const rows = await awaiting();
    const ids = rows.map((row) => row.encounterId);

    expect(rows.find((row) => row.encounterId === withOpen)?.account).toEqual({
      id: openAccountId,
      status: 'OPEN',
    });
    for (const absent of [settled, voided, ongoing, elsewhere]) {
      expect(ids).not.toContain(absent);
    }
  });

  it('BI-181 lo más reciente primero', async () => {
    const patient = await patientWithCedula();
    const older = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - 3 * HOUR_MS) }); // prettier-ignore
    const newer = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore

    expect((await awaiting()).map((row) => row.encounterId)).toEqual([
      newer,
      older,
    ]);
  });

  it('BI-182 la interrumpida sin acto clínico se lista y dice que no tiene acto; con algo escrito, sí lo tiene', async () => {
    const patient = await patientWithCedula();
    const leftBeforeBeingSeen = await visit({ patientId: patient.id, status: 'DISCONTINUED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore
    const interruptedAfter = await visit({ patientId: patient.id, status: 'DISCONTINUED', endedAt: new Date(now.getTime() - 2 * HOUR_MS), written: true }); // prettier-ignore

    const rows = await awaiting();
    const attended = (id: string) =>
      rows.find((row) => row.encounterId === id)?.clinicallyAttended;

    expect(attended(leftBeforeBeingSeen)).toBe(false);
    expect(attended(interruptedAfter)).toBe(true);
  });

  it('BI-183 cada atención trae nombre, cédula y HC; el recién nacido sin documento, sólo su HC', async () => {
    const adult = await patientWithCedula('1710034065');
    const newborn = await createPatient(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: newborn.id, type: 'PROVISIONAL', value: 'RN-0001' },
    });
    const adultVisit = await visit({ patientId: adult.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore
    const newbornVisit = await visit({ patientId: newborn.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - 2 * HOUR_MS) }); // prettier-ignore

    const rows = await awaiting();
    const identity = (id: string) =>
      rows.find((row) => row.encounterId === id)?.patient;

    expect(identity(adultVisit)).toMatchObject({
      id: adult.id,
      mrn: adult.mrn,
      familyName: adult.familyName,
      givenName: adult.givenName,
      document: { type: 'CEDULA', value: '1710034065' },
    });
    expect(identity(newbornVisit)).toMatchObject({
      mrn: newborn.mrn,
      document: null,
    });
  });

  it('BI-183 las cuentas de la sede traen nombre, cédula y HC', async () => {
    const patient = await patientWithCedula('1710034065');
    const encounterId = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore
    await account(encounterId, patient.id, 'OPEN');

    const response = await request(app.getHttpServer())
      .get(`/api/v1/billing/sites/${siteId}/accounts?status=OPEN`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const [item] = (response.body as { items: { patient: Identity }[] }).items;

    expect(item?.patient).toMatchObject({
      id: patient.id,
      mrn: patient.mrn,
      document: { type: 'CEDULA', value: '1710034065' },
    });
  });

  it('BI-183 BI-133 listar no escribe un acceso a historia clínica por fila; abrir la ficha sí lo escribe', async () => {
    const patient = await patientWithCedula();
    const encounterId = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore
    await account(encounterId, patient.id, 'OPEN');
    const accessesTo = () =>
      prisma.accessAudit.count({
        where: { resourceType: 'patient', resourceId: patient.id },
      });
    // Every row of the trail, whatever its resource type: a per-row access
    // written under another name would pass a count of `patient` alone.
    const before = await prisma.accessAudit.count();

    await awaiting();
    await request(app.getHttpServer())
      .get(`/api/v1/billing/sites/${siteId}/accounts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await prisma.accessAudit.count()).toBe(before);

    // Control positivo: la bitácora funciona, y abrir la ficha la escribe.
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await accessesTo()).toBeGreaterThan(0);
  });

  it('BI-183 D-118 abrir UNA cuenta registra un acceso a la cuenta, no a la historia; listarlas no registra ninguno', async () => {
    const patient = await patientWithCedula();
    const encounterId = await visit({ patientId: patient.id, status: 'DISCHARGED', endedAt: new Date(now.getTime() - HOUR_MS) }); // prettier-ignore
    const accountId = await account(encounterId, patient.id, 'OPEN');
    const trailOf = () =>
      prisma.accessAudit.findMany({
        where: { resourceType: 'patient_account', resourceId: accountId },
      });

    await request(app.getHttpServer())
      .get(`/api/v1/billing/sites/${siteId}/accounts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await trailOf()).toHaveLength(0);

    await request(app.getHttpServer())
      .get(`/api/v1/billing/sites/${siteId}/accounts/${accountId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const trail = await trailOf();
    expect(trail).toHaveLength(1);
    expect(trail[0]!.action).toBe('READ');
    // Not an access to the clinical record (D-118).
    expect(
      await prisma.accessAudit.count({
        where: { resourceType: 'patient', resourceId: patient.id },
      }),
    ).toBe(0);
  });

  it('BI-131 otra sede no se puede consultar', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/billing/sites/${otherSiteId}/encounters/awaiting-checkout`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
