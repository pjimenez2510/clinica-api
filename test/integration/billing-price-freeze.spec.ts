import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, inject, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaBillingCatalogueRepository } from '../../src/modules/billing/infrastructure/prisma-billing-catalogue.repository';
import { PriceNotFoundError } from '../../src/modules/billing/domain/billing.errors';
import { planPriceChange } from '../../src/modules/billing/domain/price-list';
import { Money, Quantity } from '../../src/modules/billing/domain/money';
import { parseClinicalDate } from '../../src/shared/domain/clinic-time';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * B1'S INDEPENDENT TEST, AND IT IS EXACTLY THIS ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Raise a charge with the tariff in force, close that validity and open
 * another at a different price, and check that YESTERDAY'S CHARGE DID NOT MOVE
 * A SINGLE CENT — and that a new charge with the same SERVICE DATE still comes
 * out at the old price.
 *
 * It runs against a real PostgreSQL because the non-overlap of validities is
 * guaranteed by the database, and because the way this rule breaks is a JOIN
 * that gives the same answer today: a repository double would return whatever
 * it was told and prove nothing at all. The prices are changed UNDERNEATH the
 * application, which is the only way to show that nothing re-reads them.
 *
 * The seed is the real one (`prisma/seed-billing.mts`): eight SRI rates, seven
 * payers, seven price lists and thirty-five services with their price. Making
 * up data here would test a fixture instead of the system the clinic installs.
 */
const db = useDatabase();

/** `CONS-MG-PV` costs 30.00 in the PARTICULAR list from 2026-01-01. */
const SERVICE_CODE = 'CONS-MG-PV';
const SELF_PAY = 'PARTICULAR';
const BEFORE_THE_RISE = parseClinicalDate('2026-05-11');
const THE_RISE = parseClinicalDate('2026-07-01');
const AFTER_THE_RISE = parseClinicalDate('2026-07-15');

interface Context {
  prisma: PrismaClient;
  catalogue: PrismaBillingCatalogueRepository;
  accounts: PrismaBillingAccountRepository;
  accountId: string;
  serviceId: string;
  priceListId: string;
  /**
   * The list of a payer the seed leaves WITHOUT prices (IESS): the seed only
   * prices the PARTICULAR list, and everything else starts empty.
   *
   * It is what the constraint tests below write into. The seeded PARTICULAR
   * price is open-ended from 2026-01-01, so ANY period added to it overlaps —
   * which is the guarantee working, and would make «admite el cero» fail for
   * the wrong reason.
   */
  emptyPriceListId: string;
  userId: string;
}

let context: Context;

beforeEach(async () => {
  const prisma = db();
  await seedSpecialties(prisma);
  await seedBilling(prisma);

  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const user = await prisma.user.create({
    data: {
      email: `caja${Date.now()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Rosa',
      lastName: 'Cedeño',
    },
  });

  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: SELF_PAY },
  });
  const priceList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: payer.id },
  });
  const service = await prisma.service.findUniqueOrThrow({
    where: { code: SERVICE_CODE },
  });
  const institutional = await prisma.payer.findUniqueOrThrow({
    where: { code: 'IESS' },
  });
  const emptyList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: institutional.id },
  });

  const account = await prisma.patientAccount.create({
    data: {
      patientId: patient.id,
      siteId: site.id,
      payerId: payer.id,
      priceListId: priceList.id,
    },
  });

  // The adapters take `PrismaService`, which IS a `PrismaClient`: the harness
  // hands over the one bound to the throwaway container.
  const asService = prisma as unknown as PrismaService;

  context = {
    prisma,
    catalogue: new PrismaBillingCatalogueRepository(asService),
    accounts: new PrismaBillingAccountRepository(asService),
    accountId: account.id,
    serviceId: service.id,
    priceListId: priceList.id,
    emptyPriceListId: emptyList.id,
    userId: user.id,
  };
});

async function charge(serviceDate = BEFORE_THE_RISE) {
  return context.accounts.addCharge({
    accountId: context.accountId,
    serviceId: context.serviceId,
    encounterId: null,
    serviceDate,
    quantity: Quantity.ONE,
    createdById: context.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
}

/** Raises the tariff to 35.00 from 1 July, the way BI-044 says it is done. */
async function raiseTheTariff(): Promise<void> {
  const existing = await context.catalogue.listPricesOfService(
    context.priceListId,
    context.serviceId,
  );

  await context.catalogue.applyPriceChange(
    context.priceListId,
    context.serviceId,
    planPriceChange(existing[0] ?? null, Money.parse('35.00'), THE_RISE),
  );
}

describe('BI-297 un convenio guarda sólo sus excepciones sobre el particular', () => {
  /** The seed's payer of that code, and its price list (no prices of its own). */
  async function listOf(code: string) {
    const payer = await context.prisma.payer.findUniqueOrThrow({
      where: { code },
    });
    return context.prisma.priceList.findFirstOrThrow({
      where: { payerId: payer.id },
    });
  }

  async function agreementAccount(
    code = 'CONVENIO-EMPRESA-EJEMPLO',
  ): Promise<string> {
    const list = await listOf(code);
    const own = await context.prisma.patientAccount.findUniqueOrThrow({
      where: { id: context.accountId },
    });
    const account = await context.prisma.patientAccount.create({
      data: {
        patientId: own.patientId,
        siteId: own.siteId,
        payerId: list.payerId,
        priceListId: list.id,
      },
    });
    return account.id;
  }

  const chargeTo = (accountId: string) =>
    context.accounts.addCharge({
      accountId,
      serviceId: context.serviceId,
      encounterId: null,
      serviceDate: BEFORE_THE_RISE,
      quantity: Quantity.ONE,
      createdById: context.userId,
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      status: 'BILLABLE',
    });

  it('BI-297 sin precio propio en el convenio, el cargo toma el particular y guarda de qué fila salió', async () => {
    const accountId = await agreementAccount();
    const selfPay = await context.prisma.price.findFirstOrThrow({
      where: { priceListId: context.priceListId, serviceId: context.serviceId },
      orderBy: { validFrom: 'asc' },
    });

    const charged = await chargeTo(accountId);

    const stored = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: charged.id },
    });
    expect(stored.unitAmount.toFixed(2)).toBe(selfPay.amount.toFixed(2));
    expect(stored.resolvedPriceId).toBe(selfPay.id);
  });

  it('BI-297 con precio propio en el convenio, el cargo toma el suyo (control)', async () => {
    const accountId = await agreementAccount();
    const agreement = await listOf('CONVENIO-EMPRESA-EJEMPLO');
    const own = await context.prisma.price.create({
      data: {
        priceListId: agreement.id,
        serviceId: context.serviceId,
        amount: '12.00',
        validFrom: new Date(`${BEFORE_THE_RISE}T00:00:00Z`),
      },
    });

    const charged = await chargeTo(accountId);

    const stored = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: charged.id },
    });
    expect(stored.unitAmount.toFixed(2)).toBe('12.00');
    expect(stored.resolvedPriceId).toBe(own.id);
  });

  it('BI-297 un seguro privado sin precio propio también toma el particular', async () => {
    const charged = await chargeTo(await agreementAccount('SEGURO-PRIVADO-EJEMPLO')); // prettier-ignore

    const stored = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: charged.id },
    });
    expect(stored.resolvedPriceId).not.toBeNull();
  });

  it('BI-297 la red pública NO toma el particular: sin precio propio se rechaza con PRICE_NOT_FOUND', async () => {
    // The public network settles by the SNS tariff: a self-pay amount on its
    // claim would be a figure it never agreed to (D-230).
    await expect(
      chargeTo(await agreementAccount('IESS')),
    ).rejects.toBeInstanceOf(PriceNotFoundError);
  });
});

describe('BI-050 el cargo congela el precio resuelto por la fecha del servicio', () => {
  it('BI-050 copia importe, nombre, código y porcentaje de impuesto, y la fila de precio', async () => {
    const raised = await charge();

    // Read back from the DATABASE, not from the return value: what matters is
    // that the columns hold copies and not nulls.
    const stored = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: raised.id },
    });

    expect(stored.unitAmount.toFixed(2)).toBe('30.00');
    expect(stored.serviceDisplay).toBe(
      'Consulta de medicina general · Primera vez',
    );
    expect(stored.taxSriCode).toBe('0');
    expect(stored.taxPercentage?.toFixed(2)).toBe('0.00');
    // BI-050: the price row travels too, so the resolution is auditable years
    // later — the amounts are what is charged, this is HOW IT IS EXPLAINED.
    expect(stored.resolvedPriceId).not.toBeNull();
  });

  it('BI-051, BI-053 no mueve ni un centavo del cargo de ayer al subir la tarifa mañana', async () => {
    const yesterday = await charge();
    await raiseTheTariff();

    const afterTheRise = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: yesterday.id },
    });

    // THE ASSERTION THIS WHOLE MODULE EXISTS FOR. Without the freeze, raising
    // a tariff tomorrow rewrites every past invoice.
    expect(afterTheRise.unitAmount.toFixed(2)).toBe('30.00');
  });

  it('BI-052 cobra al precio VIEJO un cargo nuevo con fecha de servicio anterior a la subida', async () => {
    await raiseTheTariff();

    // A visit from May invoiced in July: charged at what applied in May.
    const late = await charge(BEFORE_THE_RISE);
    expect(late.unitAmount.toString()).toBe('30.00');
  });

  it('BI-052 cobra al precio NUEVO un cargo cuya fecha de servicio ya está en la vigencia nueva', async () => {
    await raiseTheTariff();

    const now = await charge(AFTER_THE_RISE);
    expect(now.unitAmount.toString()).toBe('35.00');
  });

  it('BI-041 resuelve el día exacto del cambio con el precio NUEVO, porque la vigencia es `[desde, hasta)`', async () => {
    await raiseTheTariff();

    const onTheDay = await charge(THE_RISE);
    // With a closed interval that day would belong to both rows and the query
    // would return two: the ambiguity that makes «¿cuánto costaba?»
    // unanswerable.
    expect(onTheDay.unitAmount.toString()).toBe('35.00');
  });

  it('BI-074 deriva el total de la cuenta de los cargos y no de una columna', async () => {
    await charge();
    await charge();
    await raiseTheTariff();

    const charges = await context.accounts.listCharges(context.accountId);
    const total = Money.sum(charges.map((item) => item.unitAmount));

    expect(total.toString()).toBe('60.00');
    // And there is no total column to disagree with it.
    const columns = await context.prisma.$queryRaw<{ column_name: string }[]>`
      SELECT "column_name" FROM "information_schema"."columns"
       WHERE "table_name" = 'patient_account'`;
    expect(columns.map((c) => c.column_name)).not.toContain('total');
  });

  it('BI-047 rechaza el cargo cuando no hay precio vigente para esa fecha, nombrando los tres datos', async () => {
    // Before the seeded validity starts: no price, and the error has to let
    // whoever is at the cashier tell «falta el precio» from «la fecha se
    // tecleó mal».
    const rejection = await charge(parseClinicalDate('2025-06-01')).catch(
      (error: unknown) => error,
    );

    expect((rejection as { code: string }).code).toBe('PRICE_NOT_FOUND');
    expect((rejection as { params: Record<string, string> }).params).toEqual(
      expect.objectContaining({ serviceDate: '2025-06-01' }),
    );
  });
});

describe('BI-230 corregir un precio no mueve los cargos ya registrados', () => {
  it('BI-230 el cargo conserva el importe anterior, y se cuentan los que aún no se facturan', async () => {
    const raised = await charge();
    const price = (
      await context.catalogue.listPricesOfService(
        context.priceListId,
        context.serviceId,
      )
    )[0]!;
    // Control: before the correction, the charge is counted at the old amount.
    expect(
      await context.catalogue.countOpenChargesAt(price.id, price.amount),
    ).toBe(1);

    await context.catalogue.correctPriceAmount(price.id, Money.parse('31.50'), {
      by: context.userId,
      at: new Date(),
    });

    const kept = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: raised.id },
    });
    expect(Money.parse(kept.unitAmount.toString())).toEqual(price.amount);
    expect(
      await context.catalogue.countOpenChargesAt(price.id, price.amount),
    ).toBe(1);
    expect(
      await context.catalogue.countOpenChargesAt(
        price.id,
        Money.parse('31.50'),
      ),
    ).toBe(0);
  });
});

describe('BI-006, BI-042 lo que garantiza la base y no el código', () => {
  it('BI-006 no guarda ningún importe en la fila de la prestación', async () => {
    // Written as a requirement and not as a convention because the temptation
    // does not appear while designing: it appears when somebody needs «el
    // precio» on a screen and a column looks cheaper than a query.
    const columns = await context.prisma.$queryRaw<
      { column_name: string; data_type: string }[]
    >`
      SELECT "column_name", "data_type" FROM "information_schema"."columns"
       WHERE "table_name" = 'service'`;

    expect(columns.filter((c) => c.data_type === 'numeric')).toEqual([]);
  });

  it('BI-042 rechaza dos precios solapados de la misma prestación en la misma lista', async () => {
    const rejection = await context.prisma.price
      .create({
        data: {
          priceListId: context.priceListId,
          serviceId: context.serviceId,
          amount: '99.00',
          validFrom: new Date('2026-03-01T00:00:00Z'),
          validTo: null,
        },
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(rejection).not.toBeNull();

    // What the person editing the tariff is told: a conflict they can act on,
    // never a server failure.
    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(409);
    expect(problem?.code).toBe('PRICE_PERIOD_OVERLAP');
  });

  it('BI-042 deja pasar exactamente uno cuando dos administradores fijan el mismo precio a la vez', async () => {
    // TWO REAL CLIENTS, because the window this closes is the one between a
    // SELECT and an INSERT: a check in TypeScript does not see the other
    // administrator. The assertion names WHO WINS — one, not «at least one
    // fails».
    const url = inject('databaseUrl');
    const clients = [
      new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
      new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    ];

    try {
      const results = await Promise.allSettled(
        clients.map((client) =>
          client.price.create({
            data: {
              priceListId: context.emptyPriceListId,
              serviceId: context.serviceId,
              amount: '40.00',
              validFrom: new Date('2027-01-01T00:00:00Z'),
              validTo: null,
            },
          }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('BI-041 rechaza una vigencia vacía con un mensaje que nombra el campo', async () => {
    const rejection = await context.prisma.price
      .create({
        data: {
          priceListId: context.emptyPriceListId,
          serviceId: context.serviceId,
          amount: '40.00',
          validFrom: new Date('2028-01-01T00:00:00Z'),
          validTo: new Date('2028-01-01T00:00:00Z'),
        },
      })
      .then(() => null)
      .catch((error: unknown) => error);

    const problem = extractDatabaseProblem(rejection);
    expect(problem?.code).toBe('PRICE_PERIOD_EMPTY');
    expect(problem?.errors?.[0]?.field).toBe('validTo');
  });

  it('BI-043 rechaza un precio negativo y admite el cero', async () => {
    // Zero is a real price: the included follow-up, the service an agreement
    // covers in full.
    await expect(
      context.prisma.price.create({
        data: {
          priceListId: context.emptyPriceListId,
          serviceId: context.serviceId,
          amount: '0.00',
          validFrom: new Date('2029-01-01T00:00:00Z'),
        },
      }),
    ).resolves.toBeDefined();

    const rejection = await context.prisma.price
      .create({
        data: {
          priceListId: context.emptyPriceListId,
          serviceId: context.serviceId,
          amount: '-1.00',
          validFrom: new Date('2030-01-01T00:00:00Z'),
        },
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'PRICE_AMOUNT_NEGATIVE',
    );
  });

  it('BI-012 se niega a borrar una prestación que un cargo ya nombra', async () => {
    // The `RESTRICT` is the guarantee, not the service: the service an
    // eight-month-old invoice names has to keep existing.
    await charge();

    const rejection = await context.prisma.service
      .delete({ where: { id: context.serviceId } })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(rejection).not.toBeNull();
  });

  it('BI-065 la base rechaza un descuento mayor que el importe de la línea', async () => {
    const raised = await charge();

    const rejection = await context.prisma.chargeItem
      .update({
        where: { id: raised.id },
        // Stamped: since BI-197 a discount is a correction the database
        // versions, so without a stamp the refusal would be another one.
        data: {
          discountAmount: '30.01',
          discountReason: 'Convenio',
          discountAppliedById: context.userId,
          discountAppliedAt: new Date(),
          changedById: context.userId,
          changedAt: new Date(),
        },
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'DISCOUNT_EXCEEDS_LINE_AMOUNT',
    );
  });

  it('BI-057 la base rechaza una cantidad de cero', async () => {
    const rejection = await context.prisma.chargeItem
      .create({
        data: {
          accountId: context.accountId,
          serviceId: context.serviceId,
          serviceDate: new Date('2026-05-11T00:00:00Z'),
          quantity: '0',
          unitAmount: '30.00',
          serviceDisplay: 'Consulta',
          taxSriCode: '0',
          taxPercentage: '0.00',
          createdById: context.userId,
        },
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'INVALID_CHARGE_QUANTITY',
    );
  });
});

describe('BI-002 la fecha que decide un importe se resuelve en Ecuador', () => {
  it('BI-002 guarda la fecha del servicio como el día del calendario y no como un instante', async () => {
    const raised = await charge();

    const stored = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: raised.id },
    });

    // A `::date` over a `timestamptz` at 21:00 falls on the next day, and here
    // that does not shift a metric: it changes WHICH PRICE APPLIES if the
    // validity started that midnight.
    expect(stored.serviceDate.toISOString().slice(0, 10)).toBe('2026-05-11');
    expect(raised.serviceDate).toBe('2026-05-11');
  });
});

describe('PA-055 la cuenta sigue el enlace de una fusión de fichas', () => {
  it('BI-070 lista la cuenta de la ficha ABSORBIDA al preguntar por la superviviente', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // EL DEFECTO QUE NADIE REPORTA: UNA DEUDA QUE DEJA DE EXISTIR
    // ═══════════════════════════════════════════════════════════════════════
    //
    // A merge re-points nothing (D-031): the absorbed chart keeps its rows and
    // the survivor reads them by following the link. An account read by a bare
    // `patient_id` would stop appearing the moment the charts merged — the
    // visit would be visible and its unpaid balance would not, so it would
    // never be collected and nobody would know it existed. Same shape as
    // PA-009.
    const absorbed = await context.prisma.patient.findUniqueOrThrow({
      where: { id: (await context.prisma.patientAccount.findUniqueOrThrow({ where: { id: context.accountId } })).patientId }, // prettier-ignore
    });
    const survivor = await createPatient(context.prisma);

    await context.prisma.patient.update({
      where: { id: absorbed.id },
      // `patient_merged_at_matches_link` demands the two travel together: a
      // chart that says it was absorbed has to say when.
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });

    const accounts = await context.accounts.listAccounts({
      siteId: (
        await context.prisma.patientAccount.findUniqueOrThrow({
          where: { id: context.accountId },
        })
      ).siteId,
      patientId: survivor.id,
    });

    expect(accounts.map((account) => account.id)).toContain(context.accountId);
  });

  it('BI-070 abre una cuenta nueva sobre la ficha SUPERVIVIENTE, no sobre la absorbida', async () => {
    // A read that follows the link is only half the answer: an account opened
    // AFTER the merge on the dead chart would be born invisible to everything
    // that asks by the living one.
    const absorbed = await createPatient(context.prisma);
    const survivor = await createPatient(context.prisma);
    await context.prisma.patient.update({
      where: { id: absorbed.id },
      // `patient_merged_at_matches_link` demands the two travel together: a
      // chart that says it was absorbed has to say when.
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });

    const existing = await context.prisma.patientAccount.findUniqueOrThrow({
      where: { id: context.accountId },
    });

    const opened = await context.accounts.openAccount({
      siteId: existing.siteId,
      patientId: absorbed.id,
      encounterId: null,
      payerId: existing.payerId,
      priceListId: existing.priceListId,
    });

    expect(opened.patientId).toBe(survivor.id);
  });
});
