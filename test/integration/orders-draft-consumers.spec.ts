import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { PrismaClinicalActsRepository } from '../../src/modules/billing/infrastructure/prisma-clinical-acts.repository';
import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import { hasClinicalAct } from '../../src/shared/infrastructure/prisma/clinical-acts';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE NO SE EMITIÓ NO EXISTE FUERA DE LA PESTAÑA (ORD-096 a ORD-100),
 * CONTRA POSTGRESQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Revisión clínica de `fix/atencion-examenes`: los filtros de ORD-100 sólo los
 * cubrían dobles que comprobaban la forma de la consulta. Aquí, cada
 * consumidor contra la base, con el mismo borrador y —como control positivo—
 * la misma orden ya emitida por el mismo camino.
 */
const db = useDatabase();

const requester: Requester = { userId: 'user-1', sites: 'all' };
const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };
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
    acts: new PrismaClinicalActsRepository(client),
    documents: new PrismaDocumentSourceReader(
      client,
      'http://localhost/verificar',
    ),
  };
}

async function aDraft(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  const { orders } = adapters(prisma);
  const draft = await orders.compose({
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId: scene.bh.id }],
    sites: 'all',
  });
  return { scene, draft };
}

const issue = (prisma: PrismaClient, orderId: string) =>
  adapters(prisma).orders.issue({ orderId, sites: 'all' });

describe('ORD-100 un borrador no existe fuera de la pestaña', () => {
  it('ORD-100 no sale en la cola de pendientes; emitido, sí', async () => {
    const prisma = db();
    const { draft } = await aDraft(prisma);
    const pending = () =>
      adapters(prisma).orders.pending({ sites: 'all', now: new Date(), limit: 50 }); // prettier-ignore

    expect(await pending()).toEqual([]);
    await issue(prisma, draft.id);
    expect((await pending()).map((entry) => entry.orderId)).toEqual([draft.id]);
  });

  it('ORD-100 no propone cargo en caja ni cuenta como acto clínico; emitido, sí', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const { acts } = adapters(prisma);
    const exams = async () =>
      (await acts.findEncounterActs({ encounterId: scene.encounter.id, siteId: scene.site.id }))!.exams; // prettier-ignore

    expect(await exams()).toEqual([]);
    expect(await hasClinicalAct(prisma, scene.encounter.id)).toBe(false);

    await issue(prisma, draft.id);
    expect((await exams()).map((exam) => exam.testCode)).toEqual(['EX-BH']);
    expect(await hasClinicalAct(prisma, scene.encounter.id)).toBe(true);
  });

  it('ORD-100 no se imprime ni se verifica por su código; emitido, sí', async () => {
    const prisma = db();
    const { draft } = await aDraft(prisma);
    const { documents } = adapters(prisma);
    const { verificationCode } = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: draft.id },
      select: { verificationCode: true },
    });
    const subject = () =>
      documents.findSubject({ kind: 'SERVICE_ORDER', subjectId: draft.id, sites: 'all' }); // prettier-ignore

    expect(await subject()).toBeNull();
    expect(await documents.findForVerification(verificationCode)).toBeNull();

    await issue(prisma, draft.id);
    expect(await subject()).not.toBeNull();
    expect(
      await documents.findForVerification(verificationCode),
    ).not.toBeNull();
  });

  it('ORD-100 no admite informe ni anulación de línea; emitido, sí', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const { orders, reports } = adapters(prisma);
    const register = () =>
      reports.register(
        {
          orderId: draft.id,
          performedById: null,
          issuedAt: new Date(Date.now() - 3_600_000),
          results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
        },
        requester,
      );

    await expect(register()).rejects.toMatchObject({
      code: 'ORDER_NOT_ISSUED',
    });
    await expect(
      orders.cancelItem({ orderId: draft.id, itemId: draft.items[0]!.id, sites: 'all' }), // prettier-ignore
    ).rejects.toMatchObject({ code: 'ORDER_NOT_ISSUED' });

    await issue(prisma, draft.id);
    await expect(register()).resolves.toBeDefined();
  });
});

describe('ORD-096 a ORD-099 las transiciones del borrador', () => {
  it('ORD-096 ORD-098 lo emitido no se reescribe ni se vuelve a emitir', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const { orders } = adapters(prisma);
    const rewrite = () =>
      orders.rewrite({
        orderId: draft.id,
        category: 'LABORATORY',
        priority: 'URGENT',
        lines: [{ examDefinitionId: scene.glucose.id }],
        sites: 'all',
      });

    // Control positivo: en borrador, se reescribe.
    const rewritten = await rewrite();
    expect(rewritten.items.map((item) => item.testCode)).toEqual(['EX-GLUCOSA-AYUNAS']); // prettier-ignore
    await issue(prisma, draft.id);

    await expect(rewrite()).rejects.toMatchObject({ code: 'ORDER_NOT_DRAFT' });
    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'ORDER_NOT_DRAFT' }); // prettier-ignore
  });

  it('ORD-097 un hemograma no entra en una orden de imagen', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      adapters(prisma).orders.compose({
        encounterId: scene.encounter.id,
        category: 'IMAGING',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'EXAM_CATEGORY_MISMATCH' });
    expect(await prisma.serviceOrder.count()).toBe(0);
  });

  it('ORD-098 al emitir se vuelve a comprobar el examen: desactivado o de otro tipo, no sale', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);

    await prisma.examDefinition.update({ where: { id: scene.bh.id }, data: { active: false } }); // prettier-ignore
    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'EXAM_NOT_ORDERABLE' }); // prettier-ignore

    await prisma.examDefinition.update({ where: { id: scene.bh.id }, data: { active: true, category: 'IMAGING' } }); // prettier-ignore
    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'EXAM_CATEGORY_MISMATCH' }); // prettier-ignore

    // Control positivo: con el examen como estaba, se emite.
    await prisma.examDefinition.update({ where: { id: scene.bh.id }, data: { category: 'LABORATORY' } }); // prettier-ignore
    await expect(issue(prisma, draft.id)).resolves.toMatchObject({ status: 'ISSUED' }); // prettier-ignore
  });

  it('ORD-005 ORD-099 en una atención cerrada no se emite, pero sí se descarta', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    await prisma.encounter.update({
      where: { id: scene.encounter.id },
      data: {
        status: 'COMPLETED',
        // Después de `started_at` (`encounter_time_order`), y con su
        // condición de alta (`encounter_discharge_states_a_condition`).
        endedAt: new Date(scene.encounter.startedAt.getTime() + 3_600_000),
        dischargeCondition: 'ALIVE',
      },
    });

    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'ORDER_ENCOUNTER_NOT_OPEN' }); // prettier-ignore
    const discarded = await adapters(prisma).orders.discard({
      orderId: draft.id,
      sites: 'all',
      userId: (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId, // prettier-ignore
    });
    expect(discarded.status).toBe('DISCARDED');
    expect(discarded.number).toBeNull();
  });

  it('ORD-096 la orden descartada tampoco se reescribe, y una línea de borrador no nace hecha', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId; // prettier-ignore

    await expect(
      prisma.$executeRaw`
        INSERT INTO service_order_item (service_order_id, concept_id, test_code, test_display, status, completed_at)
        VALUES (${draft.id}::uuid, ${scene.concept.id}::uuid, 'EX-BH', 'Biometría', 'COMPLETED', now())`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);
    await expect(
      prisma.$executeRaw`UPDATE service_order_item SET status = 'COMPLETED', completed_at = now() WHERE service_order_id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);

    await adapters(prisma).orders.discard({ orderId: draft.id, sites: 'all', userId }); // prettier-ignore
    await expect(
      prisma.$executeRaw`UPDATE service_order SET priority = 'STAT' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
  });

  it('ORD-098 lo impreso de una orden emitida no se reescribe: ni su fecha ni su código', async () => {
    const prisma = db();
    const { draft } = await aDraft(prisma);
    await issue(prisma, draft.id);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET requested_at = now() - interval '30 days' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
    await expect(
      prisma.$executeRaw`UPDATE service_order SET verification_code = 'AAAAAAAAAAAAAAAA' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
    // Control positivo: lo que no está congelado se mueve.
    await expect(
      prisma.$executeRaw`UPDATE service_order SET updated_at = now() WHERE id = ${draft.id}::uuid`,
    ).resolves.toBe(1);
  });
});
