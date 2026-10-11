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
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { constraintMeaningOf } from '../../src/shared/http/constraint-meanings';

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';

import {
  addDays,
  addMonths,
  clinicalDateOf,
} from '../../src/shared/domain/clinic-time';
import { aTariffConcept, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createEncounter,
  createExamService,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { InProcessLiveEventBus } from '../../src/shared/events/live-event-bus';

/** An account id with no row behind it: `user_role_grant.user_id` is a uuid (ORD-167). */
const SOMEONE = randomUUID();

/**
 * ORD-004, ORD-133. The tariff concept a seeded exam names, under its
 * service's MSP code — the official one since the 2014 tariff (ORD-133).
 */
async function aTariffConceptOf(prisma: PrismaClient, examCode: string) {
  const exam = await prisma.service.findUniqueOrThrow({
    where: { code: examCode },
    select: { mspCode: true },
  });
  return aTariffConcept(prisma, { code: exam.mspCode! });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CATÁLOGO DE EXÁMENES, ADMINISTRADO POR LA CLÍNICA (ORD-103 a ORD-111).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Por HTTP, con una sesión de verdad que tiene `catalog:manage`, sobre la
 * siembra real de caja y exámenes: los servicios con extensión de orden
 * `LAB-BH`, `IMG-RX-TORAX`, `PROC-ECG` (ADR-013, BI-284). El examen se da de
 * alta y se corrige como servicio en facturación (BI-280); aquí, su
 * estructura, sus determinaciones y sus rangos. Lo que garantiza la base —el
 * código congelado, el ayuno, el rango que no apunta a ningún resultado— se
 * prueba contra la base, con su control positivo.
 */

const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string }[];
}
interface AdminExam {
  id: string;
  code: string;
  category: string;
  active: boolean;
  mspCode: string | null;
  analytes: { position: number; isReflex: boolean; analyte: { code: string } }[]; // prettier-ignore
}
interface AdminAnalyte {
  id: string;
  code: string;
  unit: string | null;
  ranges: {
    rangeKind: string;
    sex: string | null;
    low: number | null;
    high: number | null;
  }[];
  usedBy: { code: string }[];
}

describe('el catálogo de exámenes, administrado (E10)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
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

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    await prisma.role.create({
      data: {
        code: 'CATALOGO',
        name: 'Catálogo',
        description: 'Mantiene los catálogos de la clínica.',
        permissions: {
          create: [
            { permissionCode: 'catalog:manage' },
            { permissionCode: 'catalog:read' },
          ],
        },
      },
    });
    registry.invalidate();
    token = await signIn('catalogo@clinica.ec', 'CATALOGO', '0919176818');
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: string,
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
      data: { userId: user.id, roleId: role.id, siteId: null },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const api = () => request(app.getHttpServer());
  const auth = { Authorization: '' };
  const send = (method: 'post' | 'patch' | 'put', path: string, body: object) =>
    api()[method](`/api/v1${path}`).set({ ...auth, Authorization: `Bearer ${token}` }).send(body); // prettier-ignore
  const get = (path: string) =>
    api().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const examCoded = (code: string) =>
    prisma.service.findUniqueOrThrow({ where: { code } });

  /** BI-284. A service of its own with an order extension and no analytes. */
  const aRenalProfile = () =>
    createExamService(prisma, {
      code: 'LAB-PERFIL-RENAL',
      name: 'Perfil renal',
      exam: { form010Section: 'BIOQUÍMICA', specimenType: 'Suero' },
    });

  it('ORD-101 el catálogo que se lee al pedir publica el tipo de cada examen', async () => {
    const orderable = (await get('/exams').expect(200)).body as {
      items: { code: string; category: string }[];
    };
    const byCode = new Map(orderable.items.map((e) => [e.code, e.category]));

    expect(byCode.get('LAB-BH')).toBe('LABORATORY');
    expect(byCode.get('IMG-RX-TORAX')).toBe('IMAGING');
    expect(byCode.get('PROC-ECG')).toBe('PROCEDURE');
  });

  it('ORD-010 los ordenables son los servicios activos con extensión de orden, con el id del servicio', async () => {
    const bh = await examCoded('LAB-BH');
    const retired = await aRenalProfile();
    await prisma.service.update({
      where: { id: retired.id },
      data: { active: false },
    });

    const orderable = (await get('/exams').expect(200)).body as {
      items: { id: string; code: string; name: string; tariffCode: string | null }[]; // prettier-ignore
    };
    const codes = orderable.items.map((e) => e.code);

    // Control positivo: el servicio con extensión sale, con SU id y nombre.
    expect(orderable.items.find((e) => e.code === 'LAB-BH')).toMatchObject({
      id: bh.id,
      name: bh.name,
      // BI-285. La clave conserva su nombre; el valor es el código MSP.
      tariffCode: bh.mspCode,
    });
    // Sin extensión (una química sin ficha de orden) o desactivado, no.
    expect(await prisma.serviceExam.count({ where: { service: { code: 'LAB-QUIMICA' } } })).toBe(0); // prettier-ignore
    expect(codes).not.toContain('LAB-QUIMICA');
    expect(codes).not.toContain('LAB-PERFIL-RENAL');
  });

  it('ORD-103 el alta y la corrección del examen ya no viven aquí: se hacen como servicio', async () => {
    const bh = await examCoded('LAB-BH');

    await get('/exam-catalogue/exams').expect(404);
    await get(`/exam-catalogue/exams/${bh.id}`).expect(404);
    await send('post', '/exam-catalogue/exams', { code: 'LAB-X' }).expect(404);
    await send('patch', `/exam-catalogue/exams/${bh.id}`, { name: 'X' }).expect(404); // prettier-ignore
  });

  it('ORD-140 el código de un servicio ya pedido no cambia: lo garantiza la base', async () => {
    const unordered = await aRenalProfile();
    const { bh } = await anIssuedBloodCount();

    // La BASE, sin pasar por ninguna API.
    await expect(
      prisma.$executeRaw`UPDATE "service" SET "code" = 'LAB-RAW' WHERE "id" = ${bh.id}::uuid`,
    ).rejects.toThrow(/service_code_in_use/);
    expect((await examCoded('LAB-BH')).id).toBe(bh.id);
    // Control positivo: el que nadie pidió sí cambia.
    await expect(
      prisma.$executeRaw`UPDATE "service" SET "code" = 'LAB-PERFIL-RENAL-2' WHERE "id" = ${unordered.id}::uuid`,
    ).resolves.toBe(1);
    // Y la API lo dice con el código del contrato (orders.constraints.ts).
    expect(constraintMeaningOf('service_code_in_use')).toMatchObject({
      code: 'EXAM_CODE_IN_USE',
      field: 'code',
    });
  });

  it('ORD-129 «Pide ayuno» y sus horas se publican al pedir y la base no admite horas sin ayuno', async () => {
    // La semilla marca la glucosa con sus 8 horas, y se publican al pedir.
    const glucose = await examCoded('LAB-GLUCOSA-AYUNAS');
    const orderable = (await get('/exams').expect(200)).body as { items: { id: string; requiresFasting: boolean; fastingHours: number | null }[] }; // prettier-ignore
    expect(orderable.items.find((e) => e.id === glucose.id)).toMatchObject({ requiresFasting: true, fastingHours: 8 }); // prettier-ignore

    const profile = await aRenalProfile();
    // Control positivo: con ayuno, las horas entran.
    await expect(
      prisma.$executeRaw`UPDATE "service_exam" SET "requires_fasting" = true, "fasting_hours" = 8 WHERE "service_id" = ${profile.id}::uuid`,
    ).resolves.toBe(1);
    // Horas sin ayuno, no.
    await expect(
      prisma.$executeRaw`UPDATE "service_exam" SET "requires_fasting" = false WHERE "service_id" = ${profile.id}::uuid`,
    ).rejects.toThrow(/service_exam_fasting_hours_needs_fasting/);
    // 25 horas, tampoco.
    await expect(
      prisma.$executeRaw`UPDATE "service_exam" SET "fasting_hours" = 25 WHERE "service_id" = ${profile.id}::uuid`,
    ).rejects.toThrow(/service_exam_fasting_hours_range/);
    // Y la API lo dice con su código y su campo.
    for (const constraint of [
      'service_exam_fasting_hours_needs_fasting',
      'service_exam_fasting_hours_range',
    ]) {
      expect(constraintMeaningOf(constraint)).toMatchObject({ code: 'EXAM_FASTING_HOURS_INVALID', field: 'fastingHours' }); // prettier-ignore
    }
  });

  it('ORD-104 ORD-105 ORD-111 da de alta dos determinaciones y las pone en el servicio, en su orden', async () => {
    const exam = await aRenalProfile();
    const creatinine = (await send('post', '/exam-catalogue/analytes', {
      code: 'CREA', name: 'Creatinina', valueType: 'NUMERIC', unit: 'mg/dL',
      decimals: 2, allowedValues: null, loincCode: null, active: true,
    }).expect(201)).body as AdminAnalyte; // prettier-ignore
    const urea = (await send('post', '/exam-catalogue/analytes', {
      code: 'UREA', name: 'Urea', valueType: 'NUMERIC', unit: 'mg/dL',
      decimals: 0, allowedValues: null, loincCode: null, active: true,
    }).expect(201)).body as AdminAnalyte; // prettier-ignore

    const structured = (await send('put', `/exam-catalogue/exams/${exam.id}/analytes`, {
      analytes: [
        { analyteDefinitionId: urea.id, isReflex: false },
        { analyteDefinitionId: creatinine.id, isReflex: false },
      ],
    }).expect(200)).body as AdminExam; // prettier-ignore

    expect(structured).toMatchObject({ id: exam.id, code: 'LAB-PERFIL-RENAL', category: 'LABORATORY', active: true }); // prettier-ignore
    expect(
      structured.analytes.map((a) => [a.position, a.analyte.code]),
    ).toEqual([
      [1, 'UREA'],
      [2, 'CREA'],
    ]);
    // Y al pedir, el catálogo publica esas determinaciones (ORD-011).
    const orderable = (await get('/exams').expect(200)).body as { items: { id: string; analytes: { code: string }[] }[] }; // prettier-ignore
    expect(orderable.items.find((e) => e.id === exam.id)?.analytes.map((a) => a.code)).toEqual(['UREA', 'CREA']); // prettier-ignore
    // La determinación dice qué servicios la usan.
    const analyte = (await get('/exam-catalogue/analytes').expect(200)).body as { items: AdminAnalyte[] }; // prettier-ignore
    expect(analyte.items.find((a) => a.code === 'UREA')?.usedBy.map((u) => u.code)).toEqual(['LAB-PERFIL-RENAL']); // prettier-ignore

    // ORD-111, BI-290. La bitácora la nombra como extensión del servicio.
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'service_exam', resourceId: exam.id },
      select: { action: true, after: true },
    });
    expect(trail).toEqual([
      {
        action: 'UPDATE',
        after: {
          analytes: [
            { analyteDefinitionId: urea.id, isReflex: false },
            { analyteDefinitionId: creatinine.id, isReflex: false },
          ],
        },
      },
    ]);
  });

  it('ORD-105 un servicio sin extensión de orden no tiene estructura: EXAM_DEFINITION_NOT_FOUND', async () => {
    const hb = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'HB' } }); // prettier-ignore
    const body = {
      analytes: [{ analyteDefinitionId: hb.id, isReflex: false }],
    };
    const chemistry = await examCoded('LAB-QUIMICA');

    const refused = await send('put', `/exam-catalogue/exams/${chemistry.id}/analytes`, body).expect(404); // prettier-ignore
    expect((refused.body as Problem).code).toBe('EXAM_DEFINITION_NOT_FOUND');
    expect(await prisma.serviceExamAnalyte.count({ where: { serviceId: chemistry.id } })).toBe(0); // prettier-ignore

    // Control positivo: con su extensión, la misma estructura entra.
    await prisma.serviceExam.create({ data: { serviceId: chemistry.id } });
    await send('put', `/exam-catalogue/exams/${chemistry.id}/analytes`, body).expect(200); // prettier-ignore
  });

  it('ORD-104 un numérico sin unidad y un codificado con una sola respuesta se rechazan, nombrando el campo', async () => {
    const noUnit = await send('post', '/exam-catalogue/analytes', {
      code: 'X1', name: 'Sin unidad', valueType: 'NUMERIC', unit: null,
      decimals: 1, allowedValues: null, loincCode: null, active: true,
    }).expect(422); // prettier-ignore
    expect((noUnit.body as Problem).code).toBe('ANALYTE_DEFINITION_INVALID');
    expect((noUnit.body as Problem).errors?.map((e) => e.field)).toContain(
      'unit',
    );

    const oneAnswer = await send('post', '/exam-catalogue/analytes', {
      code: 'X2', name: 'Una respuesta', valueType: 'CODED', unit: null,
      decimals: null, allowedValues: ['Positivo'], loincCode: null, active: true,
    }).expect(422); // prettier-ignore
    expect((oneAnswer.body as Problem).errors?.map((e) => e.field)).toContain('allowedValues'); // prettier-ignore
  });

  it('ORD-105 una determinación que no existe rechaza la estructura entera, y la anterior queda', async () => {
    const bh = await examCoded('LAB-BH');
    const before = await prisma.serviceExamAnalyte.count({ where: { serviceId: bh.id } }); // prettier-ignore

    const refused = await send('put', `/exam-catalogue/exams/${bh.id}/analytes`, {
      analytes: [{ analyteDefinitionId: '00000000-0000-4000-8000-000000000999', isReflex: false }],
    }).expect(404); // prettier-ignore
    expect((refused.body as Problem).code).toBe('ANALYTE_NOT_FOUND');
    expect(await prisma.serviceExamAnalyte.count({ where: { serviceId: bh.id } })).toBe(before); // prettier-ignore
  });

  it('ORD-106 ORD-107 fija los rangos por sexo y crítico, y rechaza dos que se pisan', async () => {
    const hb = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'HB' } }); // prettier-ignore
    const range = (over: object) => ({
      rangeKind: 'REFERENCE', sex: null, ageMinDays: null, ageMaxDays: null,
      low: null, high: null, text: null, ...over,
    }); // prettier-ignore

    const saved = (await send('put', `/exam-catalogue/analytes/${hb.id}/ranges`, {
      ranges: [
        range({ sex: 'MALE', low: 13.5, high: 17.5 }),
        range({ sex: 'FEMALE', low: 12, high: 15.5 }),
        range({ rangeKind: 'CRITICAL', low: 7, high: 20 }),
      ],
    }).expect(200)).body as AdminAnalyte; // prettier-ignore
    expect(saved.ranges).toHaveLength(3);
    expect(saved.usedBy.map((e) => e.code)).toContain('LAB-BH');

    const overlap = await send('put', `/exam-catalogue/analytes/${hb.id}/ranges`, {
      ranges: [range({ low: 12, high: 17 }), range({ low: 11, high: 18 })],
    }).expect(422); // prettier-ignore
    expect((overlap.body as Problem).code).toBe('REFERENCE_RANGE_OVERLAP');
    expect(await prisma.analyteReferenceRange.count({ where: { analyteDefinitionId: hb.id, validTo: null } })).toBe(3); // prettier-ignore
  });

  it('ORD-113 la base no deja borrar ni reescribir un rango; cerrarlo sí, una vez', async () => {
    const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
    const row = await prisma.analyteReferenceRange.findFirstOrThrow({
      where: { analyteDefinitionId: glu.id, rangeKind: 'CRITICAL', validTo: null },
    }); // prettier-ignore
    const refusedBy = async (write: Promise<unknown>) => {
      const error = await write.then(
        () => null,
        (e: unknown) => e,
      );
      return String((error as Error | null)?.message ?? 'aceptado');
    };

    expect(await refusedBy(prisma.analyteReferenceRange.delete({ where: { id: row.id } }))).toMatch(/keeps its history/); // prettier-ignore
    expect(await refusedBy(prisma.analyteReferenceRange.update({ where: { id: row.id }, data: { low: '4' } }))).toMatch(/keeps its history/); // prettier-ignore
    expect(await refusedBy(prisma.$executeRawUnsafe('TRUNCATE "analyte_reference_range" CASCADE'))).toMatch(/keeps its history/); // prettier-ignore

    // Control positivo: cerrar la vigencia entra…
    const closedAt = new Date();
    await prisma.analyteReferenceRange.update({ where: { id: row.id }, data: { validTo: closedAt } }); // prettier-ignore
    // …y una vez cerrada no se reabre ni se le mueve la fecha.
    expect(await refusedBy(prisma.analyteReferenceRange.update({ where: { id: row.id }, data: { validTo: null } }))).toMatch(/keeps its history/); // prettier-ignore
    expect(await refusedBy(prisma.analyteReferenceRange.update({ where: { id: row.id }, data: { validTo: new Date(closedAt.getTime() + 1_000) } }))).toMatch(/keeps its history/); // prettier-ignore
    const kept = await prisma.analyteReferenceRange.findUniqueOrThrow({ where: { id: row.id } }); // prettier-ignore
    expect(kept.low?.toString()).toBe('40');
    expect(kept.validTo).toEqual(closedAt);
  });

  it('ORD-113 la base no deja fabricar historia: un rango nace abierto, y ni se abre ni se cierra antes del último cambio', async () => {
    const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
    const refusedBy = async (write: Promise<unknown>) => {
      const error = await write.then(
        () => null,
        (e: unknown) => e,
      );
      return String((error as Error | null)?.message ?? 'aceptado');
    };
    const latest = await prisma.analyteReferenceRange.findFirstOrThrow({
      where: { analyteDefinitionId: glu.id }, orderBy: { validFrom: 'desc' },
    }); // prettier-ignore
    const before = new Date(latest.validFrom.getTime() - 86_400_000);
    const after = new Date(latest.validFrom.getTime() + 1_000);
    const row = { analyteDefinitionId: glu.id, rangeKind: 'CRITICAL', sex: 'FEMALE', low: '30', high: '450' }; // prettier-ignore

    // Ni una fila ya cerrada, ni una abierta «desde antes» del último cambio.
    expect(await refusedBy(prisma.analyteReferenceRange.create({ data: { ...row, validFrom: after, validTo: new Date(after.getTime() + 1_000) } }))).toMatch(/keeps its history/); // prettier-ignore
    expect(await refusedBy(prisma.analyteReferenceRange.create({ data: { ...row, validFrom: before } }))).toMatch(/keeps its history/); // prettier-ignore
    // Ni cerrar una vigente antes de la apertura más reciente.
    expect(await refusedBy(prisma.analyteReferenceRange.update({ where: { id: latest.id }, data: { validTo: before } }))).toMatch(/keeps its history/); // prettier-ignore

    // Control positivo: abierta y después del último cambio, entra; y se cierra hacia delante.
    const opened = await prisma.analyteReferenceRange.create({ data: { ...row, validFrom: after } }); // prettier-ignore
    const closed = await prisma.analyteReferenceRange.update({ where: { id: opened.id }, data: { validTo: new Date(after.getTime() + 1_000) } }); // prettier-ignore
    expect(closed.validTo).not.toBeNull();
  });

  it('ORD-107 ORD-113 dos guardados a la vez dejan una sola versión vigente por tramo', async () => {
    const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
    const save = (high: number) =>
      send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [range({ low: 70, high: 100 }), range({ rangeKind: 'CRITICAL', low: 40, high })],
      }); // prettier-ignore

    const answers = await Promise.all([save(450), save(500)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);

    const open = await prisma.analyteReferenceRange.findMany({
      where: { analyteDefinitionId: glu.id, validTo: null },
    });
    expect(open.filter((r) => r.rangeKind === 'CRITICAL')).toHaveLength(1);
    expect(open.filter((r) => r.rangeKind === 'REFERENCE')).toHaveLength(1);
    // Control positivo: los dos guardados llegaron, y el primero quedó en la historia.
    expect(await prisma.analyteReferenceRange.count({ where: { analyteDefinitionId: glu.id, rangeKind: 'CRITICAL' } })).toBe(3); // prettier-ignore
  });

  it('ORD-113 ORD-114 sustituir los rangos cierra lo que cambia, deja abierto lo igual y lo guarda en el historial', async () => {
    const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
    const before = await prisma.analyteReferenceRange.findMany({
      where: { analyteDefinitionId: glu.id, validTo: null },
    });
    const reference = before.find((r) => r.rangeKind === 'REFERENCE')!;
    const critical = before.find((r) => r.rangeKind === 'CRITICAL')!;

    await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
      ranges: [
        range({ low: 70, high: 100 }),
        range({ rangeKind: 'CRITICAL', low: 40, high: 500 }),
      ],
    }).expect(200); // prettier-ignore

    const rows = await prisma.analyteReferenceRange.findMany({ where: { analyteDefinitionId: glu.id } }); // prettier-ignore
    // La referencia no cambió: es la MISMA fila, abierta.
    expect(rows.find((r) => r.id === reference.id)?.validTo).toBeNull();
    // El crítico de 400 sigue ahí, cerrado; el de 500 rige desde el mismo instante.
    const closed = rows.find((r) => r.id === critical.id)!;
    const opened = rows.find((r) => r.validTo === null && r.rangeKind === 'CRITICAL')!; // prettier-ignore
    expect(closed.validTo).not.toBeNull();
    expect(opened.high?.toString()).toBe('500');
    expect(opened.validFrom).toEqual(closed.validTo);
    expect(rows).toHaveLength(3);

    // Lo que se administra y lo que clasifica sólo ve las vigentes, y en un
    // orden que no cambia al editar: la referencia sigue primera aunque el
    // crítico sea la fila más reciente.
    const current = (await get(`/exam-catalogue/analytes`).expect(200)).body as { items: AdminAnalyte[] }; // prettier-ignore
    expect(current.items.find((a) => a.code === 'GLU')?.ranges).toHaveLength(2);
    await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
      ranges: [range({ low: 70, high: 110 }), range({ rangeKind: 'CRITICAL', low: 40, high: 500 })],
    }).expect(200); // prettier-ignore
    const reordered = (await get(`/exam-catalogue/analytes`).expect(200)).body as { items: AdminAnalyte[] }; // prettier-ignore
    expect(reordered.items.find((a) => a.code === 'GLU')?.ranges.map((r) => r.rangeKind)).toEqual(['REFERENCE', 'CRITICAL']); // prettier-ignore

    const history = (await get(`/exam-catalogue/analytes/${glu.id}/ranges/history`).expect(200)).body as {
      items: { high: number | null; validFrom: string; validTo: string | null }[];
    }; // prettier-ignore
    expect(history.items).toHaveLength(4);
    expect(history.items.find((r) => r.high === 400)?.validTo).toBe(closed.validTo!.toISOString()); // prettier-ignore
    expect(history.items.find((r) => r.high === 500)?.validTo).toBeNull();
  });

  describe('la bandera que aterriza en la fila (ORD-036, ORD-038, ORD-114)', () => {
    /**
     * One patient per value: a fresh order of fasting glucose or blood count,
     * registered through the real service against PostgreSQL, and the flag
     * read back FROM THE ROW.
     */
    async function flagsOf(examCode: string, analyteCode: string) {
      const client = prisma as unknown as PrismaService;
      const orders = new PrismaServiceOrderRepository(client);
      const reports = new DiagnosticReportService(
        new PrismaDiagnosticReportRepository(client),
        orders,
        new PrismaExamCatalogueRepository(client),
        { record: () => Promise.resolve() },
        {
          setContext: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        } as never, // prettier-ignore,
        new InProcessLiveEventBus(),
      );
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      await aTariffConceptOf(prisma, examCode);
      const exam = await examCoded(examCode);
      const analyte = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: analyteCode } }); // prettier-ignore

      return async (
        sex: 'MALE' | 'FEMALE',
        valueNumeric: number,
        /** Born this long before the encounter, as a clinical date. */
        bornBefore?: { months: number; days: number },
      ) => {
        const startedAt = new Date();
        const born = bornBefore
          ? addDays(addMonths(clinicalDateOf(startedAt), -bornBefore.months), -bornBefore.days) // prettier-ignore
          : undefined;
        const patient = await createPatient(prisma, {
          sex,
          ...(born ? { birthDate: new Date(`${born}T00:00:00Z`) } : {}),
        });
        const encounter = await createEncounter(prisma, {
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startedAt,
        });
        const order = await placeIssued(orders, {
          encounterId: encounter.id,
          category: 'LABORATORY',
          priority: 'ROUTINE',
          lines: [{ serviceId: exam.id }],
          sites: 'all',
        });
        const report = await reports.register(
          {
            orderId: order.id,
            performedById: null,
            issuedAt: new Date(Date.now() - 3_600_000),
            results: [{ analyteDefinitionId: analyte.id, valueNumeric }],
          },
          { userId: SOMEONE, sites: 'all' },
        );
        const row = await prisma.observationResult.findFirstOrThrow({ where: { reportId: report.id } }); // prettier-ignore
        return row.abnormalFlag;
      };
    }

    it('ORD-036 el crítico del varón con sólo el alto hereda el bajo del general, y la referencia decide lo demás', async () => {
      const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [
          range({ low: 70, high: 100 }),
          range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
          range({ rangeKind: 'CRITICAL', sex: 'MALE', high: 450 }),
        ],
      }).expect(200); // prettier-ignore
      const flag = await flagsOf('LAB-GLUCOSA-AYUNAS', 'GLU');

      expect(await flag('MALE', 25)).toBe('CRITICAL_LOW'); // heredado del general
      expect(await flag('MALE', 420)).toBe('HIGH'); // su alto manda
      expect(await flag('MALE', 460)).toBe('CRITICAL_HIGH');
      // Control positivo: a la mujer le aplica el general entero.
      expect(await flag('FEMALE', 420)).toBe('CRITICAL_HIGH');
      expect(await flag('FEMALE', 25)).toBe('CRITICAL_LOW');
      expect(await flag('FEMALE', 65)).toBe('LOW');
      expect(await flag('FEMALE', 150)).toBe('HIGH');
      expect(await flag('FEMALE', 88)).toBe('NORMAL');
    });

    it('ORD-036 la edad que decide un rango es la edad en días, no el resto de días de la edad', async () => {
      const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [
          range({ low: 70, high: 100 }),
          range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
          range({ rangeKind: 'CRITICAL', ageMinDays: 0, ageMaxDays: 28, low: 30 }),
        ],
      }).expect(200); // prettier-ignore
      const flag = await flagsOf('LAB-GLUCOSA-AYUNAS', 'GLU');

      // 32 años y 10 días: el resto de días de su edad es 10, y el rango
      // neonatal no es suyo. Con 35 queda por debajo del crítico de adulto.
      expect(await flag('FEMALE', 35, { months: 32 * 12, days: 10 })).toBe('CRITICAL_LOW'); // prettier-ignore
      // Control positivo: el recién nacido de 10 días sí recibe el neonatal.
      expect(await flag('FEMALE', 35, { months: 0, days: 10 })).toBe('LOW');
    });

    it('ORD-038 sin rango para su sexo la bandera queda vacía, no normal', async () => {
      const hb = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'HB' } }); // prettier-ignore
      await send('put', `/exam-catalogue/analytes/${hb.id}/ranges`, {
        ranges: [range({ sex: 'MALE', low: 13, high: 17 })],
      }).expect(200); // prettier-ignore
      const flag = await flagsOf('LAB-BH', 'HB');

      expect(await flag('FEMALE', 14)).toBeNull();
      // Control positivo: el varón sí tiene con qué compararse.
      expect(await flag('MALE', 14)).toBe('NORMAL');
    });

    it('ORD-054 ORD-114 ORD-122 una corrección después de subir el umbral compara con el que se aplicó al original', async () => {
      const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
      const client = prisma as unknown as PrismaService;
      const orders = new PrismaServiceOrderRepository(client);
      const reports = new DiagnosticReportService(
        new PrismaDiagnosticReportRepository(client),
        orders,
        new PrismaExamCatalogueRepository(client),
        { record: () => Promise.resolve() },
        {
          setContext: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        } as never, // prettier-ignore,
        new InProcessLiveEventBus(),
      );
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      await aTariffConceptOf(prisma, 'LAB-GLUCOSA-AYUNAS');
      const exam = await examCoded('LAB-GLUCOSA-AYUNAS');
      const requester = { userId: SOMEONE, sites: 'all' as const };
      const issuedAt = () => new Date(Date.now() - 3_600_000);

      /** A glucose of `first` registered critical, the threshold raised to 500, then corrected to `corrected`. */
      async function correctedAfterRaise(first: number, corrected: number) {
        const patient = await createPatient(prisma, { sex: 'FEMALE' });
        const encounter = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
        const order = await placeIssued(orders, { encounterId: encounter.id, category: 'LABORATORY', priority: 'ROUTINE', lines: [{ serviceId: exam.id }], sites: 'all' }); // prettier-ignore
        const original = await reports.register({ orderId: order.id, performedById: null, issuedAt: issuedAt(), results: [{ analyteDefinitionId: glu.id, valueNumeric: first }] }, requester); // prettier-ignore
        expect(original.results[0]?.abnormalFlag).toBe('CRITICAL_HIGH');
        return { original, correct: () => reports.correct({ reportId: original.id, performedById: null, issuedAt: issuedAt(), results: [{ analyteDefinitionId: glu.id, valueNumeric: corrected }] }, requester) }; // prettier-ignore
      }

      const same = await correctedAfterRaise(420, 420);
      const lessExtreme = await correctedAfterRaise(420, 410);
      const belowApplied = await correctedAfterRaise(420, 390);
      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [range({ low: 70, high: 100 }), range({ rangeKind: 'CRITICAL', low: 40, high: 500 })],
      }).expect(200); // prettier-ignore

      const kept = await same.correct();
      const row = await prisma.observationResult.findFirstOrThrow({ where: { reportId: kept.id } }); // prettier-ignore
      expect(row.abnormalFlag).toBe('CRITICAL_HIGH');
      // La fila nueva congela el umbral del original, no el de hoy.
      expect(Number(row.criticalHigh)).toBe(400);
      // Y sigue en la cola de críticos, ahora por el informe corregido.
      const queue = await reports.critical(requester, new Date());
      expect(queue.map((entry) => entry.reportId)).toContain(kept.id);

      // Menos extremo pero por encima del 400 aplicado: sigue crítico. Con los
      // rangos de hoy (500) habría salido HIGH y de la cola.
      const lowered = await lessExtreme.correct();
      const loweredRow = await prisma.observationResult.findFirstOrThrow({ where: { reportId: lowered.id } }); // prettier-ignore
      expect(loweredRow.abnormalFlag).toBe('CRITICAL_HIGH');

      // Control positivo: por debajo del umbral aplicado deja de ser crítico.
      const below = await belowApplied.correct();
      const belowRow = await prisma.observationResult.findFirstOrThrow({ where: { reportId: below.id } }); // prettier-ignore
      expect(belowRow.abnormalFlag).toBe('HIGH');
      expect(Number(belowRow.criticalHigh)).toBe(400);
    });

    it('ORD-114 ORD-122 D-135 una corrección después de BAJAR el umbral se marca con el de hoy, que es el más protector', async () => {
      const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
      const client = prisma as unknown as PrismaService;
      const orders = new PrismaServiceOrderRepository(client);
      const reports = new DiagnosticReportService(
        new PrismaDiagnosticReportRepository(client),
        orders,
        new PrismaExamCatalogueRepository(client),
        { record: () => Promise.resolve() },
        {
          setContext: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        } as never, // prettier-ignore,
        new InProcessLiveEventBus(),
      );
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      await aTariffConceptOf(prisma, 'LAB-GLUCOSA-AYUNAS');
      const exam = await examCoded('LAB-GLUCOSA-AYUNAS');
      const requester = { userId: SOMEONE, sites: 'all' as const };
      const issuedAt = () => new Date(Date.now() - 3_600_000);
      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [range({ low: 70, high: 100 }), range({ rangeKind: 'CRITICAL', low: 40, high: 400 })],
      }).expect(200); // prettier-ignore

      const patient = await createPatient(prisma, { sex: 'FEMALE' });
      const encounter = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
      const order = await placeIssued(orders, { encounterId: encounter.id, category: 'LABORATORY', priority: 'ROUTINE', lines: [{ serviceId: exam.id }], sites: 'all' }); // prettier-ignore
      const original = await reports.register({ orderId: order.id, performedById: null, issuedAt: issuedAt(), results: [{ analyteDefinitionId: glu.id, valueNumeric: 380 }] }, requester); // prettier-ignore
      expect(original.results[0]).toMatchObject({ abnormalFlag: 'HIGH', criticalHigh: 400 }); // prettier-ignore

      // La clínica baja el crítico alto a 350; el laboratorio corrige a 390.
      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [range({ low: 70, high: 100 }), range({ rangeKind: 'CRITICAL', low: 40, high: 350 })],
      }).expect(200); // prettier-ignore
      const corrected = await reports.correct({ reportId: original.id, performedById: null, issuedAt: issuedAt(), results: [{ analyteDefinitionId: glu.id, valueNumeric: 390 }] }, requester); // prettier-ignore

      const row = await prisma.observationResult.findFirstOrThrow({ where: { reportId: corrected.id } }); // prettier-ignore
      expect(row.abnormalFlag).toBe('CRITICAL_HIGH');
      // Congela el límite que la marcó.
      expect(Number(row.criticalHigh)).toBe(350);
      const queue = await reports.critical(requester, new Date());
      // Y la cola de críticos lo dice junto al valor.
      expect(queue.find((entry) => entry.reportId === corrected.id)).toMatchObject({ criticalHigh: 350 }); // prettier-ignore
    });

    it('ORD-114 un rango cerrado no cuenta: el resultado nuevo usa el que rige al registrarlo', async () => {
      const glu = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'GLU' } }); // prettier-ignore
      const flag = await flagsOf('LAB-GLUCOSA-AYUNAS', 'GLU');
      // Control positivo: con el crítico de la siembra (400), 420 es crítico.
      expect(await flag('FEMALE', 420)).toBe('CRITICAL_HIGH');

      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [
          range({ low: 70, high: 100 }),
          range({ rangeKind: 'CRITICAL', low: 40, high: 500 }),
        ],
      }).expect(200); // prettier-ignore

      expect(await flag('FEMALE', 420)).toBe('HIGH');
      expect(await flag('FEMALE', 520)).toBe('CRITICAL_HIGH');
      // El de 400 sigue en la base, cerrado: es la respuesta a «qué regía».
      expect(await prisma.analyteReferenceRange.count({ where: { analyteDefinitionId: glu.id, high: '400', validTo: { not: null } } })).toBe(1); // prettier-ignore
    });
  });

  /** An issued blood count on a new chart, and its report service. */
  async function anIssuedBloodCount(sex: 'MALE' | 'FEMALE' = 'FEMALE') {
    const client = prisma as unknown as PrismaService;
    const orders = new PrismaServiceOrderRepository(client);
    const reports = new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      orders,
      new PrismaExamCatalogueRepository(client),
      { record: () => Promise.resolve() },
      {
        setContext: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never, // prettier-ignore,
      new InProcessLiveEventBus(),
    );
    // La siembra de caja ya trae `LAB-BH` y `HB`: se pide ése.
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma, { sex });
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    await aTariffConceptOf(prisma, 'LAB-BH');
    const bh = await examCoded('LAB-BH');
    const hb = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'HB' } }); // prettier-ignore
    const order = await placeIssued(orders, {
      encounterId: encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ serviceId: bh.id }],
      sites: 'all',
    });
    const registerHb = (valueNumeric: number) =>
      reports.register(
        {
          orderId: order.id,
          performedById: null,
          issuedAt: new Date(Date.now() - 3_600_000),
          results: [{ analyteDefinitionId: hb.id, valueNumeric }],
        },
        { userId: SOMEONE, sites: 'all' },
      );
    return { bh, hb, order, registerHb };
  }

  const range = (over: object) => ({
    rangeKind: 'REFERENCE', sex: null, ageMinDays: null, ageMaxDays: null,
    low: null, high: null, text: null, ...over,
  }); // prettier-ignore

  it('ORD-110 cambiar el rango no cambia un resultado ya registrado: guarda el rango y la bandera que aplicó', async () => {
    const { hb, registerHb } = await anIssuedBloodCount('FEMALE');
    const report = await registerHb(12.5);
    const registered = report.results[0]!;
    // Con la siembra (12,0–15,5 en mujeres), 12,5 es normal.
    expect(registered).toMatchObject({
      abnormalFlag: 'NORMAL',
      referenceLow: 12,
    });

    const changed = (await send('put', `/exam-catalogue/analytes/${hb.id}/ranges`, {
      ranges: [range({ low: 13, high: 18 })],
    }).expect(200)).body as AdminAnalyte; // prettier-ignore

    // Control positivo: el catálogo SÍ cambió, y un resultado NUEVO lo usa.
    expect(changed.ranges).toEqual([expect.objectContaining({ low: 13, high: 18 })]); // prettier-ignore
    const after = await prisma.observationResult.findFirstOrThrow({
      where: { reportId: report.id },
    });
    expect(after.referenceLow?.toString()).toBe('12');
    expect(after.referenceHigh?.toString()).toBe('15.5');
    expect(after.abnormalFlag).toBe('NORMAL');
  });

  it('ORD-110 una determinación con resultados no se renombra ni cambia de unidad: la corrección compara por su nombre', async () => {
    const { hb, registerHb } = await anIssuedBloodCount();
    // Control positivo: sin resultados, el nombre se corrige.
    await send('patch', `/exam-catalogue/analytes/${hb.id}`, { name: 'Hemoglobina total' }).expect(200); // prettier-ignore
    await send('patch', `/exam-catalogue/analytes/${hb.id}`, { name: 'Hemoglobina' }).expect(200); // prettier-ignore
    await registerHb(12.5);

    for (const change of [{ name: 'Hemoglobina sérica' }, { unit: 'g/L' }]) {
      const refused = await send('patch', `/exam-catalogue/analytes/${hb.id}`, change).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('ANALYTE_HAS_RESULTS');
    }
    // Lo que no toca el resultado se corrige igual.
    await send('patch', `/exam-catalogue/analytes/${hb.id}`, { loincCode: '718-7' }).expect(200); // prettier-ignore
  });

  it('ORD-106 cambiar la unidad con rangos escritos se rechaza; sin rangos, se cambia', async () => {
    const created = (await send('post', '/exam-catalogue/analytes', {
      code: 'GLU2', name: 'Glucosa capilar', valueType: 'NUMERIC', unit: 'mg/dL',
      decimals: 0, allowedValues: null, loincCode: null, active: true,
    }).expect(201)).body as AdminAnalyte; // prettier-ignore
    await send('put', `/exam-catalogue/analytes/${created.id}/ranges`, {
      ranges: [range({ rangeKind: 'CRITICAL', low: 40, high: 400 })],
    }).expect(200); // prettier-ignore

    const refused = await send('patch', `/exam-catalogue/analytes/${created.id}`, { unit: 'mmol/L' }).expect(409); // prettier-ignore
    expect((refused.body as Problem).code).toBe('ANALYTE_UNIT_WITH_RANGES');

    await send('put', `/exam-catalogue/analytes/${created.id}/ranges`, { ranges: [] }).expect(200); // prettier-ignore
    await send('patch', `/exam-catalogue/analytes/${created.id}`, { unit: 'mmol/L' }).expect(200); // prettier-ignore
  });

  it('ORD-141 la unidad y sus rangos nuevos se guardan juntos; si un rango no vale, no cambia ninguno', async () => {
    const created = (await send('post', '/exam-catalogue/analytes', {
      code: 'GLU3', name: 'Glucosa venosa', valueType: 'NUMERIC', unit: 'mg/dL',
      decimals: 0, allowedValues: null, loincCode: null, active: true,
    }).expect(201)).body as AdminAnalyte; // prettier-ignore
    await send('put', `/exam-catalogue/analytes/${created.id}/ranges`, {
      ranges: [range({ rangeKind: 'CRITICAL', low: 40, high: 400 })],
    }).expect(200); // prettier-ignore

    // Un rango imposible (bajo mayor que alto): nada cambia, tampoco la unidad.
    await send('patch', `/exam-catalogue/analytes/${created.id}`, {
      unit: 'mmol/L', decimals: 1,
      ranges: [range({ rangeKind: 'CRITICAL', low: 22, high: 2.2 })],
    }).expect(422); // prettier-ignore
    const untouched = await prisma.analyteDefinition.findUniqueOrThrow({ where: { id: created.id } }); // prettier-ignore
    expect(untouched.unit).toBe('mg/dL');

    // Los mismos límites de antes con la unidad nueva: el crítico se apagaría.
    const carried = await send('patch', `/exam-catalogue/analytes/${created.id}`, {
      unit: 'mmol/L', decimals: 1,
      ranges: [range({ rangeKind: 'CRITICAL', low: 40, high: 400 })],
    }).expect(409); // prettier-ignore
    expect((carried.body as Problem).code).toBe('ANALYTE_UNIT_WITH_RANGES');

    // Control positivo: con rangos válidos en la unidad nueva, entran los dos.
    const saved = (await send('patch', `/exam-catalogue/analytes/${created.id}`, {
      unit: 'mmol/L', decimals: 1,
      ranges: [range({ rangeKind: 'CRITICAL', low: 2.2, high: 22 })],
    }).expect(200)).body as AdminAnalyte; // prettier-ignore
    expect(saved.unit).toBe('mmol/L');
    expect(saved.ranges).toEqual([expect.objectContaining({ low: 2.2, high: 22 })]); // prettier-ignore
  });

  it('ORD-110 con órdenes esperando resultado no cambian las determinaciones del examen; el orden sí', async () => {
    const { bh } = await anIssuedBloodCount();
    const structure = await prisma.serviceExamAnalyte.findMany({
      where: { serviceId: bh.id },
      orderBy: { position: 'asc' },
      select: { analyteDefinitionId: true, isReflex: true },
    });

    const fewer = await send('put', `/exam-catalogue/exams/${bh.id}/analytes`, {
      analytes: structure.slice(1),
    }).expect(409); // prettier-ignore
    expect((fewer.body as Problem).code).toBe('EXAM_HAS_OPEN_ORDERS');

    // Control positivo: reordenar no juzga nada, y se guarda.
    await send('put', `/exam-catalogue/exams/${bh.id}/analytes`, {
      analytes: [...structure].reverse(),
    }).expect(200); // prettier-ignore
  });

  it('ORD-042 una determinación desactivada se sigue recibiendo en lo ya pedido', async () => {
    const { hb, registerHb } = await anIssuedBloodCount();
    await send('patch', `/exam-catalogue/analytes/${hb.id}`, { active: false }).expect(200); // prettier-ignore

    const report = await registerHb(13.4);
    expect(report.results[0]?.analyteDisplay).toBe('Hemoglobina');
  });

  it('ORD-103 sin catalog:manage no se ve ni se toca el catálogo administrado', async () => {
    await prisma.role.create({
      data: {
        code: 'LECTOR',
        name: 'Lector',
        description: 'Sólo lee catálogos.',
        permissions: { create: [{ permissionCode: 'catalog:read' }] },
      },
    });
    registry.invalidate();
    const reader = await signIn('lector@clinica.ec', 'LECTOR', '1710034065');

    const bh = await examCoded('LAB-BH');
    await api().get('/api/v1/exam-catalogue/analytes').set('Authorization', `Bearer ${reader}`).expect(403); // prettier-ignore
    await api().put(`/api/v1/exam-catalogue/exams/${bh.id}/analytes`).set('Authorization', `Bearer ${reader}`).send({ analytes: [] }).expect(403); // prettier-ignore
    // Control positivo: el catálogo de pedir sí lo lee.
    await api().get('/api/v1/exams').set('Authorization', `Bearer ${reader}`).expect(200); // prettier-ignore
  });
});
