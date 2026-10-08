import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ServiceOrderService,
  type Requester,
} from '../../src/modules/orders/application/service-order.service';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { AnnulledDocumentArchiver } from '../../src/shared/documents/annulled-document.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { closeThroughCashier } from './setup/fixtures';
import { useDatabase } from './setup/database';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORD-118. «CORREGIR» UNA ORDEN EMITIDA, DE UN PASO Y EN UNA TRANSACCIÓN,
 * CONTRA POSTGRESQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que vale demostrar contra la base es la atomicidad: las líneas se anulan
 * y el borrador se escribe en la misma transacción, así que un fallo al
 * escribir el borrador tiene que dejar las líneas vivas. Un doble no puede
 * demostrar eso.
 */
const db = useDatabase();

const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };
/** DOC-109 is proven in `documents-http.spec.ts`; here, no PDF to archive. */
const noDocuments: AnnulledDocumentArchiver = {
  archiveAnnulled: () => Promise.resolve(null),
};
const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function serviceOf(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  return new ServiceOrderService(
    new PrismaServiceOrderRepository(client),
    new PrismaExamCatalogueRepository(client),
    noopLogger as never,
    silentAudit,
    noDocuments,
  );
}

/** An issued order of two exams, signed by the scene's practitioner. */
async function anIssuedOrder(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  const { userId } = await prisma.practitioner.findUniqueOrThrow({
    where: { id: scene.practitioner.id },
  });
  const signer: Requester = { userId, sites: 'all' };
  const order = await placeIssued(
    new PrismaServiceOrderRepository(prisma as unknown as PrismaService),
    {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'URGENT',
      clinicalNoteText: 'Control de anemia',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    },
  );
  return { scene, signer, order };
}

const liveLines = (prisma: PrismaClient, orderId: string) =>
  prisma.serviceOrderItem.count({
    where: { serviceOrderId: orderId, status: 'REQUESTED' },
  });

describe('ORD-118 corregir una orden emitida', () => {
  it('ORD-118 anula las líneas vivas y abre en la misma atención un borrador con sus exámenes, tipo, prioridad e indicación', async () => {
    const prisma = db();
    const { scene, signer, order } = await anIssuedOrder(prisma);
    // The blood count already has its result: it is not annulled, and it is
    // not asked for again.
    const [answered, live] = order.items;
    await prisma.serviceOrderItem.update({
      where: { id: answered!.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const { cancelled, draft } = await serviceOf(prisma).correct(
      order.id,
      signer,
    );

    expect(cancelled.id).toBe(order.id);
    expect(cancelled.status).toBe('ISSUED');
    expect(cancelled.pendingItems).toBe(0);
    expect(
      Object.fromEntries(cancelled.items.map((item) => [item.id, item.status])),
    ).toEqual({ [answered!.id]: 'COMPLETED', [live!.id]: 'CANCELLED' });

    expect(draft).toMatchObject({
      status: 'DRAFT',
      number: null,
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'URGENT',
      clinicalNoteText: 'Control de anemia',
    });
    expect(draft.id).not.toBe(order.id);
    expect(
      draft.items.map((item) => [item.testCode, item.testDisplay, item.conceptId, item.status]), // prettier-ignore
    ).toEqual([[live!.testCode, live!.testDisplay, live!.conceptId, 'REQUESTED']]); // prettier-ignore
  });

  it('ORD-118 si el borrador nuevo no se puede escribir, no se anula ninguna línea', async () => {
    const prisma = db();
    const { scene, signer, order } = await anIssuedOrder(prisma);

    /**
     * EL FALLO SE FUERZA EN LA BASE, DESPUÉS DE ANULAR: un disparador de prueba
     * rechaza el INSERT de una orden en esta atención. Las anulaciones ya se
     * escribieron en la misma transacción, así que sólo la atomicidad puede
     * deshacerlas.
     */
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_service_order_insert()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test_forced_failure';
      END;
      $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_refuse_service_order_insert
        BEFORE INSERT ON service_order FOR EACH ROW
        WHEN (NEW.encounter_id = '${scene.encounter.id}'::uuid)
        EXECUTE FUNCTION test_refuse_service_order_insert()`);
    try {
      await expect(serviceOf(prisma).correct(order.id, signer)).rejects.toThrow(
        /test_forced_failure/,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_refuse_service_order_insert ON service_order',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS test_refuse_service_order_insert()',
      );
    }

    expect(await liveLines(prisma, order.id)).toBe(2);
    expect(await prisma.serviceOrder.count()).toBe(1);

    // Control positivo: sin el fallo, el mismo camino anula y abre el borrador.
    await serviceOf(prisma).correct(order.id, signer);
    expect(await liveLines(prisma, order.id)).toBe(0);
    expect(await prisma.serviceOrder.count()).toBe(2);
  });

  it('ORD-118 con la atención cerrada no corrige, y no anula nada', async () => {
    const prisma = db();
    const { scene, signer, order } = await anIssuedOrder(prisma);
    // Cerrada como se cierra: caja liquida la cuenta (BI-236).
    await closeThroughCashier(prisma, scene.encounter.id);

    await expect(
      serviceOf(prisma).correct(order.id, signer),
    ).rejects.toMatchObject({ code: 'ORDER_ENCOUNTER_NOT_OPEN' });
    expect(await liveLines(prisma, order.id)).toBe(2);
    expect(await prisma.serviceOrder.count()).toBe(1);

    // Control positivo: anular una línea sí se puede; sólo el borrador
    // necesita la atención abierta.
    await expect(
      serviceOf(prisma).cancelItem(order.id, order.items[0]!.id, signer),
    ).resolves.toMatchObject({ pendingItems: 1 });
  });

  it('ORD-118 sólo quien firma la orden la corrige', async () => {
    const prisma = db();
    const { signer, order } = await anIssuedOrder(prisma);
    const colleague: Requester = { userId: crypto.randomUUID(), sites: 'all' };

    await expect(
      serviceOf(prisma).correct(order.id, colleague),
    ).rejects.toMatchObject({ code: 'ORDER_OF_ANOTHER_PRACTITIONER' });
    expect(await liveLines(prisma, order.id)).toBe(2);

    // Control positivo: quien la firma, sí.
    await expect(
      serviceOf(prisma).correct(order.id, signer),
    ).resolves.toMatchObject({ draft: { status: 'DRAFT' } });
  });

  it('ORD-118 un borrador no se corrige, ni una orden sin líneas vivas', async () => {
    const prisma = db();
    const { scene, signer, order } = await anIssuedOrder(prisma);
    const repository = new PrismaServiceOrderRepository(
      prisma as unknown as PrismaService,
    );
    const draft = await repository.compose({
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });

    await expect(
      serviceOf(prisma).correct(draft.id, signer),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_ISSUED' });

    await prisma.serviceOrderItem.updateMany({
      where: { serviceOrderId: order.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await expect(
      serviceOf(prisma).correct(order.id, signer),
    ).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_PENDING' });
    expect(await prisma.serviceOrder.count()).toBe(2);
  });

  it('ORD-118 dos «Corregir» a la vez de la misma orden: gana uno, que abre UN borrador, y el otro recibe ORDER_ITEM_NOT_PENDING', async () => {
    const prisma = db();
    const { signer, order } = await anIssuedOrder(prisma);
    const service = serviceOf(prisma);

    const outcomes = await Promise.allSettled([
      service.correct(order.id, signer),
      service.correct(order.id, signer),
    ]);

    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ code: 'ORDER_ITEM_NOT_PENDING' });
    // Exactamente un borrador nuevo, el de la ganadora, con los dos exámenes.
    const drafts = await prisma.serviceOrder.findMany({
      where: { status: 'DRAFT' },
      select: { id: true, _count: { select: { items: true } } },
    });
    expect(drafts).toEqual([
      { id: won[0]!.value.draft.id, _count: { items: 2 } },
    ]);
    expect(await liveLines(prisma, order.id)).toBe(0);
  });
});
