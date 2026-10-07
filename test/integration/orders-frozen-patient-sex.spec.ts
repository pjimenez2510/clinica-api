import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * ORD-158, ORD-159 (D-163.1): the exam order FREEZES the patient's sex when
 * it is issued, as it froze its diagnoses (ORD-121) and the attention its age
 * (EN-221). Until now the header — screen and PDF — read the chart's sex live,
 * so correcting the chart afterwards changed a paper the laboratory already
 * held. The copy is for the header ONLY: the reference range keeps following
 * the chart (ORD-036; D-171.1, the author's, retired ORD-160), because a
 * corrected sex almost always fixes a registration error.
 *
 * Proved against PostgreSQL: the copy is written by a trigger at the issue,
 * whatever the writer sends, and an issued order does not rewrite it. Every
 * refusal has its positive control beside it: the chart DID change.
 */
const db = useDatabase();

const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };
const requester: Requester = { userId: 'user-1', sites: 'all' };
const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function adapters(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  const orders = new PrismaServiceOrderRepository(client);
  return {
    orders,
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      orders,
      new PrismaExamCatalogueRepository(client),
      silentAudit,
      noopLogger as never,
    ),
    documents: new PrismaDocumentSourceReader(
      client,
      'http://localhost/verificar',
    ),
  };
}

/** A woman's attention and a draft order for the complete blood count. */
async function aDraftOrder(prisma: PrismaClient) {
  const scene = await aScene(prisma, { sex: 'FEMALE' });
  const draft = await adapters(prisma).orders.compose({
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId: scene.bh.id }],
    sites: 'all',
  });
  return { scene, draft };
}

const frozenSexOf = async (prisma: PrismaClient, orderId: string) =>
  (
    await prisma.$queryRaw<{ patient_sex: string | null }[]>`
      SELECT patient_sex::text FROM service_order WHERE id = ${orderId}::uuid`
  )[0]?.patient_sex;

/** The chart is corrected after the issue: a woman recorded, a man in fact. */
const correctChartToMale = (prisma: PrismaClient, patientId: string) =>
  prisma.patient.update({ where: { id: patientId }, data: { sex: 'MALE' } });

describe('ORD-158 la orden congela el sexo de la ficha al emitirse', () => {
  it('ORD-158 el borrador no lo tiene; emitida, la BASE copia el de la ficha y no deja reescribirlo', async () => {
    const prisma = db();
    const { draft } = await aDraftOrder(prisma);

    expect(await frozenSexOf(prisma, draft.id)).toBeNull();
    await adapters(prisma).orders.issue({ orderId: draft.id, sites: 'all' });
    expect(await frozenSexOf(prisma, draft.id)).toBe('FEMALE');

    await expect(
      prisma.$executeRaw`UPDATE service_order SET patient_sex = 'MALE' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
    expect(await frozenSexOf(prisma, draft.id)).toBe('FEMALE');
  });

  it('ORD-158 lo que mande quien emite no cuenta: la BASE escribe el sexo de la ficha', async () => {
    const prisma = db();
    const { draft } = await aDraftOrder(prisma);

    await prisma.$executeRaw`
      UPDATE service_order SET status = 'ISSUED', patient_sex = 'MALE'
       WHERE id = ${draft.id}::uuid`;

    expect(await frozenSexOf(prisma, draft.id)).toBe('FEMALE');
  });

  it('ORD-158 una orden insertada ya emitida —una importación, un psql— también toma el sexo de la ficha y no el que trae', async () => {
    const prisma = db();
    const scene = await aScene(prisma, { sex: 'FEMALE' });

    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO service_order
        (encounter_id, site_id, ordered_by_id, category, status, patient_sex, diagnoses, updated_at)
      VALUES (${scene.encounter.id}::uuid, ${scene.site.id}::uuid,
              ${scene.practitioner.id}::uuid, 'LABORATORY', 'ISSUED', 'MALE',
              '[]'::jsonb, ${new Date()})
      RETURNING id`;

    expect(await frozenSexOf(prisma, row!.id)).toBe('FEMALE');
  });

  it('ORD-158 un borrador no puede llevarlo, ni uno descartado', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET patient_sex = 'FEMALE' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_patient_sex_frozen_when_issued/);

    const user = await createUser(prisma);
    await adapters(prisma).orders.discard({
      orderId: draft.id,
      sites: 'all',
      userId: user.id,
    });
    expect(await frozenSexOf(prisma, draft.id)).toBeNull();
    await expect(
      prisma.$executeRaw`UPDATE service_order SET patient_sex = 'FEMALE' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(
      /service_order_frozen_once_issued|service_order_patient_sex_frozen_when_issued/,
    );
    // Positive control: the chart has a sex the trigger could have copied.
    const chart = await prisma.patient.findUniqueOrThrow({
      where: { id: scene.patient.id },
    });
    expect(chart.sex).toBe('FEMALE');
  });

  it('ORD-158 corregir la ficha después de emitir no cambia la orden; la que se emite después lleva el nuevo', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    const { orders } = adapters(prisma);
    await orders.issue({ orderId: draft.id, sites: 'all' });

    await correctChartToMale(prisma, scene.patient.id);

    expect(await frozenSexOf(prisma, draft.id)).toBe('FEMALE');
    const later = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    expect(await frozenSexOf(prisma, later.id)).toBe('MALE');
  });
});

describe('ORD-159 la cabecera de la orden dice el sexo congelado', () => {
  it('ORD-159 el PDF de la orden, generado de nuevo tras corregir la ficha, dice el sexo del día de la emisión', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    const { orders, documents } = adapters(prisma);
    await orders.issue({ orderId: draft.id, sites: 'all' });
    await correctChartToMale(prisma, scene.patient.id);

    const subject = await documents.findSubject({
      kind: 'SERVICE_ORDER',
      subjectId: draft.id,
      sites: 'all',
    });

    expect(subject?.kind === 'SERVICE_ORDER' && subject.data.patientSex).toBe(
      'FEMALE',
    );
  });

  it('ORD-159 la orden leída por la API trae el sexo congelado, y el borrador ninguno', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    const { orders } = adapters(prisma);
    expect(draft.patientSex).toBeNull();

    await orders.issue({ orderId: draft.id, sites: 'all' });
    await correctChartToMale(prisma, scene.patient.id);

    const issued = await orders.byId({ orderId: draft.id, sites: 'all' });
    expect(issued?.patientSex).toBe('FEMALE');
  });
});

describe('ORD-036 el rango sigue el sexo de la ficha, no el que la orden congeló para su cabecera (D-171.1)', () => {
  it('ORD-036 ORD-158 una hemoglobina de 12,5 en una orden que congeló «mujer» se clasifica con el rango del hombre cuando la ficha se corrigió a hombre', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    const { orders, reports } = adapters(prisma);
    await orders.issue({ orderId: draft.id, sites: 'all' });
    const second = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });

    // Positive control: with the chart still a woman's, the woman's range.
    const before = await reports.register(
      {
        orderId: draft.id,
        performedById: null,
        issuedAt: new Date(),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );
    expect(before.results[0]).toMatchObject({
      abnormalFlag: 'NORMAL',
      referenceLow: 12,
    });

    await correctChartToMale(prisma, scene.patient.id);
    // The order issued before the correction still froze «mujer» (ORD-158)…
    expect(await frozenSexOf(prisma, second.id)).toBe('FEMALE');

    // …and its result is judged with the chart's sex, the man's range.
    const after = await reports.register(
      {
        orderId: second.id,
        performedById: null,
        issuedAt: new Date(),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );
    expect(after.results[0]).toMatchObject({
      abnormalFlag: 'LOW',
      referenceLow: 13,
    });
  });
});
