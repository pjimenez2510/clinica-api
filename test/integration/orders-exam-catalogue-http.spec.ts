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

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';

import { aTariffConcept, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CATÁLOGO DE EXÁMENES, ADMINISTRADO POR LA CLÍNICA (ORD-103 a ORD-111).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Por HTTP, con una sesión de verdad que tiene `catalog:manage`, sobre la
 * siembra real de caja y exámenes: las categorías con su clase (BI-186) y los
 * exámenes `EX-BH`, `EX-RX-TORAX`, `EX-ECG`. Lo que garantiza la base —el
 * código único, el rango que no apunta a ningún resultado— se prueba contra
 * la base, con su control positivo.
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
  billableService: { id: string; kind: string } | null;
  analytes: { position: number; isReflex: boolean; analyte: { code: string } }[]; // prettier-ignore
}
interface AdminAnalyte {
  id: string;
  code: string;
  ranges: { sex: string | null; low: number | null; high: number | null }[];
  usedBy: { code: string }[];
}

const NEW_EXAM = {
  code: 'EX-PERFIL-RENAL',
  name: 'Perfil renal',
  category: 'LABORATORY',
  form010Section: 'BIOQUÍMICA',
  specimenType: 'Suero',
  patientPreparation: 'Ayuno de 8 horas.',
  turnaroundHours: 6,
  performedExternally: true,
  externalLabName: null,
  externalLabCode: null,
  tariffCode: null,
  billableServiceId: null,
  active: true,
};

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

  const serviceCoded = (code: string) =>
    prisma.billableService.findUniqueOrThrow({ where: { code } });
  const examCoded = (code: string) =>
    prisma.examDefinition.findUniqueOrThrow({ where: { code } });

  it('ORD-101 el catálogo que se lee al pedir publica el tipo de cada examen', async () => {
    const orderable = (await get('/exams').expect(200)).body as {
      items: { code: string; category: string }[];
    };
    const byCode = new Map(orderable.items.map((e) => [e.code, e.category]));

    expect(byCode.get('EX-BH')).toBe('LABORATORY');
    expect(byCode.get('EX-RX-TORAX')).toBe('IMAGING');
    expect(byCode.get('EX-ECG')).toBe('PROCEDURE');
  });

  it('ORD-103 ORD-111 da de alta un examen, lo lista con los desactivados y deja rastro', async () => {
    const created = await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(201); // prettier-ignore
    const exam = created.body as AdminExam;
    expect(exam).toMatchObject({ code: 'EX-PERFIL-RENAL', active: true });

    await send('patch', `/exam-catalogue/exams/${exam.id}`, { active: false }).expect(200); // prettier-ignore
    const list = (await get('/exam-catalogue/exams').expect(200)).body as { items: AdminExam[] }; // prettier-ignore
    expect(list.items.find((e) => e.id === exam.id)?.active).toBe(false);
    // Desactivado, ya no se ofrece al pedir (ORD-003); la lista lo conserva.
    const orderable = (await get('/exams').expect(200)).body as { items: { id: string }[] }; // prettier-ignore
    expect(orderable.items.map((e) => e.id)).not.toContain(exam.id);

    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'exam_definition', resourceId: exam.id },
      orderBy: { occurredAt: 'asc' },
      select: { action: true },
    });
    expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('ORD-103 el código lo arbitra la base: otro examen con el mismo se rechaza, y el código no se corrige', async () => {
    // Control positivo: un código nuevo entra.
    await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(201);

    const duplicate = await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(409); // prettier-ignore
    expect((duplicate.body as Problem).code).toBe('EXAM_CODE_DUPLICATE');

    const bh = await examCoded('EX-BH');
    await send('patch', `/exam-catalogue/exams/${bh.id}`, { code: 'EX-OTRO' }).expect(422); // prettier-ignore
  });

  it('ORD-108 se cobra con una prestación de su clase; la de imagen se rechaza', async () => {
    const lab = await serviceCoded('LAB-BH');
    const imaging = await serviceCoded('IMG-RX-SIMPLE');

    const refused = await send('post', '/exam-catalogue/exams', { ...NEW_EXAM, billableServiceId: imaging.id }).expect(422); // prettier-ignore
    expect((refused.body as Problem).code).toBe('EXAM_SERVICE_KIND_MISMATCH');

    const accepted = await send('post', '/exam-catalogue/exams', { ...NEW_EXAM, billableServiceId: lab.id }).expect(201); // prettier-ignore
    expect((accepted.body as AdminExam).billableService).toMatchObject({
      id: lab.id,
      kind: 'LABORATORY',
    });
  });

  it('ORD-108 un electrocardiograma se cobra como procedimiento', async () => {
    const ecg = await examCoded('EX-ECG');
    const procedure = await serviceCoded('PROC-ECG');

    const response = await send('patch', `/exam-catalogue/exams/${ecg.id}`, {
      category: 'PROCEDURE',
      billableServiceId: procedure.id,
    }).expect(200);
    expect((response.body as AdminExam).billableService?.kind).toBe(
      'PROCEDURE',
    );
  });

  it('ORD-109 un examen cobrado como laboratorio no pasa a imagen sin cambiar de prestación', async () => {
    const bh = await examCoded('EX-BH');

    const refused = await send('patch', `/exam-catalogue/exams/${bh.id}`, { category: 'IMAGING' }).expect(422); // prettier-ignore
    expect((refused.body as Problem).code).toBe('EXAM_SERVICE_KIND_MISMATCH');
    // Control positivo: lo que no toca el tipo ni la prestación se corrige.
    await send('patch', `/exam-catalogue/exams/${bh.id}`, { turnaroundHours: 8 }).expect(200); // prettier-ignore
  });

  it('ORD-104 ORD-105 da de alta dos determinaciones y las pone en el examen, en su orden', async () => {
    const exam = (await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(201)).body as AdminExam; // prettier-ignore
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

    expect(
      structured.analytes.map((a) => [a.position, a.analyte.code]),
    ).toEqual([
      [1, 'UREA'],
      [2, 'CREA'],
    ]);
    // Y al pedir, el catálogo publica esas determinaciones (ORD-011).
    const orderable = (await get('/exams').expect(200)).body as { items: { id: string; analytes: { code: string }[] }[] }; // prettier-ignore
    expect(orderable.items.find((e) => e.id === exam.id)?.analytes.map((a) => a.code)).toEqual(['UREA', 'CREA']); // prettier-ignore
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
    const bh = await examCoded('EX-BH');
    const before = await prisma.examDefinitionAnalyte.count({ where: { examDefinitionId: bh.id } }); // prettier-ignore

    const refused = await send('put', `/exam-catalogue/exams/${bh.id}/analytes`, {
      analytes: [{ analyteDefinitionId: '00000000-0000-4000-8000-000000000999', isReflex: false }],
    }).expect(404); // prettier-ignore
    expect((refused.body as Problem).code).toBe('ANALYTE_NOT_FOUND');
    expect(await prisma.examDefinitionAnalyte.count({ where: { examDefinitionId: bh.id } })).toBe(before); // prettier-ignore
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
    expect(saved.usedBy.map((e) => e.code)).toContain('EX-BH');

    const overlap = await send('put', `/exam-catalogue/analytes/${hb.id}/ranges`, {
      ranges: [range({ low: 12, high: 17 }), range({ low: 11, high: 18 })],
    }).expect(422); // prettier-ignore
    expect((overlap.body as Problem).code).toBe('REFERENCE_RANGE_OVERLAP');
    expect(await prisma.analyteReferenceRange.count({ where: { analyteDefinitionId: hb.id } })).toBe(3); // prettier-ignore
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
      { setContext: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never, // prettier-ignore
    );
    // La siembra de caja ya trae `EX-BH` y `HB`: se pide ése.
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma, { sex });
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    await aTariffConcept(prisma, { code: 'EX-BH' });
    const bh = await examCoded('EX-BH');
    const hb = await prisma.analyteDefinition.findUniqueOrThrow({ where: { code: 'HB' } }); // prettier-ignore
    const order = await placeIssued(orders, {
      encounterId: encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: bh.id }],
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
        { userId: 'user-1', sites: 'all' },
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

  it('ORD-110 con órdenes esperando resultado no cambian las determinaciones del examen; el orden sí', async () => {
    const { bh } = await anIssuedBloodCount();
    const structure = await prisma.examDefinitionAnalyte.findMany({
      where: { examDefinitionId: bh.id },
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

    await api().get('/api/v1/exam-catalogue/exams').set('Authorization', `Bearer ${reader}`).expect(403); // prettier-ignore
    await api().post('/api/v1/exam-catalogue/exams').set('Authorization', `Bearer ${reader}`).send(NEW_EXAM).expect(403); // prettier-ignore
  });
});
