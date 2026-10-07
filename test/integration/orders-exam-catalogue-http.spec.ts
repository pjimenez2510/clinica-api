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

import {
  addDays,
  addMonths,
  clinicalDateOf,
} from '../../src/shared/domain/clinic-time';
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
  unit: string | null;
  ranges: {
    rangeKind: string;
    sex: string | null;
    low: number | null;
    high: number | null;
  }[];
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

  it('ORD-103 el código lo arbitra la base: otro examen con el mismo se rechaza', async () => {
    // Control positivo: un código nuevo entra.
    await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(201);

    const duplicate = await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(409); // prettier-ignore
    expect((duplicate.body as Problem).code).toBe('EXAM_CODE_DUPLICATE');

    // ORD-140: también al corregirlo.
    const bh = await examCoded('EX-BH');
    const taken = await send('patch', `/exam-catalogue/exams/${bh.id}`, { code: NEW_EXAM.code }).expect(409); // prettier-ignore
    expect((taken.body as Problem).code).toBe('EXAM_CODE_DUPLICATE');
  });

  it('ORD-140 el código de un examen se corrige mientras ninguna orden lo pidió; después, EXAM_CODE_IN_USE', async () => {
    const created = (await send('post', '/exam-catalogue/exams', NEW_EXAM).expect(201)).body as AdminExam; // prettier-ignore
    // Control positivo: nadie lo pidió, el código se corrige.
    const corrected = await send('patch', `/exam-catalogue/exams/${created.id}`, { code: 'EX-PERFIL-RENAL-2' }).expect(200); // prettier-ignore
    expect((corrected.body as AdminExam).code).toBe('EX-PERFIL-RENAL-2');

    const { bh } = await anIssuedBloodCount();
    const refused = await send('patch', `/exam-catalogue/exams/${bh.id}`, { code: 'EX-OTRO' }).expect(409); // prettier-ignore
    expect((refused.body as Problem).code).toBe('EXAM_CODE_IN_USE');
    expect((await examCoded('EX-BH')).id).toBe(bh.id);
  });

  it('ORD-129 «Pide ayuno» y sus horas se guardan, se publican al pedir y la base no admite horas sin ayuno', async () => {
    // Control positivo: con ayuno, las horas entran y se leen al pedir.
    const created = await send('post', '/exam-catalogue/exams', { ...NEW_EXAM, requiresFasting: true, fastingHours: 8 }).expect(201); // prettier-ignore
    const exam = created.body as AdminExam & { requiresFasting: boolean; fastingHours: number | null }; // prettier-ignore
    expect(exam).toMatchObject({ requiresFasting: true, fastingHours: 8 });
    const orderable = (await get('/exams').expect(200)).body as { items: { id: string; requiresFasting: boolean; fastingHours: number | null }[] }; // prettier-ignore
    expect(orderable.items.find((e) => e.id === exam.id)).toMatchObject({ requiresFasting: true, fastingHours: 8 }); // prettier-ignore

    // Quitar el ayuno dejando las horas: lo rechaza la base, nombrando el campo.
    const refused = await send('patch', `/exam-catalogue/exams/${exam.id}`, { requiresFasting: false }).expect(422); // prettier-ignore
    expect((refused.body as Problem).code).toBe('EXAM_FASTING_HOURS_INVALID');
    expect(JSON.stringify(refused.body)).toContain('fastingHours');
    // Una edición que no lo menciona no lo toca.
    await send('patch', `/exam-catalogue/exams/${exam.id}`, { name: 'Perfil renal completo' }).expect(200); // prettier-ignore
    expect(await examCoded('EX-PERFIL-RENAL')).toMatchObject({ requiresFasting: true, fastingHours: 8 }); // prettier-ignore
    // Quitarlo con sus horas, sí.
    await send('patch', `/exam-catalogue/exams/${exam.id}`, { requiresFasting: false, fastingHours: null }).expect(200); // prettier-ignore

    // La base, sin pasar por la API: 25 horas no.
    await expect(
      prisma.$executeRaw`UPDATE "exam_definition" SET "requires_fasting" = true, "fasting_hours" = 25 WHERE "id" = ${exam.id}::uuid`,
    ).rejects.toThrow(/exam_definition_fasting_hours_range/);
    // Y la semilla marca la glucosa con sus 8 horas.
    expect(await examCoded('EX-GLUCOSA-AYUNAS')).toMatchObject({ requiresFasting: true, fastingHours: 8 }); // prettier-ignore
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
        { setContext: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never, // prettier-ignore
      );
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      await aTariffConcept(prisma, { code: examCode });
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
          lines: [{ examDefinitionId: exam.id }],
          sites: 'all',
        });
        const report = await reports.register(
          {
            orderId: order.id,
            performedById: null,
            issuedAt: new Date(Date.now() - 3_600_000),
            results: [{ analyteDefinitionId: analyte.id, valueNumeric }],
          },
          { userId: 'user-1', sites: 'all' },
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
      const flag = await flagsOf('EX-GLUCOSA-AYUNAS', 'GLU');

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
      const flag = await flagsOf('EX-GLUCOSA-AYUNAS', 'GLU');

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
      const flag = await flagsOf('EX-BH', 'HB');

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
        { setContext: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never, // prettier-ignore
      );
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      await aTariffConcept(prisma, { code: 'EX-GLUCOSA-AYUNAS' });
      const exam = await examCoded('EX-GLUCOSA-AYUNAS');
      const requester = { userId: 'user-1', sites: 'all' as const };
      const issuedAt = () => new Date(Date.now() - 3_600_000);

      /** A glucose of `first` registered critical, the threshold raised to 500, then corrected to `corrected`. */
      async function correctedAfterRaise(first: number, corrected: number) {
        const patient = await createPatient(prisma, { sex: 'FEMALE' });
        const encounter = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
        const order = await placeIssued(orders, { encounterId: encounter.id, category: 'LABORATORY', priority: 'ROUTINE', lines: [{ examDefinitionId: exam.id }], sites: 'all' }); // prettier-ignore
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
        { setContext: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never, // prettier-ignore
      );
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      await aTariffConcept(prisma, { code: 'EX-GLUCOSA-AYUNAS' });
      const exam = await examCoded('EX-GLUCOSA-AYUNAS');
      const requester = { userId: 'user-1', sites: 'all' as const };
      const issuedAt = () => new Date(Date.now() - 3_600_000);
      await send('put', `/exam-catalogue/analytes/${glu.id}/ranges`, {
        ranges: [range({ low: 70, high: 100 }), range({ rangeKind: 'CRITICAL', low: 40, high: 400 })],
      }).expect(200); // prettier-ignore

      const patient = await createPatient(prisma, { sex: 'FEMALE' });
      const encounter = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
      const order = await placeIssued(orders, { encounterId: encounter.id, category: 'LABORATORY', priority: 'ROUTINE', lines: [{ examDefinitionId: exam.id }], sites: 'all' }); // prettier-ignore
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
      const flag = await flagsOf('EX-GLUCOSA-AYUNAS', 'GLU');
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
