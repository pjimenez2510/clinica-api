import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { PrismaBillingCatalogueRepository } from '../../src/modules/billing/infrastructure/prisma-billing-catalogue.repository';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

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
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const rates = await seededRates();
    expect(rates.get('0')).toEqual(['0.00', true]);
    expect(rates.get('4')).toEqual(['15.00', true]);
    // Not 0 %: no percentage applies at all.
    expect(rates.get('6')).toEqual([null, true]);
    expect(rates.get('7')).toEqual([null, true]);
  });

  it('BI-021 el 12 % y el 14 % se siembran para leer facturas viejas, con su vigencia cerrada', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    const rates = await seededRates();
    expect(rates.get('2')).toEqual(['12.00', false]);
    expect(rates.get('3')).toEqual(['14.00', false]);
  });

  it('BI-021 sembrar otra vez no duplica ninguna tarifa', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);
    const once = await prisma.taxRate.count();

    await seedSpecialties(prisma);
    await seedBilling(prisma);

    expect(await prisma.taxRate.count()).toBe(once);
  });
});

describe('BI-026 una tarifa que una prestación usa no se borra', () => {
  it('BI-026 la base rechaza borrar la tarifa de una prestación, y borra una que nadie usa (control)', async () => {
    await seedSpecialties(prisma);
    await seedBilling(prisma);
    const used = await prisma.service.findFirstOrThrow({
      select: { taxRateId: true },
    });

    await expect(
      prisma.$executeRaw`DELETE FROM tax_rate WHERE id = ${used.taxRateId}::uuid`,
    ).rejects.toThrowError(/service_tax_rate_fk/);

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

describe('BI-024 la revisión firma la tarifa que se vio, y la base lo cumple', () => {
  async function aService() {
    await seedSpecialties(prisma);
    await seedBilling(prisma);
    const service = await prisma.service.findUniqueOrThrow({
      where: { code: 'CONS-MG-PV' },
    });
    const other = await prisma.taxRate.findFirstOrThrow({
      where: { validTo: null, NOT: { id: service.taxRateId } },
    });
    const reviewer = await createUser(prisma);
    const repository = new PrismaBillingCatalogueRepository(
      prisma as unknown as PrismaService,
    );
    return { service, other, reviewer, repository };
  }

  it('BI-024 marcar revisada con una tarifa que ya no es la de la fila no escribe nada; con la suya, sí (control)', async () => {
    const { service, other, reviewer, repository } = await aService();
    const review = { reviewedAt: new Date(), reviewedById: reviewer.id };

    // Straight to the conditional write, past the service's own check.
    expect(
      await repository.markTaxReviewed(service.id, other.id, review),
    ).toBeNull();
    expect(
      (
        await prisma.service.findUniqueOrThrow({
          where: { id: service.id },
        })
      ).taxReviewedAt,
    ).toBeNull();

    const marked = await repository.markTaxReviewed(
      service.id,
      service.taxRateId,
      review,
    );
    expect(marked?.taxReview?.reviewedById).toBe(reviewer.id);
  });

  it('BI-024 una tarifa nueva borra la revisión por lo que dice la fila, aunque quien guarda no la viera; la misma tarifa, no (control)', async () => {
    const { service, other, reviewer, repository } = await aService();
    await repository.markTaxReviewed(service.id, service.taxRateId, {
      reviewedAt: new Date(),
      reviewedById: reviewer.id,
    });

    // The same rate saved again keeps the review.
    const same = await repository.updateService(service.id, {
      taxRateId: service.taxRateId,
    });
    expect(same.taxReview?.reviewedById).toBe(reviewer.id);

    // A caller that read the service BEFORE the review and so asks for no
    // clearing still cannot carry the review onto the new rate.
    const moved = await repository.updateService(service.id, {
      taxRateId: other.id,
    });
    expect(moved.taxReview).toBeNull();
    const row = await prisma.service.findUniqueOrThrow({
      where: { id: service.id },
    });
    expect([row.taxRateId, row.taxReviewedAt, row.taxReviewedById]).toEqual([
      other.id,
      null,
      null,
    ]);
  });
});
