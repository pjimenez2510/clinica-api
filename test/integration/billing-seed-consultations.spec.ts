import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';

import { useDatabase } from './setup/database';

/**
 * BI-232 (D-161). The starting catalogue brings the first-time and the
 * subsequent consultation of EVERY specialty of the starting specialty
 * catalogue, tied to it (BI-158), and prices only those that had a starting
 * price. Against the real seeds, not a fixture: what is checked is what a
 * clinic installs.
 */
const db = useDatabase();

let prisma: PrismaClient;

beforeEach(() => {
  prisma = db();
});

/** Every specialty with the visit sequences its consultations cover. */
async function consultationsBySpecialty() {
  const specialties = await prisma.specialty.findMany({
    select: { code: true, id: true },
  });
  const services = await prisma.billableService.findMany({
    where: { specialtyId: { not: null } },
    select: {
      code: true,
      specialtyId: true,
      visitSequence: true,
      category: { select: { kind: true } },
      _count: { select: { prices: true } },
    },
  });
  return specialties.map((specialty) => ({
    code: specialty.code,
    services: services.filter((one) => one.specialtyId === specialty.id),
  }));
}

describe('BI-232 la consulta de cada especialidad en el catálogo de arranque', () => {
  it('BI-232 BI-158 cada especialidad sembrada tiene su consulta de primera vez y subsecuente, de la clase consulta', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const bySpecialty = await consultationsBySpecialty();
    // Control: the specialty catalogue is really there (SP-001).
    expect(bySpecialty).toHaveLength(22);
    for (const { code, services } of bySpecialty) {
      expect(
        services.map((one) => one.visitSequence).sort(),
        `la especialidad ${code}`,
      ).toEqual(['FIRST_TIME', 'SUBSEQUENT']);
      for (const service of services) {
        expect(service.category.kind).toBe('CONSULTATION');
        // BI-171: the SRI's 25 characters.
        expect(service.code.length).toBeLessThanOrEqual(25);
      }
    }
  });

  it('BI-232 la de cardiología nace sin precio en ninguna lista, y la de medicina general con el suyo (control)', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const bySpecialty = await consultationsBySpecialty();
    const prices = (code: string) =>
      bySpecialty
        .find((one) => one.code === code)!
        .services.map((one) => one._count.prices);

    expect(prices('cardiologia')).toEqual([0, 0]);
    expect(prices('medicina-general')).toEqual([1, 1]);
  });

  it('BI-232 sembrar facturación antes que especialidades no las ata, y la siguiente corrida sí', async () => {
    await seedBilling(prisma);
    await seedSpecialties(prisma);
    expect(
      await prisma.billableService.count({
        where: { code: 'CONS-CAR-PV', specialtyId: null },
      }),
    ).toBe(1);

    await seedBilling(prisma);

    const cardiology = await prisma.specialty.findFirstOrThrow({
      where: { code: 'cardiologia' },
    });
    expect(
      await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-CAR-PV' },
        select: { specialtyId: true, visitSequence: true },
      }),
    ).toEqual({ specialtyId: cardiology.id, visitSequence: 'FIRST_TIME' });
  });

  it('BI-232 una consulta de cardiología que la clínica ya nombró no se pisa', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);
    const cardiology = await prisma.specialty.findFirstOrThrow({
      where: { code: 'cardiologia' },
    });
    // The clinic moves the correspondence to a service of its own.
    const seeded = await prisma.billableService.findUniqueOrThrow({
      where: { code: 'CONS-CAR-PV' },
    });
    await prisma.billableService.update({
      where: { id: seeded.id },
      data: { specialtyId: null, visitSequence: null },
    });
    const own = await prisma.billableService.create({
      data: {
        code: 'MI-CARDIO-1',
        name: 'Valoración cardiológica',
        categoryId: seeded.categoryId,
        taxRateId: seeded.taxRateId,
        specialtyId: cardiology.id,
        visitSequence: 'FIRST_TIME',
      },
    });

    await seedBilling(prisma);

    expect(
      (
        await prisma.billableService.findUniqueOrThrow({
          where: { code: 'CONS-CAR-PV' },
        })
      ).specialtyId,
    ).toBeNull();
    expect(
      (
        await prisma.billableService.findUniqueOrThrow({
          where: { id: own.id },
        })
      ).specialtyId,
    ).toBe(cardiology.id);
  });
});
