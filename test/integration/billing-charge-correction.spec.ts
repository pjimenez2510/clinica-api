import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import '../../src/shared/http/record-version.constraints';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { asDateColumn } from '../../src/modules/billing/infrastructure/prisma-billing-catalogue.repository';
import { Money, Quantity } from '../../src/modules/billing/domain/money';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * B12: UN CARGO SIN FACTURAR SE CORRIGE EN EL SITIO, Y LA BASE GUARDA LA HISTORIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-126 and D-127 in caja. What only a real PostgreSQL can show:
 *
 *   · that a correction WITHOUT a stamp is refused, and one with it archives
 *     the previous row in `record_version` (`trg_charge_item_record_version`);
 *   · that confirming and invoicing still need no stamp (the trigger's WHEN);
 *   · that a billed charge's content does not move, by SQL or by repository
 *     (`trg_charge_item_billed_is_frozen`);
 *   · that the reasons of removing and of discounting are now optional;
 *   · and that repricing on a payer change is one transaction: a missing
 *     price leaves every line and the payer as they were.
 *
 * Dates are derived from the clock, never written: the seeded PARTICULAR
 * prices are open-ended from 2026-01-01.
 */
const db = useDatabase();

/** `CONS-MG-PV` costs 30.00 and `CONS-DER-PV` 50.00 in PARTICULAR. */
const GENERAL = 'CONS-MG-PV';
const DERMATOLOGY = 'CONS-DER-PV';

interface Context {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  accountId: string;
  siteId: string;
  generalId: string;
  dermatologyId: string;
  insurerId: string;
  insurerListId: string;
  userId: string;
}

let context: Context;
const today = () => clinicalDateOf(new Date());

beforeEach(async () => {
  const prisma = db();
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

  const selfPay = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const selfPayList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: selfPay.id },
  });
  const insurer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'IESS' },
  });
  const insurerList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: insurer.id },
  });
  const general = await prisma.billableService.findUniqueOrThrow({
    where: { code: GENERAL },
  });
  const dermatology = await prisma.billableService.findUniqueOrThrow({
    where: { code: DERMATOLOGY },
  });

  const account = await prisma.patientAccount.create({
    data: {
      patientId: patient.id,
      siteId: site.id,
      payerId: selfPay.id,
      priceListId: selfPayList.id,
    },
  });

  context = {
    prisma,
    accounts: new PrismaBillingAccountRepository(
      prisma as unknown as PrismaService,
    ),
    accountId: account.id,
    siteId: site.id,
    generalId: general.id,
    dermatologyId: dermatology.id,
    insurerId: insurer.id,
    insurerListId: insurerList.id,
    userId: user.id,
  };
});

async function charge(status: 'PLANNED' | 'BILLABLE' = 'BILLABLE') {
  return context.accounts.addCharge({
    accountId: context.accountId,
    billableServiceId: context.generalId,
    encounterId: null,
    serviceDate: today(),
    quantity: Quantity.ONE,
    createdById: context.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null).catch((error: unknown) => error);
}

async function versionsOf(chargeId: string) {
  return context.prisma.recordVersion.findMany({
    where: { resourceType: 'charge_item', resourceId: chargeId },
    orderBy: { version: 'asc' },
  });
}

/** Prices the IESS list, empty in the seed, from the start of the year. */
async function priceForInsurer(serviceId: string, amount: string) {
  await context.prisma.price.create({
    data: {
      priceListId: context.insurerListId,
      billableServiceId: serviceId,
      amount,
      validFrom: asDateColumn(addDays(today(), -400)),
    },
  });
}

describe('BI-195, BI-197 la base exige el sello de quien corrige y guarda la versión', () => {
  it('BI-197 rechaza cambiar la cantidad sin sello, y con sello la acepta y archiva la anterior', async () => {
    const raised = await charge();

    const unstamped = await rejectionOf(
      context.prisma.chargeItem.update({
        where: { id: raised.id },
        data: { quantity: '2' },
      }),
    );
    expect(extractDatabaseProblem(unstamped)?.code).toBe('EDIT_NOT_STAMPED');

    // Positive control: the same change, stamped, goes through.
    await context.prisma.chargeItem.update({
      where: { id: raised.id },
      data: {
        quantity: '2',
        changedById: context.userId,
        changedAt: new Date(),
      },
    });
    const [previous] = await versionsOf(raised.id);
    expect(previous?.version).toBe(1);
    expect((previous?.data as { quantity: number }).quantity).toBe(1);
  });

  it('BI-152 confirmar una propuesta no necesita sello ni deja versión', async () => {
    const proposed = await charge('PLANNED');

    await context.accounts.confirmCharge(proposed.id);

    expect(await versionsOf(proposed.id)).toHaveLength(0);
  });

  it('BI-195 quitar sin sello se rechaza aunque diga quién y cuándo anuló', async () => {
    const raised = await charge();

    const rejection = await rejectionOf(
      context.prisma.chargeItem.update({
        where: { id: raised.id },
        data: {
          status: 'CANCELLED',
          voidedAt: new Date(),
          voidedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe('EDIT_NOT_STAMPED');
  });
});

describe('BI-195, BI-196 quitar y «No se cobra» sin motivo, y deshacer', () => {
  it('BI-195 quita un cargo sin motivo y guarda la versión anterior', async () => {
    const raised = await charge();

    const voided = await context.accounts.voidCharge({
      chargeId: raised.id,
      voidedById: context.userId,
      reason: null,
      now: new Date(),
    });

    expect(voided.status).toBe('CANCELLED');
    expect(voided.voidReason).toBeNull();
    const [previous] = await versionsOf(raised.id);
    expect((previous?.data as { status: string }).status).toBe('BILLABLE');
  });

  it('BI-195 deshacer devuelve la propuesta a propuesta, sin confirmarla', async () => {
    const proposed = await charge('PLANNED');
    await context.accounts.voidCharge({
      chargeId: proposed.id,
      voidedById: context.userId,
      reason: 'Cortesía',
      now: new Date(),
    });

    const restored = await context.accounts.restoreCharge({
      chargeId: proposed.id,
      changedById: context.userId,
      now: new Date(),
    });

    expect(restored.status).toBe('PLANNED');
    expect(restored.voidedAt).toBeNull();
    expect(restored.voidReason).toBeNull();
    // The reason given is not lost: it is in the version that was removed.
    const versions = await versionsOf(proposed.id);
    expect(
      versions.map(
        (v) => (v.data as { void_reason: string | null }).void_reason,
      ),
    ).toContain('Cortesía');
  });

  it('BI-195 deshacer re-tarifa con el pagador que la cuenta tiene ahora', async () => {
    const raised = await charge();
    await context.accounts.voidCharge({
      chargeId: raised.id,
      voidedById: context.userId,
      reason: null,
      now: new Date(),
    });
    await priceForInsurer(context.generalId, '22.00');
    await context.accounts.changeAccountPayer({
      accountId: context.accountId,
      payerId: context.insurerId,
      priceListId: context.insurerListId,
      changedById: context.userId,
      now: new Date(),
    });

    const restored = await context.accounts.restoreCharge({
      chargeId: raised.id,
      changedById: context.userId,
      now: new Date(),
    });

    expect(restored.unitAmount.toString()).toBe('22.00');
  });

  it('BI-196 marca «No se cobra» y deshacer lo devuelve a confirmado', async () => {
    const raised = await charge();

    const marked = await context.accounts.markNotBillable({
      chargeId: raised.id,
      changedById: context.userId,
      now: new Date(),
    });
    expect(marked.status).toBe('NOT_BILLABLE');

    const restored = await context.accounts.restoreCharge({
      chargeId: raised.id,
      changedById: context.userId,
      now: new Date(),
    });
    expect(restored.status).toBe('BILLABLE');
    expect(await versionsOf(raised.id)).toHaveLength(2);
  });
});

describe('BI-197 editar el cargo en el sitio', () => {
  it('BI-197 cambiar la prestación re-resuelve precio y nombre, y la propuesta sigue propuesta', async () => {
    const proposed = await charge('PLANNED');

    const edited = await context.accounts.editCharge({
      chargeId: proposed.id,
      changedById: context.userId,
      now: new Date(),
      billableServiceId: context.dermatologyId,
      quantity: Quantity.parse('2'),
    });

    expect(edited.status).toBe('PLANNED');
    expect(edited.billableServiceId).toBe(context.dermatologyId);
    expect(edited.unitAmount.toString()).toBe('50.00');
    expect(edited.quantity.toString()).toBe('2.000');
    const [previous] = await versionsOf(proposed.id);
    expect((previous?.data as { unit_amount: number }).unit_amount).toBe(30);
  });

  it('BI-197 la base rechaza cambiar el contenido de un cargo facturado, y no el de uno sin facturar', async () => {
    const raised = await charge();

    // Billed by hand: the invoice issuance is tested elsewhere; here what
    // matters is the trigger. `charge_item_billed_carries_its_invoice` needs
    // an invoice row, so the frozen-billed state is reached by the repository.
    const emissionPoint = await context.prisma.emissionPoint.create({
      data: { siteId: context.siteId, code: '001', description: 'Caja' },
    });
    await context.accounts.issueInvoice({
      accountId: context.accountId,
      siteId: context.siteId,
      emissionPointId: emissionPoint.id,
      paymentMethod: '01',
      receiver: {
        buyerIdentificationType: '05',
        buyerIdentification: '1710034065',
        buyerName: 'Guamán Andrade, María José',
        buyerEmail: null,
        isFinalConsumer: false,
      },
      issuedById: context.userId,
      trail: { userId: context.userId },
      expectedChargeIds: [raised.id],
    });

    const unbilled = await charge();

    const frozen = await rejectionOf(
      context.prisma.chargeItem.update({
        where: { id: raised.id },
        data: {
          quantity: '3',
          changedById: context.userId,
          changedAt: new Date(),
        },
      }),
    );
    expect(extractDatabaseProblem(frozen)?.code).toBe(
      'CHARGE_ITEM_ALREADY_INVOICED',
    );

    // Positive control: the same stamped change on the unbilled line passes.
    await context.prisma.chargeItem.update({
      where: { id: unbilled.id },
      data: {
        quantity: '3',
        changedById: context.userId,
        changedAt: new Date(),
      },
    });
  });
});

describe('BI-198 el pagador cambia con cargos y los re-tarifa', () => {
  it('BI-198 re-tarifa los cargos sin facturar y deja los quitados como estaban', async () => {
    const kept = await charge();
    const removed = await charge();
    await context.accounts.voidCharge({
      chargeId: removed.id,
      voidedById: context.userId,
      reason: null,
      now: new Date(),
    });
    await priceForInsurer(context.generalId, '22.00');

    const preview = await context.accounts.previewRepricing({
      accountId: context.accountId,
      priceListId: context.insurerListId,
    });
    expect(preview).toEqual([
      expect.objectContaining({
        chargeId: kept.id,
        unitAmount: expect.anything(),
      }),
    ]);
    expect(preview[0]?.unitAmount?.toString()).toBe('22.00');

    await context.accounts.changeAccountPayer({
      accountId: context.accountId,
      payerId: context.insurerId,
      priceListId: context.insurerListId,
      changedById: context.userId,
      now: new Date(),
    });

    const after = await context.accounts.listCharges(context.accountId);
    const byId = new Map(after.map((c) => [c.id, c]));
    expect(byId.get(kept.id)?.unitAmount.toString()).toBe('22.00');
    expect(byId.get(removed.id)?.unitAmount.toString()).toBe('30.00');
    expect(await versionsOf(kept.id)).toHaveLength(1);
  });

  it('BI-198 sin precio en la lista nueva no cambia ni el pagador ni ningún cargo', async () => {
    const raised = await charge();

    const rejection = await rejectionOf(
      context.accounts.changeAccountPayer({
        accountId: context.accountId,
        payerId: context.insurerId,
        priceListId: context.insurerListId,
        changedById: context.userId,
        now: new Date(),
      }),
    );

    expect((rejection as { code?: string }).code).toBe('PRICE_NOT_FOUND');
    const account = await context.prisma.patientAccount.findUniqueOrThrow({
      where: { id: context.accountId },
    });
    expect(account.payerId).not.toBe(context.insurerId);
    const [unchanged] = await context.accounts.listCharges(context.accountId);
    expect(unchanged?.unitAmount.toString()).toBe('30.00');
    expect(await versionsOf(raised.id)).toHaveLength(0);
  });
});

describe('BI-195, BI-198, BI-184 lo que la revisión encontró', () => {
  it('BI-195 no devuelve un cargo anulado antes de esta entrega: no tiene versión y ya se registró otro', async () => {
    const raised = await charge();
    // As BI-059 left them: voided by hand, no stamp, no version.
    await context.prisma.$executeRaw`
      ALTER TABLE "charge_item" DISABLE TRIGGER "trg_charge_item_record_version"`;
    await context.prisma.chargeItem.update({
      where: { id: raised.id },
      data: { status: 'CANCELLED', voidedAt: new Date(), voidedById: context.userId, voidReason: 'Error' }, // prettier-ignore
    });
    await context.prisma.$executeRaw`
      ALTER TABLE "charge_item" ENABLE TRIGGER "trg_charge_item_record_version"`;

    const rejection = await rejectionOf(
      context.accounts.restoreCharge({
        chargeId: raised.id,
        changedById: context.userId,
        now: new Date(),
      }),
    );

    expect((rejection as { code?: string }).code).toBe('CHARGE_NOT_REMOVED');
  });

  it('BI-198 una línea «No se cobra» que con el pagador nuevo cuesta algo vuelve a propuesta', async () => {
    const zero = await charge();
    await context.prisma.chargeItem.update({
      where: { id: zero.id },
      data: { unitAmount: '0.00', changedById: context.userId, changedAt: new Date() }, // prettier-ignore
    });
    await context.accounts.markNotBillable({
      chargeId: zero.id,
      changedById: context.userId,
      now: new Date(),
    });
    await priceForInsurer(context.generalId, '22.00');

    await context.accounts.changeAccountPayer({
      accountId: context.accountId,
      payerId: context.insurerId,
      priceListId: context.insurerListId,
      changedById: context.userId,
      now: new Date(),
    });

    const [after] = await context.accounts.listCharges(context.accountId);
    expect(after?.status).toBe('PLANNED');
    expect(after?.unitAmount.toString()).toBe('22.00');
  });

  it('BI-184 no emite si el total que caja vio ya no es el de los cargos, aunque sean los mismos', async () => {
    const raised = await charge();
    const emissionPoint = await context.prisma.emissionPoint.create({
      data: { siteId: context.siteId, code: '001', description: 'Caja' },
    });
    const issue = (expectedTotal: string) =>
      context.accounts.issueInvoice({
        accountId: context.accountId,
        siteId: context.siteId,
        emissionPointId: emissionPoint.id,
        paymentMethod: '01',
        receiver: {
          buyerIdentificationType: '05',
          buyerIdentification: '1710034065',
          buyerName: 'Guamán Andrade, María José',
          buyerEmail: null,
          isFinalConsumer: false,
        },
        issuedById: context.userId,
        trail: { userId: context.userId },
        expectedChargeIds: [raised.id],
        expectedTotal: Money.parse(expectedTotal),
      });

    // Another cashier edits the line in place: same id, another amount.
    await context.accounts.editCharge({
      chargeId: raised.id,
      changedById: context.userId,
      now: new Date(),
      quantity: Quantity.parse('2'),
    });

    const stale = await rejectionOf(issue('30.00'));
    expect((stale as { code?: string }).code).toBe('INVOICE_CHARGES_CHANGED');
    // Positive control: with the total that is on the account now, it issues.
    await expect(issue('60.00')).resolves.toMatchObject({ status: expect.any(String) }); // prettier-ignore
  });
});

describe('BI-200 el descuento no exige motivo', () => {
  it('BI-200 la base admite un descuento sin motivo, con sello', async () => {
    const raised = await charge();

    await context.prisma.chargeItem.update({
      where: { id: raised.id },
      data: {
        discountAmount: '5.00',
        discountReason: null,
        discountAppliedById: context.userId,
        discountAppliedAt: new Date(),
        changedById: context.userId,
        changedAt: new Date(),
      },
    });

    const row = await context.prisma.chargeItem.findUniqueOrThrow({
      where: { id: raised.id },
    });
    expect(row.discountAmount.toFixed(2)).toBe('5.00');
  });
});
