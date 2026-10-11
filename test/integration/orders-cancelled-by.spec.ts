import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ServiceOrderService,
  type Requester,
} from '../../src/modules/orders/application/service-order.service';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../src/shared/audit/access-audit.port';
import type { AnnulledDocumentArchiver } from '../../src/shared/documents/annulled-document.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORD-007 Y ORD-118. QUIÉN ANULÓ UN EXAMEN, CONTRA POSTGRESQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Anular un examen de una orden emitida es sacarlo de la cola del laboratorio
 * con el papel ya en la mano del paciente. La línea guardaba cuándo
 * (`completed_at`) y no quién. Lo que sólo la base demuestra: que una línea que
 * pasa a `CANCELLED` sin decir quién se rechaza aunque se salte la aplicación,
 * y que quién anuló no se reescribe después.
 */
const db = useDatabase();

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
  const trail: AccessAuditEntry[] = [];
  const audit: AccessAuditRecorder = {
    record: (entry) => {
      trail.push(entry);
      return Promise.resolve();
    },
  };
  const service = new ServiceOrderService(
    new PrismaServiceOrderRepository(client),
    new PrismaExamCatalogueRepository(client),
    noopLogger as never,
    audit,
    noDocuments,
  );
  return { service, trail };
}

/** An issued order of two exams, signed by the scene's practitioner. */
async function anIssuedOrder(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  const { userId } = await prisma.practitioner.findUniqueOrThrow({
    where: { id: scene.practitioner.id },
  });
  const signer: Requester = { userId, sites: 'all', ip: '10.0.0.7' };
  const order = await placeIssued(
    new PrismaServiceOrderRepository(prisma as unknown as PrismaService),
    {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ serviceId: scene.bh.id }, { serviceId: scene.glucose.id }],
      sites: 'all',
    },
  );
  return { scene, signer, order };
}

describe('ORD-007 y ORD-118 quién anuló un examen', () => {
  it('ORD-007 la base no deja anular una línea sin decir quién, ni decir quién en una que no está anulada', async () => {
    const prisma = db();
    const { order } = await anIssuedOrder(prisma);
    const [first, second] = order.items;
    const nurse = await createUser(prisma);

    await expect(
      prisma.$executeRaw`
        UPDATE service_order_item SET status = 'CANCELLED', completed_at = now()
         WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/service_order_item_cancel_states_who/);
    await expect(
      prisma.$executeRaw`
        UPDATE service_order_item SET cancelled_by_id = ${nurse.id}::uuid
         WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/service_order_item_cancelled_by_only_when_cancelled/);
    await expect(
      prisma.$executeRaw`
        UPDATE service_order_item SET status = 'COMPLETED', completed_at = now(),
               cancelled_by_id = ${nurse.id}::uuid
         WHERE id = ${second!.id}::uuid`,
    ).rejects.toThrow(/service_order_item_cancelled_by_only_when_cancelled/);

    // Control positivo: anulada y con quién, entra.
    await expect(
      prisma.$executeRaw`
        UPDATE service_order_item SET status = 'CANCELLED', completed_at = now(),
               cancelled_by_id = ${nurse.id}::uuid
         WHERE id = ${first!.id}::uuid`,
    ).resolves.toBe(1);
  });

  it('ORD-007 quién anuló no se reescribe, y una línea no nace anulada por nadie', async () => {
    const prisma = db();
    const { scene, order } = await anIssuedOrder(prisma);
    const [first] = order.items;
    const nurse = await createUser(prisma);
    const colleague = await createUser(prisma);
    await prisma.$executeRaw`
      UPDATE service_order_item SET status = 'CANCELLED', completed_at = now(),
             cancelled_by_id = ${nurse.id}::uuid
       WHERE id = ${first!.id}::uuid`;

    await expect(
      prisma.$executeRaw`
        UPDATE service_order_item SET cancelled_by_id = ${colleague.id}::uuid
         WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);

    // Una línea nueva, en un borrador, nace sin quién la anuló.
    const draft = await prisma.serviceOrder.create({
      data: {
        encounterId: scene.encounter.id,
        siteId: scene.site.id,
        orderedById: scene.practitioner.id,
        category: 'LABORATORY',
      },
    });
    await expect(
      prisma.serviceOrderItem.create({
        data: {
          serviceOrderId: draft.id,
          conceptId: first!.conceptId,
          testCode: first!.testCode,
          testDisplay: first!.testDisplay,
          cancelledById: nurse.id,
        },
      }),
    ).rejects.toThrow(/service_order_item_frozen_once_issued|service_order_item_cancelled_by_only_when_cancelled/); // prettier-ignore

    // Control positivo: la misma línea, sin quién, entra en el borrador.
    await expect(
      prisma.serviceOrderItem.create({
        data: {
          serviceOrderId: draft.id,
          conceptId: first!.conceptId,
          testCode: first!.testCode,
          testDisplay: first!.testDisplay,
        },
      }),
    ).resolves.toMatchObject({ cancelledById: null });
    const stored = await prisma.serviceOrderItem.findUniqueOrThrow({ where: { id: first!.id } }); // prettier-ignore
    expect(stored.cancelledById).toBe(nurse.id);
  });

  it('ORD-007 anular un examen guarda quién lo anuló —la sesión— y deja su fila en la bitácora', async () => {
    const prisma = db();
    const { order } = await anIssuedOrder(prisma);
    const [first, second] = order.items;
    const nurse = await createUser(prisma);
    const { service, trail } = serviceOf(prisma);

    await service.cancelItem(order.id, first!.id, {
      userId: nurse.id,
      sites: 'all',
      ip: '10.0.0.9',
      userAgent: 'Prueba',
    });

    const rows = await prisma.serviceOrderItem.findMany({
      where: { serviceOrderId: order.id },
      select: {
        id: true,
        status: true,
        completedAt: true,
        cancelledById: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first!.id)).toMatchObject({ status: 'CANCELLED', cancelledById: nurse.id }); // prettier-ignore
    expect(byId.get(first!.id)?.completedAt).not.toBeNull();
    // Control positivo: la otra línea sigue viva y sin quién.
    expect(byId.get(second!.id)).toMatchObject({ status: 'REQUESTED', cancelledById: null }); // prettier-ignore

    expect(trail).toEqual([
      {
        userId: nurse.id,
        resourceType: 'service_order_item',
        resourceId: first!.id,
        action: 'UPDATE',
        ip: '10.0.0.9',
        userAgent: 'Prueba',
      },
    ]);
  });

  it('ORD-118 corregir la orden guarda quién anuló cada examen vivo y deja en la bitácora la orden anulada y el borrador nuevo', async () => {
    const prisma = db();
    const { signer, order } = await anIssuedOrder(prisma);
    const [answered, live] = order.items;
    await prisma.serviceOrderItem.update({
      where: { id: answered!.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    const { service, trail } = serviceOf(prisma);

    const { draft } = await service.correct(order.id, signer);

    const rows = await prisma.serviceOrderItem.findMany({
      where: { serviceOrderId: order.id },
      select: { id: true, status: true, cancelledById: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(live!.id)).toMatchObject({ status: 'CANCELLED', cancelledById: signer.userId }); // prettier-ignore
    // Control positivo: la que ya tenía resultado no se anula ni dice quién.
    expect(byId.get(answered!.id)).toMatchObject({ status: 'COMPLETED', cancelledById: null }); // prettier-ignore

    expect(trail).toEqual([
      {
        userId: signer.userId,
        resourceType: 'service_order',
        resourceId: order.id,
        action: 'UPDATE',
        ip: '10.0.0.7',
        userAgent: undefined,
      },
      {
        userId: signer.userId,
        resourceType: 'service_order',
        resourceId: draft.id,
        action: 'CREATE',
        ip: '10.0.0.7',
        userAgent: undefined,
      },
    ]);
  });
});
