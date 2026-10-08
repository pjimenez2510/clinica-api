import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';

import { useDatabase } from './setup/database';

/**
 * BI-232 (D-161, amended by D-179.3). The starting catalogue brings, for each
 * starting service type of EVERY specialty —«Primera vez» and «Control»—, a
 * consultation tied to it as its first service (SP-031), and prices only those
 * that had a starting price. Against the real seeds, not a fixture: what is
 * checked is what a clinic installs.
 */
const db = useDatabase();

let prisma: PrismaClient;

beforeEach(() => {
  prisma = db();
});

/** Every service type with the service it charges first. */
async function consultationsByType() {
  return prisma.serviceType.findMany({
    select: {
      name: true,
      specialty: { select: { code: true } },
      billableServices: {
        orderBy: { position: 'asc' },
        select: {
          position: true,
          billableService: {
            select: {
              code: true,
              category: { select: { kind: true } },
              _count: { select: { prices: true } },
            },
          },
        },
      },
    },
  });
}

describe('BI-232 la consulta de cada tipo de atención en el catálogo de arranque', () => {
  it('BI-232 BI-158 cada tipo sembrado tiene su consulta, de la clase consulta, en la posición 0', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const types = await consultationsByType();
    // Control: 22 specialties × «Primera vez» y «Control» (SP-001, SP-020).
    expect(types).toHaveLength(44);
    for (const type of types) {
      const where = `${type.specialty.code} · ${type.name}`;
      expect(type.billableServices, where).toHaveLength(1);
      const [first] = type.billableServices;
      expect(first!.position).toBe(0);
      expect(first!.billableService.category.kind).toBe('CONSULTATION');
      // BI-171: the SRI's 25 characters.
      expect(first!.billableService.code.length).toBeLessThanOrEqual(25);
    }
    const generalFirst = types.find(
      (type) => type.specialty.code === 'medicina-general' && type.name === 'Primera vez', // prettier-ignore
    );
    expect(generalFirst?.billableServices[0]?.billableService.code).toBe('CONS-MG-PV'); // prettier-ignore
  });

  it('BI-232 la de cardiología nace sin precio en ninguna lista, y la de medicina general con el suyo (control)', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const types = await consultationsByType();
    const prices = (code: string) =>
      types
        .filter((type) => type.specialty.code === code)
        .map((type) => type.billableServices[0]!.billableService._count.prices);

    expect(prices('cardiologia')).toEqual([0, 0]);
    expect(prices('medicina-general')).toEqual([1, 1]);
  });

  it('BI-232 sembrar facturación antes que especialidades no las ata, y la siguiente corrida sí', async () => {
    await seedBilling(prisma);
    await seedSpecialties(prisma);
    expect(await prisma.serviceTypeBillableService.count()).toBe(0);

    await seedBilling(prisma);

    const link = await prisma.serviceTypeBillableService.findFirstOrThrow({
      where: { billableService: { code: 'CONS-CAR-PV' } },
      select: { serviceType: { select: { name: true, specialty: { select: { code: true } } } } }, // prettier-ignore
    });
    expect(link.serviceType).toEqual({
      name: 'Primera vez',
      specialty: { code: 'cardiologia' },
    });
  });

  it('BI-232 el tipo al que la clínica ya le dio su prestación no se pisa', async () => {
    await seedSpecialties(prisma);
    const firstVisit = await prisma.serviceType.findFirstOrThrow({
      where: { name: 'Primera vez', specialty: { code: 'cardiologia' } },
    });
    await seedBilling(prisma);
    // The clinic gives the type a service of its own.
    const seeded = await prisma.billableService.findUniqueOrThrow({
      where: { code: 'CONS-CAR-PV' },
    });
    await prisma.serviceTypeBillableService.deleteMany({
      where: { serviceTypeId: firstVisit.id },
    });
    const own = await prisma.billableService.create({
      data: {
        code: 'MI-CARDIO-1',
        name: 'Valoración cardiológica',
        categoryId: seeded.categoryId,
        taxRateId: seeded.taxRateId,
      },
    });
    await prisma.serviceTypeBillableService.create({
      data: { serviceTypeId: firstVisit.id, billableServiceId: own.id, position: 0 }, // prettier-ignore
    });

    await seedBilling(prisma);

    const links = await prisma.serviceTypeBillableService.findMany({
      where: { serviceTypeId: firstVisit.id },
      select: { billableServiceId: true },
    });
    expect(links).toEqual([{ billableServiceId: own.id }]);
  });
});
