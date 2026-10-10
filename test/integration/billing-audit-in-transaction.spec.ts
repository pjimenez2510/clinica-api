import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import type { BillingTrail } from '../../src/modules/billing/domain/billing-trail';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaCreditNoteRepository } from '../../src/modules/billing/infrastructure/prisma-credit-note.repository';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { authoriseVoucher, insertVoucher } from './setup/sri-fixtures';

/**
 * BI-273: the trail of an issuance commits WITH the document or not at all.
 *
 * Both directions, against PostgreSQL, because a transaction is the only
 * thing that can promise them:
 *
 *   · the database refuses the document AFTER its entry was written → neither
 *     the document nor the entry exists (the trail never claims what was
 *     undone);
 *   · the database refuses the ENTRY → the document does not exist either
 *     (a committed document is never left without who issued it).
 *
 * The entry is refused through `access_audit.ip`, an `inet`: a value that is
 * not an address is the one way to make that insert fail without touching
 * the table. Each refusal has its positive control — the same call with a
 * valid trail commits both.
 */
const db = useDatabase();

const CONSULTATION = 'CONS-MG-PV';
const RECEIVER = {
  buyerIdentificationType: '05',
  buyerIdentification: '1710034065',
  buyerName: 'Guamán Andrade, María José',
  buyerEmail: null,
  isFinalConsumer: false,
} as const;

interface Scene {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  creditNotes: PrismaCreditNoteRepository;
  siteId: string;
  patientId: string;
  payerId: string;
  priceListId: string;
  emissionPointId: string;
  serviceId: string;
  userId: string;
  trail: BillingTrail;
}

let scene: Scene;

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
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const asService = prisma as unknown as PrismaService;
  scene = {
    prisma,
    accounts: new PrismaBillingAccountRepository(asService),
    creditNotes: new PrismaCreditNoteRepository(asService),
    siteId: site.id,
    patientId: patient.id,
    payerId: payer.id,
    priceListId: (
      await prisma.priceList.findFirstOrThrow({ where: { payerId: payer.id } })
    ).id,
    emissionPointId: (
      await prisma.emissionPoint.create({
        data: { siteId: site.id, code: '001', description: 'Caja principal' },
      })
    ).id,
    serviceId: (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: CONSULTATION },
      })
    ).id,
    userId: user.id,
    trail: { userId: user.id, ip: '10.0.0.7', userAgent: 'vitest' },
  };
});

/** `inet` refuses it, so the entry cannot be written. */
function unwritableTrail(): BillingTrail {
  return { ...scene.trail, ip: 'not-an-address' };
}

async function anAccountWithACharge(): Promise<string> {
  const account = await scene.prisma.patientAccount.create({
    data: {
      patientId: scene.patientId,
      siteId: scene.siteId,
      payerId: scene.payerId,
      priceListId: scene.priceListId,
    },
  });
  await scene.accounts.addCharge({
    accountId: account.id,
    billableServiceId: scene.serviceId,
    encounterId: null,
    // The clinic's today, from the clock: no date is written by hand.
    serviceDate: clinicalDateOf(new Date()),
    quantity: Quantity.ONE,
    createdById: scene.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
  return account.id;
}

function issue(
  accountId: string,
  options: { trail?: BillingTrail; paymentMethodId?: string } = {},
) {
  return scene.accounts.issueInvoice({
    accountId,
    siteId: scene.siteId,
    emissionPointId: scene.emissionPointId,
    paymentMethod: '01',
    receiver: RECEIVER,
    issuedById: scene.userId,
    trail: options.trail ?? scene.trail,
    payment:
      options.paymentMethodId === undefined
        ? undefined
        : {
            paymentMethodId: options.paymentMethodId,
            reference: null,
            receivedAt: new Date(),
          },
  });
}

function entriesOf(resourceType: string) {
  return scene.prisma.accessAudit.findMany({
    where: { resourceType, userId: scene.userId },
    select: { resourceId: true, action: true, ip: true, userAgent: true },
  });
}

async function aPaymentMethod(active: boolean): Promise<string> {
  const method = await scene.prisma.paymentMethod.create({
    data: {
      // Unique by name, and the seed already brings «Efectivo».
      name: active ? 'Efectivo de prueba' : 'Cheque retirado',
      sriCode: '01',
      active,
      displayOrder: 90,
    },
  });
  return method.id;
}

describe('BI-273 la bitácora de la factura se confirma con la factura', () => {
  it('BI-273 una emisión confirmada deja UNA entrada con su id, quién y desde dónde', async () => {
    const accountId = await anAccountWithACharge();

    const invoice = await issue(accountId, {
      paymentMethodId: await aPaymentMethod(true),
    });

    expect(await entriesOf('invoice')).toEqual([
      {
        resourceId: invoice.id,
        action: 'CREATE',
        ip: '10.0.0.7',
        userAgent: 'vitest',
      },
    ]);
  });

  it('BI-273 una emisión que la base rechaza DESPUÉS de escribir la entrada no deja ni factura ni entrada', async () => {
    const accountId = await anAccountWithACharge();
    // `trg_payment_guard` refuses the payment, which is written after the
    // invoice and its entry inside the same transaction.
    const inactive = await aPaymentMethod(false);

    await expect(
      issue(accountId, { paymentMethodId: inactive }),
    ).rejects.toBeDefined();

    expect(await scene.prisma.invoice.count({ where: { accountId } })).toBe(0);
    expect(await entriesOf('invoice')).toEqual([]);
  });

  it('BI-273 una entrada que la base rechaza no deja factura', async () => {
    const accountId = await anAccountWithACharge();

    await expect(
      issue(accountId, { trail: unwritableTrail() }),
    ).rejects.toBeDefined();

    expect(await scene.prisma.invoice.count({ where: { accountId } })).toBe(0);
    expect(
      await scene.prisma.chargeItem.count({
        where: { accountId, status: 'BILLABLE' },
      }),
    ).toBe(1);
  });

  it('BI-273 corregir el receptor de una factura devuelta deja su entrada, o no corrige nada', async () => {
    const invoice = await issue(await anAccountWithACharge());
    // Returned for real: the invoice REJECTED and its voucher RETURNED, the
    // only state `trg_invoice_receiver_editable_only_when_rejected` admits.
    const voucher = await insertVoucher(scene.prisma, invoice.id, {
      signed: true,
    });
    await scene.prisma
      .$executeRaw`UPDATE "electronic_voucher" SET "status" = 'RETURNED' WHERE "id" = ${voucher.id}::uuid`;
    await scene.prisma
      .$executeRaw`UPDATE "invoice" SET "status" = 'REJECTED', "access_key" = ${voucher.accessKey} WHERE "id" = ${invoice.id}::uuid`;
    const correction = (trail: BillingTrail) =>
      scene.accounts.correctRejectedInvoice({
        invoiceId: invoice.id,
        siteId: scene.siteId,
        receiver: { ...RECEIVER, buyerName: 'Guamán Andrade, María' },
        paymentMethod: '01',
        changedById: scene.userId,
        now: new Date(),
        trail,
      });

    await expect(correction(unwritableTrail())).rejects.toBeDefined();
    expect(
      (
        await scene.prisma.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
        })
      ).buyerName,
    ).toBe(RECEIVER.buyerName);

    // Positive control: the same correction with a writable trail.
    await correction(scene.trail);
    expect(
      (
        await scene.prisma.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
        })
      ).buyerName,
    ).toBe('Guamán Andrade, María');
    expect(
      (await entriesOf('invoice')).map((entry) => entry.action).sort(),
    ).toEqual(['CREATE', 'UPDATE']);
  });
});

describe('BI-273 la bitácora de la nota de crédito se confirma con la nota', () => {
  async function anAuthorisedInvoice() {
    const accountId = await anAccountWithACharge();
    const invoice = await issue(accountId);
    await authoriseVoucher(scene.prisma, invoice.id);
    const charges = await scene.prisma.chargeItem.findMany({
      where: { invoiceId: invoice.id },
      select: { id: true },
    });
    return { invoiceId: invoice.id, chargeIds: charges.map((c) => c.id) };
  }

  function creditNote(
    invoice: { invoiceId: string; chargeIds: string[] },
    trail: BillingTrail,
  ) {
    return scene.creditNotes.issue({
      invoiceId: invoice.invoiceId,
      siteId: scene.siteId,
      chargeIds: invoice.chargeIds,
      reasonCode: 'RECEIVER_DATA',
      reason: 'Error en los datos del receptor',
      rebill: true,
      issuedById: scene.userId,
      now: new Date(),
      trail,
    });
  }

  it('BI-273 una entrada que la base rechaza no deja nota de crédito ni vuelve a cobrar las líneas', async () => {
    const invoice = await anAuthorisedInvoice();

    await expect(creditNote(invoice, unwritableTrail())).rejects.toBeDefined();

    expect(
      await scene.prisma.creditNote.count({
        where: { invoiceId: invoice.invoiceId },
      }),
    ).toBe(0);
    expect(
      await scene.prisma.chargeItem.count({ where: { origin: 'CORRECTION' } }),
    ).toBe(0);
    expect(await entriesOf('credit_note')).toEqual([]);
  });

  it('BI-273 una nota de crédito confirmada deja UNA entrada con su id', async () => {
    const invoice = await anAuthorisedInvoice();

    const issued = await creditNote(invoice, scene.trail);

    expect(await entriesOf('credit_note')).toEqual([
      {
        resourceId: issued.creditNote.id,
        action: 'CREATE',
        ip: '10.0.0.7',
        userAgent: 'vitest',
      },
    ]);
  });
});
