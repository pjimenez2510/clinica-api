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
 * ORD-158 to ORD-160 (D-163.1): the exam order FREEZES the patient's sex when
 * it is issued, as it froze its diagnoses (ORD-121) and the attention its age
 * (EN-221). Until now the header — screen and PDF — and the reference range
 * read the chart's sex live, so correcting the chart afterwards changed a
 * paper the laboratory already held and the range its results were judged by.
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

describe('ORD-160 el rango se elige con el sexo congelado en la orden', () => {
  it('ORD-160 una hemoglobina de 12,5 transcrita tras pasar la ficha a hombre se clasifica con el rango de la mujer; en la orden emitida después, con el del hombre', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    const { orders, reports } = adapters(prisma);
    await orders.issue({ orderId: draft.id, sites: 'all' });
    await correctChartToMale(prisma, scene.patient.id);

    const hers = await reports.register(
      {
        orderId: draft.id,
        performedById: null,
        issuedAt: new Date(),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );
    expect(hers.results[0]).toMatchObject({
      abnormalFlag: 'NORMAL',
      referenceLow: 12,
    });

    // Positive control: the same value, on an order issued after the
    // correction, is judged with the man's range.
    const later = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    const his = await reports.register(
      {
        orderId: later.id,
        performedById: null,
        issuedAt: new Date(),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );
    expect(his.results[0]).toMatchObject({
      abnormalFlag: 'LOW',
      referenceLow: 13,
    });
  });
});
