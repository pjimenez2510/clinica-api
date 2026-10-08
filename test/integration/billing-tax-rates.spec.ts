import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';

import { useDatabase } from './setup/database';

/**
 * BI-021, BI-026. The SRI's rates as a clinic installs them, and what keeps
 * one in use from disappearing. Against the real seed and the real foreign
 * key: a fixture would only prove what it was told.
 */
const db = useDatabase();

let prisma: PrismaClient;

beforeEach(() => {
  prisma = db();
});

/** The seeded rates as `code → [percentage, still in force]`. */
async function seededRates(): Promise<Map<string, [string | null, boolean]>> {
  const rows = await prisma.taxRate.findMany();
  return new Map(
    rows.map((row) => [
      row.sriCode,
      [row.percentage?.toFixed(2) ?? null, row.validTo === null],
    ]),
  );
}

describe('BI-021 las tarifas del SRI vienen sembradas', () => {
  it('BI-021 trae vigentes el 0 %, el 15 %, «no objeto» y «exento», y los dos últimos sin porcentaje', async () => {
    await seedBilling(prisma);

    const rates = await seededRates();
    expect(rates.get('0')).toEqual(['0.00', true]);
    expect(rates.get('4')).toEqual(['15.00', true]);
    // Not 0 %: no percentage applies at all.
    expect(rates.get('6')).toEqual([null, true]);
    expect(rates.get('7')).toEqual([null, true]);
  });

  it('BI-021 el 12 % y el 14 % se siembran para leer facturas viejas, con su vigencia cerrada', async () => {
    await seedBilling(prisma);

    const rates = await seededRates();
    expect(rates.get('2')).toEqual(['12.00', false]);
    expect(rates.get('3')).toEqual(['14.00', false]);
  });

  it('BI-021 sembrar otra vez no duplica ninguna tarifa', async () => {
    await seedBilling(prisma);
    const once = await prisma.taxRate.count();

    await seedBilling(prisma);

    expect(await prisma.taxRate.count()).toBe(once);
  });
});

describe('BI-026 una tarifa que una prestación usa no se borra', () => {
  it('BI-026 la base rechaza borrar la tarifa de una prestación, y borra una que nadie usa (control)', async () => {
    await seedBilling(prisma);
    const used = await prisma.billableService.findFirstOrThrow({
      select: { taxRateId: true },
    });

    await expect(
      prisma.$executeRaw`DELETE FROM tax_rate WHERE id = ${used.taxRateId}::uuid`,
    ).rejects.toThrowError(/billable_service_tax_rate_fk/);

    // A code no service names, opened today: nothing holds it.
    const unused = await prisma.taxRate.create({
      data: {
        sriCode: '8',
        name: 'IVA diferenciado',
        percentage: '8.00',
        validFrom: new Date(`${clinicalDateOf(new Date())}T00:00:00Z`),
      },
    });
    await expect(
      prisma.$executeRaw`DELETE FROM tax_rate WHERE id = ${unused.id}::uuid`,
    ).resolves.toBe(1);
  });
});
