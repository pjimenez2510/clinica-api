import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';

import { useDatabase } from './setup/database';

/**
 * BI-232 (D-161), BI-279 (ADR-013). The starting catalogue brings, for EVERY
 * specialty, its two consultations —«Primera vez» at 30 minutes and «Control»
 * at 20— as services named «Consulta de <especialidad> · Primera vez /
 * Control», ONE per specialty and visit, each with its self-pay price (D-228:
 * the price is required on creation, so the seed gives one too). Against the real seeds, not a fixture: what is checked is
 * what a clinic installs.
 */
const db = useDatabase();

let prisma: PrismaClient;

beforeEach(() => {
  prisma = db();
});

/** Every seeded consultation with its specialty and its price count. */
async function consultations() {
  return prisma.service.findMany({
    where: { kind: 'CONSULTATION' },
    select: {
      code: true,
      name: true,
      durationMinutes: true,
      visitKind: true,
      specialty: { select: { code: true } },
      _count: { select: { prices: true } },
    },
  });
}

describe('BI-232 BI-279 las consultas del catálogo de arranque', () => {
  it('BI-279 una consulta por especialidad y visita, nombrada «Consulta de X · Primera vez / Control», sin duplicados', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const seeded = await consultations();
    // 22 specialties × first visit and follow-up (SP-001).
    expect(seeded).toHaveLength(44);
    const keys = seeded.map((row) => `${row.specialty!.code}·${row.visitKind}`);
    expect(new Set(keys).size).toBe(seeded.length);
    for (const row of seeded) {
      expect(row.name, row.code).toMatch(
        /^Consulta de .+ · (Primera vez|Control)$/,
      );
      expect(row.durationMinutes).toBe(
        row.visitKind === 'FIRST_VISIT' ? 30 : 20,
      );
      // BI-171: the SRI's 25 characters.
      expect(row.code.length).toBeLessThanOrEqual(25);
    }
    expect(seeded.find((row) => row.code === 'CONS-MG-PV')?.name).toBe(
      'Consulta de medicina general · Primera vez',
    );
  });

  it('BI-232 toda consulta sembrada nace con precio particular, y ninguna en la lista del IESS (control)', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const pricesIn = async (payerCode: string) =>
      prisma.price.findMany({
        where: {
          priceList: { payer: { code: payerCode } },
          service: { kind: 'CONSULTATION' },
        },
        select: { amount: true, service: { select: { code: true } } },
      });
    const selfPay = await pricesIn('PARTICULAR');
    const seeded = await consultations();

    expect(selfPay.map((row) => row.service.code).sort()).toEqual(
      seeded.map((row) => row.code).sort(),
    );
    for (const row of selfPay) {
      expect(Number(row.amount), row.service.code).toBeGreaterThan(0);
    }
    expect(await pricesIn('IESS')).toEqual([]);
  });

  it('BI-279 sembrar facturación antes que especialidades no crea consultas sin especialidad, y la siguiente corrida sí', async () => {
    await seedBilling(prisma);
    expect(await prisma.service.count({ where: { kind: 'CONSULTATION' } })).toBe(0); // prettier-ignore

    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const cardiology = await prisma.service.findUniqueOrThrow({
      where: { code: 'CONS-CAR-PV' },
      select: { visitKind: true, specialty: { select: { code: true } } },
    });
    expect(cardiology).toEqual({
      visitKind: 'FIRST_VISIT',
      specialty: { code: 'cardiologia' },
    });
  });

  it('BI-232 una consulta que la clínica renombró no se pisa; una con el nombre viejo de la semilla se pone al día', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);
    await prisma.service.update({
      where: { code: 'CONS-CAR-PV' },
      data: { name: 'Valoración cardiológica' },
    });
    await prisma.service.update({
      where: { code: 'CONS-CAR-SUB' },
      data: { name: 'Consulta de cardiología, subsecuente' },
    });

    await seedBilling(prisma);

    const names = await prisma.service.findMany({
      where: { code: { in: ['CONS-CAR-PV', 'CONS-CAR-SUB'] } },
      orderBy: { code: 'asc' },
      select: { name: true },
    });
    expect(names.map((row) => row.name)).toEqual([
      'Valoración cardiológica',
      'Consulta de cardiología · Control',
    ]);
  });
});
