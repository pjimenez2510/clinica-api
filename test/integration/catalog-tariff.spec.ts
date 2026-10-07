import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { importTariff } from '../../prisma/seed-clinical-catalogues.mts';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, aTariffConcept } from './orders-fixtures';
import { useDatabase } from './setup/database';

/**
 * ORD-133. The Tarifario de Prestaciones del SNS 2014 replacing the tariff a
 * base already had, against a real PostgreSQL and the real order adapter: an
 * exam that still names an old code keeps being orderable (ORD-004), one
 * moved to its official code is ordered against the official concept, and a
 * code nobody used is truly retired.
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
  examDefinitionId: string,
) =>
  ordersOf(prisma).compose({
    encounterId,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId }],
    sites: 'all',
  });

describe('the official tariff (ORD-133)', () => {
  it('ORD-133: loads the 2014 tariff and keeps in force only the old codes an active exam names', async () => {
    const prisma = db();
    const { cutover } = await aSceneWithTheOldTariff(prisma);

    const result = await importTariff(prisma, {
      now: new Date(),
      effectiveFrom: cutover,
    });

    expect(result.status).toBe('imported');
    expect(result.inserted).toBeGreaterThan(8_000);
    expect(result.kept).toEqual([
      { code: 'EX-BH', exams: ['EX-BH'] },
      { code: 'EX-GLUCOSA-AYUNAS', exams: ['EX-GLUCOSA-AYUNAS'] },
    ]);
    const old = await prisma.catalogConcept.findMany({
      where: { code: { in: ['EX-BH', 'EX-NADIE-LO-USA'] } },
      orderBy: { code: 'asc' },
    });
    expect(old.map((concept) => [concept.code, concept.validTo])).toEqual([
      ['EX-BH', null],
      ['EX-NADIE-LO-USA', cutover],
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
    await importTariff(prisma, { now: new Date(), effectiveFrom: cutover });

    // Positive control: the code kept in force still orders (ORD-004).
    await expect(
      orderOf(prisma, scene.encounter.id, scene.bh.id),
    ).resolves.toMatchObject({ status: 'DRAFT' });

    await prisma.examDefinition.update({
      where: { id: scene.glucose.id },
      data: { tariffCode: '360009' },
    });
    const order = await orderOf(prisma, scene.encounter.id, scene.glucose.id);
    const item = await prisma.serviceOrderItem.findFirstOrThrow({
      where: { serviceOrderId: order.id },
      include: { concept: true },
    });
    expect(item.concept.code).toBe('360009');
  });

  it('ORD-133: a code nobody used is retired: an exam pointed at it afterwards is refused', async () => {
    const prisma = db();
    const { scene, cutover } = await aSceneWithTheOldTariff(prisma);
    await importTariff(prisma, { now: new Date(), effectiveFrom: cutover });

    await prisma.examDefinition.update({
      where: { id: scene.glucose.id },
      data: { tariffCode: 'EX-NADIE-LO-USA' },
    });

    await expect(
      orderOf(prisma, scene.encounter.id, scene.glucose.id),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_IN_FORCE' });
  });
});
