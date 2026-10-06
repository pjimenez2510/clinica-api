import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { OrderItemHasResultsError } from '../../src/modules/orders/domain/orders.errors';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORD-131 (D-139.1). UN EXAMEN CON ALGÚN RESULTADO NO SE ANULA, CONTRA
 * POSTGRESQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La biometría tiene varias determinaciones: con sólo la hemoglobina el
 * informe queda parcial y la línea sigue pendiente, que es justo el caso que
 * antes se podía anular dejando sus valores bajo una línea anulada.
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

/** An issued order of the blood count and the glucose, the count with a partial report. */
async function aPartialBloodCount(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  const orders = new PrismaServiceOrderRepository(client);
  const reports = new DiagnosticReportService(
    new PrismaDiagnosticReportRepository(client),
    orders,
    new PrismaExamCatalogueRepository(client),
    silentAudit,
    noopLogger as never,
  );
  const scene = await aScene(prisma);
  // Una segunda determinación de la biometría, para que la hemoglobina sola
  // deje el informe parcial (como ORD-030).
  await prisma.examDefinitionAnalyte.create({
    data: {
      examDefinitionId: scene.bh.id,
      analyteDefinitionId: scene.glu.id,
      position: 2,
    },
  });
  const order = await placeIssued(orders, {
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [
      { examDefinitionId: scene.bh.id },
      { examDefinitionId: scene.glucose.id },
    ],
    sites: 'all',
  });
  const now = new Date();
  await reports.register(
    {
      orderId: order.id,
      performedById: null,
      issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
      results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
    },
    requester,
    now,
  );
  const line = (code: string) => order.items.find((i) => i.testCode === code)!; // prettier-ignore
  const userId = (await createUser(prisma)).id;
  return { orders, order, userId, bh: line('EX-BH'), glucose: line('EX-GLUCOSA-AYUNAS') }; // prettier-ignore
}

const statusOf = async (prisma: PrismaClient, id: string) =>
  (await prisma.serviceOrderItem.findUniqueOrThrow({ where: { id }, select: { status: true } })).status; // prettier-ignore

describe('ORD-131 un examen con algún resultado no se anula', () => {
  it('ORD-131 la base no deja anular una línea pendiente con un resultado; sin resultados, sí (control positivo)', async () => {
    const prisma = db();
    const { bh, glucose, userId } = await aPartialBloodCount(prisma);
    expect(await statusOf(prisma, bh.id)).toBe('REQUESTED');

    await expect(
      prisma.$executeRaw`UPDATE "service_order_item" SET "status" = 'CANCELLED', "completed_at" = clock_timestamp(), "cancelled_by_id" = ${userId}::uuid WHERE "id" = ${bh.id}::uuid`,
    ).rejects.toThrow(
      /ORD-131|service_order_item_with_result_is_not_cancelled/,
    );
    await expect(
      prisma.$executeRaw`UPDATE "service_order_item" SET "status" = 'CANCELLED', "completed_at" = clock_timestamp(), "cancelled_by_id" = ${userId}::uuid WHERE "id" = ${glucose.id}::uuid`,
    ).resolves.toBe(1);
  });

  it('ORD-131 anular la línea con un resultado parcial se rechaza y no cambia nada', async () => {
    const prisma = db();
    const { orders, order, bh, glucose, userId } = await aPartialBloodCount(prisma); // prettier-ignore

    await expect(
      orders.cancelItem({ orderId: order.id, itemId: bh.id, sites: 'all', cancelledById: userId }), // prettier-ignore
    ).rejects.toBeInstanceOf(OrderItemHasResultsError);
    expect(await statusOf(prisma, bh.id)).toBe('REQUESTED');
    // La orden lo publica, para que la pantalla no ofrezca «Anular».
    const view = await orders.byId({ orderId: order.id, sites: 'all' });
    expect(view?.items.map((item) => [item.testCode, item.hasResults])).toEqual([['EX-BH', true], ['EX-GLUCOSA-AYUNAS', false]]); // prettier-ignore
    // Control positivo: la glucosa, sin resultados, sí se anula.
    await orders.cancelItem({ orderId: order.id, itemId: glucose.id, sites: 'all', cancelledById: userId }); // prettier-ignore
    expect(await statusOf(prisma, glucose.id)).toBe('CANCELLED');
  });

  it('ORD-131 corregir la orden deja la línea con resultados como estaba y sólo vuelve a pedir la otra', async () => {
    const prisma = db();
    const { orders, order, bh, glucose, userId } = await aPartialBloodCount(prisma); // prettier-ignore

    const { draft } = await orders.correct({ orderId: order.id, sites: 'all', cancelledById: userId }); // prettier-ignore

    expect(await statusOf(prisma, bh.id)).toBe('REQUESTED');
    expect(await statusOf(prisma, glucose.id)).toBe('CANCELLED');
    expect(draft.items.map((item) => item.testCode)).toEqual(['EX-GLUCOSA-AYUNAS']); // prettier-ignore
  });

  it('ORD-131 corregir una orden cuyas líneas pendientes tienen todas resultados se rechaza sin anular nada', async () => {
    const prisma = db();
    const { orders, order, glucose, bh, userId } = await aPartialBloodCount(prisma); // prettier-ignore
    await orders.cancelItem({ orderId: order.id, itemId: glucose.id, sites: 'all', cancelledById: userId }); // prettier-ignore

    await expect(
      orders.correct({
        orderId: order.id,
        sites: 'all',
        cancelledById: userId,
      }),
    ).rejects.toBeInstanceOf(OrderItemHasResultsError);
    expect(await statusOf(prisma, bh.id)).toBe('REQUESTED');
    expect(await prisma.serviceOrder.count({ where: { encounterId: order.encounterId, status: 'DRAFT' } })).toBe(0); // prettier-ignore
  });
});
