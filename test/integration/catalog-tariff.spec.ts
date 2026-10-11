import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { importTariff } from '../../prisma/seed-clinical-catalogues.mts';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import {
  BH_MSP_CODE,
  GLUCOSE_MSP_CODE,
  aScene,
  aTariffConcept,
} from './orders-fixtures';
import { useDatabase } from './setup/database';

/**
 * ORD-133. The Tarifario de Prestaciones del SNS 2014 replacing the tariff a
 * base already had, against a real PostgreSQL and the real order adapter: a
 * service that still names an old MSP code keeps its concept (ORD-004), one
 * moved to its official code is ordered against the official concept, and a
 * code nobody used is truly retired — no line takes it any more, though the
 * line is still accepted (D-218 §1).
 */
const db = useDatabase();

const ordersOf = (prisma: PrismaClient) =>
  new PrismaServiceOrderRepository(prisma as unknown as PrismaService);

/** A scene with the development tariff, and the cut-over the day before it. */
async function aSceneWithTheOldTariff(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  await aTariffConcept(prisma, { code: 'EX-NADIE-LO-USA' });
  const started = scene.encounter.startedAt;
  const cutover = new Date(
    Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate() - 1), // prettier-ignore
  );
  return { scene, cutover };
}

const orderOf = (
  prisma: PrismaClient,
  encounterId: string,
  serviceId: string,
) =>
  ordersOf(prisma).compose({
    encounterId,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ serviceId }],
    sites: 'all',
  });

describe('the official tariff (ORD-133)', () => {
  it('ORD-133: loads the 2014 tariff and keeps in force only the old codes an active exam names', async () => {
    const prisma = db();
    const { cutover } = await aSceneWithTheOldTariff(prisma);

    const result = await importTariff(prisma, {
      now: new Date(),
      effectiveFrom: cutover,
      allowPastCutover: true,
    });

    expect(result.status).toBe('imported');
    expect(result.inserted).toBeGreaterThan(8_000);
    expect(result.kept).toEqual([
      { code: BH_MSP_CODE, exams: ['LAB-BH'] },
      { code: GLUCOSE_MSP_CODE, exams: ['LAB-GLUCOSA-AYUNAS'] },
    ]);
    const old = await prisma.catalogConcept.findMany({
      where: { code: { in: [BH_MSP_CODE, 'EX-NADIE-LO-USA'] } },
      orderBy: { code: 'asc' },
    });
    expect(old.map((concept) => [concept.code, concept.validTo])).toEqual([
      ['EX-NADIE-LO-USA', cutover],
      [BH_MSP_CODE, null],
    ]);
    expect(
      await prisma.catalogConcept.findFirst({
        where: { code: '340077', system: { code: 'TARIFF' } },
      }),
    ).toMatchObject({
      display: 'BIOMETRIA HEMATICA',
      attributes: expect.objectContaining({ section: 'HEMATOLOGIA' }),
    });
  });

  it('ORD-133: an exam with its old code is still ordered, and one moved to the official code orders the official concept', async () => {
    const prisma = db();
    const { scene, cutover } = await aSceneWithTheOldTariff(prisma);
    await importTariff(prisma, {
      now: new Date(),
      effectiveFrom: cutover,
      allowPastCutover: true,
    });

    // Positive control: the code kept in force still resolves (ORD-004).
    const kept = await orderOf(prisma, scene.encounter.id, scene.bh.id);
    expect(kept.items[0]?.conceptId).toBe(scene.concept.id);

    await prisma.service.update({
      where: { id: scene.glucose.id },
      data: { mspCode: '360009' },
    });
    const order = await orderOf(prisma, scene.encounter.id, scene.glucose.id);
    const item = await prisma.serviceOrderItem.findFirstOrThrow({
      where: { serviceOrderId: order.id },
      include: { concept: true },
    });
    expect(item.concept?.code).toBe('360009');
  });

  it('ORD-133 ORD-004: a code nobody used is retired: a service pointed at it afterwards is ordered without concept', async () => {
    const prisma = db();
    const { scene, cutover } = await aSceneWithTheOldTariff(prisma);
    await importTariff(prisma, {
      now: new Date(),
      effectiveFrom: cutover,
      allowPastCutover: true,
    });

    await prisma.service.update({
      where: { id: scene.glucose.id },
      data: { mspCode: 'EX-NADIE-LO-USA' },
    });

    const order = await orderOf(prisma, scene.encounter.id, scene.glucose.id);
    expect(order.items[0]).toMatchObject({
      testCode: 'LAB-GLUCOSA-AYUNAS',
      conceptId: null,
    });
  });
});
