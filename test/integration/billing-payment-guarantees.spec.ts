import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { CashSessionClosedError } from '../../src/modules/billing/domain/billing.errors';
import { summariseCashTurn } from '../../src/modules/billing/domain/cash';
import { Money, Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaCashRepository } from '../../src/modules/billing/infrastructure/prisma-cash.repository';
import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
} from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { authoriseVoucher } from './setup/sri-fixtures';

/**
 * billing/B6: what the DATABASE guarantees about payments and the close of a
 * cash turn — the balance a payment cannot exceed, the payment that is only
 * reversed and never edited or deleted, the closed payment that changes no
 * more, and the close that is a photo of what it really took (D-197.4).
 *
 * Every attempt goes in by raw SQL, underneath every layer, and each one has
 * its positive control: the same statement with what the guarantee admits
 * goes through. A refusal alone would also pass with a typo.
 */
const db = useDatabase();

const CONSULTATION = 'CONS-MG-PV';
/** BI-250. Whatever the INSERT says, the trigger writes the real day. */
const IGNORED_CASH_DATE = '1999-01-01'; // fecha-fija: the trigger replaces it

interface Scene {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  siteId: string;
  patientId: string;
  payerId: string;
  priceListId: string;
  emissionPointId: string;
  serviceId: string;
  userId: string;
  otherUserId: string;
  cashId: string;
  transferId: string;
}

let scene: Scene;

async function aUser(prisma: PrismaClient, name: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${name}${Date.now()}${Math.random()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: name,
      lastName: 'Cedeño',
    },
  });
  return user.id;
}

beforeEach(async () => {
  const prisma = db();
  await seedBilling(prisma);
  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  scene = {
    prisma,
    accounts: new PrismaBillingAccountRepository(
      prisma as unknown as PrismaService,
    ),
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
    userId: await aUser(prisma, 'Rosa'),
    otherUserId: await aUser(prisma, 'Ana'),
    cashId: (
      await prisma.paymentMethod.create({
        data: { name: 'Efectivo del cajón', sriCode: '01', displayOrder: 1 },
      })
    ).id,
    transferId: (
      await prisma.paymentMethod.create({
        data: {
          name: 'Transferencia Pichincha',
          sriCode: '20',
          displayOrder: 2,
        },
      })
    ).id,
  };
});

/** An issued invoice of two $30.00 consultations at 0 %: $60.00. */
async function anInvoice(): Promise<string> {
  const account = await scene.prisma.patientAccount.create({
    data: {
      patientId: scene.patientId,
      siteId: scene.siteId,
      payerId: scene.payerId,
      priceListId: scene.priceListId,
    },
  });
  for (let i = 0; i < 2; i += 1) {
    await scene.accounts.addCharge({
      accountId: account.id,
      billableServiceId: scene.serviceId,
      encounterId: null,
      serviceDate: clinicalDateOf(new Date()),
      quantity: Quantity.ONE,
      createdById: scene.userId,
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      status: 'BILLABLE',
    });
  }
  const invoice = await scene.accounts.issueInvoice({
    accountId: account.id,
    siteId: scene.siteId,
    emissionPointId: scene.emissionPointId,
    paymentMethod: '01',
    receiver: {
      buyerIdentificationType: '05',
      buyerIdentification: '1710034065',
      buyerName: 'Guamán Andrade, María José',
      buyerEmail: null,
      isFinalConsumer: false,
    },
    issuedById: scene.userId,
  });
  return invoice.id;
}

async function pay(
  invoiceId: string,
  amount: string,
  options: {
    at?: Date;
    userId?: string;
    methodId?: string;
    cashDate?: string;
    client?: Pick<PrismaClient, '$queryRaw'>;
  } = {},
): Promise<string> {
  const client = options.client ?? scene.prisma;
  const [row] = await client.$queryRaw<{ id: string }[]>`
    INSERT INTO "payment"
      ("invoice_id", "site_id", "payment_method_id", "amount",
       "received_at", "received_by_id", "cash_date")
    VALUES (${invoiceId}::uuid, ${scene.siteId}::uuid,
            ${options.methodId ?? scene.cashId}::uuid, ${amount}::numeric,
            ${options.at ?? new Date()}, ${options.userId ?? scene.userId}::uuid,
            ${options.cashDate ?? IGNORED_CASH_DATE}::date)
    RETURNING "id"`;
  return row!.id;
}

/**
 * A close written by raw SQL in one transaction — header, lines, and the
 * payments it takes — so the deferred check looks at the end of it.
 */
async function close(
  totals: {
    collected: string;
    expectedCash: string;
    declaredCash?: string;
    lines: {
      methodId: string;
      sriCode: string;
      count: number;
      amount: string;
    }[];
  },
  options: { closedAt?: Date; userId?: string; takes?: string[] } = {},
): Promise<string> {
  return scene.prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "cash_session"
        ("site_id", "user_id", "closed_at", "collected_total",
         "expected_cash", "declared_cash", "pending_total", "pending_count")
      VALUES (${scene.siteId}::uuid, ${options.userId ?? scene.userId}::uuid,
              ${options.closedAt ?? new Date()},
              ${totals.collected}::numeric, ${totals.expectedCash}::numeric,
              ${totals.declaredCash ?? totals.expectedCash}::numeric, 0, 0)
      RETURNING "id"`;
    for (const line of totals.lines) {
      await tx.$executeRaw`
        INSERT INTO "cash_session_line"
          ("cash_session_id", "payment_method_id", "method_name", "sri_code",
           "payment_count", "amount")
        VALUES (${row!.id}::uuid, ${line.methodId}::uuid, 'Medio',
                ${line.sriCode}, ${line.count}, ${line.amount}::numeric)`;
    }
    for (const paymentId of options.takes ?? []) {
      await tx.$executeRaw`
        UPDATE "payment" SET "cash_session_id" = ${row!.id}::uuid
         WHERE "id" = ${paymentId}::uuid`;
    }
    return row!.id;
  });
}

const cashLine = (count: number, amount: string) => ({
  methodId: scene.cashId,
  sriCode: '01',
  count,
  amount,
});

describe('billing/B6 — the payment, guaranteed by the database', () => {
  it('BI-101 refuses a payment beyond the balance, and takes one up to it (positive control)', async () => {
    const invoiceId = await anInvoice();
    await pay(invoiceId, '40.00');
    await expect(pay(invoiceId, '20.01')).rejects.toThrowError(
      /payment_exceeds_balance/,
    );
    await expect(pay(invoiceId, '20.00')).resolves.toBeTypeOf('string');
    await expect(pay(invoiceId, '0.01')).rejects.toThrowError(
      /payment_exceeds_balance/,
    );
  });

  it('BI-101 BI-103 a reversed payment frees its amount for another', async () => {
    const invoiceId = await anInvoice();
    const first = await pay(invoiceId, '60.00');
    await scene.prisma.$executeRaw`
      UPDATE "payment" SET "reversed_at" = ${new Date()},
             "reversed_by_id" = ${scene.userId}::uuid,
             "reversal_reason" = 'Se cobró a otra factura'
       WHERE "id" = ${first}::uuid`;
    await expect(pay(invoiceId, '60.00')).resolves.toBeTypeOf('string');
  });

  it('BI-101 two payments of the whole balance at once: exactly one goes in', async () => {
    const invoiceId = await anInvoice();
    const results = await Promise.allSettled([
      scene.prisma.$transaction((tx) =>
        pay(invoiceId, '60.00', { client: tx }),
      ),
      scene.prisma.$transaction((tx) =>
        pay(invoiceId, '60.00', { client: tx }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /payment_exceeds_balance/,
    );
  });

  it('BI-248 refuses a payment on a voided invoice, an inactive method or a non-positive amount, with controls', async () => {
    const invoiceId = await anInvoice();
    await expect(pay(invoiceId, '0.00')).rejects.toThrowError(
      /payment_amount_is_positive/,
    );
    await scene.prisma.paymentMethod.update({
      where: { id: scene.transferId },
      data: { active: false },
    });
    await expect(
      pay(invoiceId, '1.00', { methodId: scene.transferId }),
    ).rejects.toThrowError(/payment_method_inactive/);
    await expect(pay(invoiceId, '1.00')).resolves.toBeTypeOf('string');

    const other = await anInvoice();
    await scene.prisma.$executeRaw`
      UPDATE "invoice" SET "status" = 'VOIDED' WHERE "id" = ${other}::uuid`;
    await expect(pay(other, '1.00')).rejects.toThrowError(
      /invoice_not_payable/,
    );
  });

  it('BI-250 writes the Guayaquil date of the instant, whatever the INSERT says — 21:30 there is the same day', async () => {
    const invoiceId = await anInvoice();
    // The clinic's today at 21:30 (UTC−5): already tomorrow in UTC.
    const today = clinicalDateOf(new Date());
    const evening = atWallClock(today, WallClockTime.of(21, 30, 0));
    expect(evening.toISOString().slice(0, 10)).toBe(addDays(today, 1));
    const id = await pay(invoiceId, '10.00', { at: evening });
    const [row] = await scene.prisma.$queryRaw<{ day: string }[]>`
      SELECT to_char("cash_date", 'YYYY-MM-DD') AS "day" FROM "payment" WHERE "id" = ${id}::uuid`;
    expect(row!.day).toBe(today);
  });

  it('BI-102 a payment is never deleted nor edited; its reversal is written once (positive control)', async () => {
    const invoiceId = await anInvoice();
    const id = await pay(invoiceId, '10.00');
    await expect(
      scene.prisma.$executeRaw`DELETE FROM "payment" WHERE "id" = ${id}::uuid`,
    ).rejects.toThrowError(/payment is never deleted/);
    await expect(
      scene.prisma
        .$executeRaw`UPDATE "payment" SET "amount" = 5 WHERE "id" = ${id}::uuid`,
    ).rejects.toThrowError(/payment cannot be modified/);
    await expect(
      scene.prisma
        .$executeRaw`UPDATE "payment" SET "reversed_at" = ${new Date()} WHERE "id" = ${id}::uuid`,
    ).rejects.toThrowError(/payment_reversal_states_who_and_when/);
    await expect(
      scene.prisma.$executeRaw`
        UPDATE "payment" SET "reversed_at" = ${new Date()},
               "reversed_by_id" = ${scene.userId}::uuid, "reversal_reason" = '  '
         WHERE "id" = ${id}::uuid`,
    ).rejects.toThrowError(/payment_reversal_states_who_and_when/);
    const reverse = () => scene.prisma.$executeRaw`
      UPDATE "payment" SET "reversed_at" = ${new Date()},
             "reversed_by_id" = ${scene.userId}::uuid,
             "reversal_reason" = 'Error de digitación'
       WHERE "id" = ${id}::uuid`;
    await expect(reverse()).resolves.toBe(1);
    await expect(reverse()).rejects.toThrowError(/payment_already_reversed/);
  });
});

describe('billing/B6 — what else the payment trigger refuses', () => {
  it('BI-101 BI-103 what a credit note credited is not collected (positive control: the rest is)', async () => {
    const invoiceId = await anInvoice();
    await authoriseVoucher(scene.prisma, invoiceId);
    const [charge] = await scene.prisma.chargeItem.findMany({
      where: { invoiceId },
      take: 1,
    });
    await scene.prisma.$transaction(async (tx) => {
      const [note] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "credit_note"
          ("invoice_id", "site_id", "emission_point_id", "sequential",
           "reason_code", "reason",
           "buyer_identification_type", "buyer_identification", "buyer_name",
           "subtotal_taxed", "subtotal_untaxed", "discount_total", "tax_total",
           "amount", "status", "issued_by_id", "issued_at", "updated_at")
        VALUES (${invoiceId}::uuid, ${scene.siteId}::uuid,
                ${scene.emissionPointId}::uuid, '000000001',
                'RECEIVER_DATA', 'Error en los datos del receptor',
                '05', '1710034065', 'Guamán Andrade, María José',
                0, 30, 0, 0, 30, 'ISSUED', ${scene.userId}::uuid,
                ${new Date()}, ${new Date()})
        RETURNING "id"`;
      await tx.$executeRaw`
        INSERT INTO "credit_note_line"
          ("credit_note_id", "charge_item_id", "service_code", "description",
           "quantity", "unit_amount", "discount_amount", "tax_sri_code",
           "tax_percentage", "net_amount", "tax_amount")
        VALUES (${note!.id}::uuid, ${charge!.id}::uuid, ${CONSULTATION},
                'Consulta', 1, 30, 0, '0', 0, 30, 0)`;
    });
    await expect(pay(invoiceId, '30.01')).rejects.toThrowError(
      /payment_exceeds_balance/,
    );
    await expect(pay(invoiceId, '30.00')).resolves.toBeTypeOf('string');
  });

  it('BI-135 a payment belongs to the site of its invoice (positive control: its own site)', async () => {
    const invoiceId = await anInvoice();
    const other = await createSite(scene.prisma);
    await expect(
      scene.prisma.$queryRaw`
        INSERT INTO "payment"
          ("invoice_id", "site_id", "payment_method_id", "amount",
           "received_at", "received_by_id", "cash_date")
        VALUES (${invoiceId}::uuid, ${other.id}::uuid, ${scene.cashId}::uuid,
                1, ${new Date()}, ${scene.userId}::uuid, ${IGNORED_CASH_DATE}::date)`,
    ).rejects.toThrowError(/payment_site_is_its_invoices/);
    await expect(pay(invoiceId, '1.00')).resolves.toBeTypeOf('string');
  });

  it('BI-102 a payment is born unreversed (positive control: without the reversal it goes in)', async () => {
    const invoiceId = await anInvoice();
    await expect(
      scene.prisma.$queryRaw`
        INSERT INTO "payment"
          ("invoice_id", "site_id", "payment_method_id", "amount",
           "received_at", "received_by_id", "cash_date", "reversed_at",
           "reversed_by_id")
        VALUES (${invoiceId}::uuid, ${scene.siteId}::uuid, ${scene.cashId}::uuid,
                1, ${new Date()}, ${scene.userId}::uuid, ${IGNORED_CASH_DATE}::date,
                ${new Date()}, ${scene.userId}::uuid)`,
    ).rejects.toThrowError(/payment_is_born_unreversed/);
    await expect(pay(invoiceId, '1.00')).resolves.toBeTypeOf('string');
  });

  it('BI-253 a payment still uncommitted when the close reads is not refused: it stays for the next turn', async () => {
    const invoiceId = await anInvoice();
    const repository = new PrismaCashRepository(
      scene.prisma as unknown as PrismaService,
    );
    const first = await pay(invoiceId, '10.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let late = '';
    const paying = scene.prisma.$transaction(
      async (tx) => {
        late = await pay(invoiceId, '12.00', { client: tx });
        await held;
      },
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The close does not wait for the payment: it takes what is committed.
    const session = await repository.closeCashSession({
      siteId: scene.siteId,
      userId: scene.userId,
      clock: () => new Date(),
      declaredCash: Money.parse('10.00'),
      seenPreviousSessionId: null,
      note: null,
      summarise: summariseCashTurn,
    });
    release();
    await paying;
    expect(session.collectedTotal.toString()).toBe('10.00');
    const rows = await scene.prisma.payment.findMany({
      where: { id: { in: [first, late] } },
      select: { id: true, cashSessionId: true },
    });
    expect(rows.find((row) => row.id === first)?.cashSessionId).toBe(
      session.id,
    );
    expect(rows.find((row) => row.id === late)?.cashSessionId).toBeNull();
  });
});

describe('billing/B6 — a reversal without a reason (D-126)', () => {
  it('BI-102 the reason may be left out: who and when are enough', async () => {
    const invoiceId = await anInvoice();
    const id = await pay(invoiceId, '10.00');
    await expect(
      scene.prisma.$executeRaw`
        UPDATE "payment" SET "reversed_at" = ${new Date()},
               "reversed_by_id" = ${scene.userId}::uuid
         WHERE "id" = ${id}::uuid`,
    ).resolves.toBe(1);
  });
});

describe('billing/B6 — the close of a turn, guaranteed by the database', () => {
  it('BI-104 after a close the same cashier still collects, in the next turn; the closed payment is not reversed (control: the open one is)', async () => {
    const invoiceId = await anInvoice();
    const closed = await pay(invoiceId, '10.00');
    await close(
      {
        collected: '10.00',
        expectedCash: '10.00',
        lines: [cashLine(1, '10.00')],
      },
      { takes: [closed] },
    );
    const open = await pay(invoiceId, '5.00');
    const reverse = (id: string) => scene.prisma.$executeRaw`
      UPDATE "payment" SET "reversed_at" = ${new Date()},
             "reversed_by_id" = ${scene.userId}::uuid,
             "reversal_reason" = 'Error'
       WHERE "id" = ${id}::uuid`;
    await expect(reverse(closed)).rejects.toThrowError(/cash_session_closed/);
    await expect(reverse(open)).resolves.toBe(1);
  });

  it('BI-104 two closes the same day for the same cashier, one after the other (positive control: an earlier one is refused)', async () => {
    const invoiceId = await anInvoice();
    const morning = await pay(invoiceId, '10.00');
    const noon = new Date();
    await close(
      {
        collected: '10.00',
        expectedCash: '10.00',
        lines: [cashLine(1, '10.00')],
      },
      { takes: [morning], closedAt: noon },
    );
    const afternoon = await pay(invoiceId, '20.00');
    await expect(
      close(
        {
          collected: '20.00',
          expectedCash: '20.00',
          lines: [cashLine(1, '20.00')],
        },
        { takes: [afternoon], closedAt: new Date(noon.getTime() - 1) },
      ),
    ).rejects.toThrowError(/cash_session_after_the_last/);
    await expect(
      close(
        {
          collected: '20.00',
          expectedCash: '20.00',
          lines: [cashLine(1, '20.00')],
        },
        { takes: [afternoon], closedAt: new Date(noon.getTime() + 1000) },
      ),
    ).resolves.toBeTypeOf('string');
    const sessions = await scene.prisma.cashSession.count({
      where: { siteId: scene.siteId, userId: scene.userId },
    });
    expect(sessions).toBe(2);
  });

  it('BI-252 a payment is born open and goes only to a close of its own drawer, not before its instant (positive control)', async () => {
    const invoiceId = await anInvoice();
    const now = new Date();
    const sessionOf = (userId: string, closedAt: Date) =>
      close(
        { collected: '0', expectedCash: '0', lines: [] },
        { userId, closedAt },
      );
    const other = await sessionOf(scene.otherUserId, now);
    await expect(
      scene.prisma.$queryRaw`
        INSERT INTO "payment"
          ("invoice_id", "site_id", "payment_method_id", "amount",
           "received_at", "received_by_id", "cash_date", "cash_session_id")
        VALUES (${invoiceId}::uuid, ${scene.siteId}::uuid, ${scene.cashId}::uuid,
                1, ${now}, ${scene.otherUserId}::uuid, ${IGNORED_CASH_DATE}::date,
                ${other}::uuid)`,
    ).rejects.toThrowError(/payment_is_born_open/);

    const paid = await pay(invoiceId, '10.00', { at: now });
    const take = (sessionId: string) => scene.prisma.$executeRaw`
      UPDATE "payment" SET "cash_session_id" = ${sessionId}::uuid
       WHERE "id" = ${paid}::uuid`;
    // Another cashier's close.
    await expect(take(other)).rejects.toThrowError(
      /payment_session_is_its_drawer/,
    );
    // Its own drawer, but closed before the payment came in.
    const earlier = await sessionOf(
      scene.userId,
      new Date(now.getTime() - 60_000),
    );
    await expect(take(earlier)).rejects.toThrowError(
      /payment_session_is_its_drawer/,
    );
    // Reversed and closed in the same statement.
    await expect(
      scene.prisma.$executeRaw`
        UPDATE "payment" SET "cash_session_id" = ${earlier}::uuid,
               "reversed_at" = ${new Date()}, "reversed_by_id" = ${scene.userId}::uuid
         WHERE "id" = ${paid}::uuid`,
    ).rejects.toThrowError(/payment cannot be modified/);
    // Its own close, written with it: accepted.
    await expect(
      close(
        {
          collected: '10.00',
          expectedCash: '10.00',
          lines: [cashLine(1, '10.00')],
        },
        { takes: [paid], closedAt: new Date(now.getTime() + 1000) },
      ),
    ).resolves.toBeTypeOf('string');
  });

  it('BI-252 the close must add up to what it takes, method by method (positive control)', async () => {
    const invoiceId = await anInvoice();
    const cash = await pay(invoiceId, '10.00');
    const transfer = await pay(invoiceId, '25.00', {
      methodId: scene.transferId,
    });
    const takes = [cash, transfer];
    // Short of the transfer: refused.
    await expect(
      close(
        {
          collected: '10.00',
          expectedCash: '10.00',
          lines: [cashLine(1, '10.00')],
        },
        { takes },
      ),
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    // Cash claimed for the transfer: refused.
    await expect(
      close(
        {
          collected: '35.00',
          expectedCash: '35.00',
          lines: [
            cashLine(1, '10.00'),
            {
              methodId: scene.transferId,
              sriCode: '01',
              count: 1,
              amount: '25.00',
            },
          ],
        },
        { takes },
      ),
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    // The lines of both, but only the cash payment taken: refused.
    await expect(
      close(
        {
          collected: '35.00',
          expectedCash: '10.00',
          lines: [
            cashLine(1, '10.00'),
            {
              methodId: scene.transferId,
              sriCode: '20',
              count: 1,
              amount: '25.00',
            },
          ],
        },
        { takes: [cash] },
      ),
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    // What it really was, with a dollar short in the drawer: accepted, and
    // the difference is the database's.
    const id = await close(
      {
        collected: '35.00',
        expectedCash: '10.00',
        declaredCash: '9.00',
        lines: [
          cashLine(1, '10.00'),
          {
            methodId: scene.transferId,
            sriCode: '20',
            count: 1,
            amount: '25.00',
          },
        ],
      },
      { takes },
    );
    const [row] = await scene.prisma.$queryRaw<{ difference: string }[]>`
      SELECT "difference"::text AS "difference" FROM "cash_session" WHERE "id" = ${id}::uuid`;
    expect(row!.difference).toBe('-1.00');
  });

  it('BI-252 a close and its lines never change nor go away; no line nor payment is added afterwards', async () => {
    const invoiceId = await anInvoice();
    const id = await close({ collected: '0', expectedCash: '0', lines: [] });
    await expect(
      scene.prisma
        .$executeRaw`UPDATE "cash_session" SET "declared_cash" = 5 WHERE "id" = ${id}::uuid`,
    ).rejects.toThrowError(/cash_session_is_final/);
    await expect(
      scene.prisma
        .$executeRaw`DELETE FROM "cash_session" WHERE "id" = ${id}::uuid`,
    ).rejects.toThrowError(/cash_session_is_final/);
    await expect(
      scene.prisma.$executeRaw`
        INSERT INTO "cash_session_line"
          ("cash_session_id", "payment_method_id", "method_name", "sri_code",
           "payment_count", "amount")
        VALUES (${id}::uuid, ${scene.cashId}::uuid, 'Efectivo', '01', 1, 10)`,
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    const paid = await pay(invoiceId, '10.00', {
      at: new Date(Date.now() - 60_000),
    });
    await expect(
      scene.prisma.$executeRaw`
        UPDATE "payment" SET "cash_session_id" = ${id}::uuid WHERE "id" = ${paid}::uuid`,
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    // A taken payment is not taken again by a later close.
    const later = await close(
      {
        collected: '10.00',
        expectedCash: '10.00',
        lines: [cashLine(1, '10.00')],
      },
      { takes: [paid], closedAt: new Date(Date.now() + 1000) },
    );
    expect(later).toBeTypeOf('string');
    await expect(
      close(
        { collected: '0', expectedCash: '0', lines: [] },
        { takes: [paid], closedAt: new Date(Date.now() + 2000) },
      ),
    ).rejects.toThrowError(/cash_session_closed/);
  });

  it('BI-253 a payment stamped after the instant of the close stays for the next turn instead of failing it (positive control: the earlier one is taken)', async () => {
    const invoiceId = await anInvoice();
    const repository = new PrismaCashRepository(
      scene.prisma as unknown as PrismaService,
    );
    const closedAt = new Date();
    const taken = await pay(invoiceId, '10.00', {
      at: new Date(closedAt.getTime() - 1000),
    });
    // Another API's clock, a little ahead: committed before the close reads.
    const ahead = await pay(invoiceId, '5.00', {
      at: new Date(closedAt.getTime() + 5000),
    });
    const session = await repository.closeCashSession({
      siteId: scene.siteId,
      userId: scene.userId,
      clock: () => closedAt,
      declaredCash: Money.parse('10.00'),
      seenPreviousSessionId: null,
      note: null,
      summarise: summariseCashTurn,
    });
    expect(session.collectedTotal.toString()).toBe('10.00');
    const rows = await scene.prisma.payment.findMany({
      where: { id: { in: [taken, ahead] } },
      select: { id: true, cashSessionId: true },
    });
    expect(rows.find((row) => row.id === taken)?.cashSessionId).toBe(
      session.id,
    );
    expect(rows.find((row) => row.id === ahead)?.cashSessionId).toBeNull();
  });

  it('BI-258 a close at 21:30 in Guayaquil is of that day there, although in UTC it is already the next', async () => {
    const repository = new PrismaCashRepository(
      scene.prisma as unknown as PrismaService,
    );
    const today = clinicalDateOf(new Date());
    const evening = atWallClock(today, WallClockTime.of(21, 30, 0));
    expect(evening.toISOString().slice(0, 10)).toBe(addDays(today, 1));
    const id = await close(
      { collected: '0', expectedCash: '0', lines: [] },
      { closedAt: evening },
    );
    const key = { siteId: scene.siteId, userId: scene.userId };
    const sameDay = await repository.listCashSessionsOfDay({
      ...key,
      day: today,
    });
    expect(sameDay.map((session) => session.id)).toEqual([id]);
    const nextDay = await repository.listCashSessionsOfDay({
      ...key,
      day: addDays(today, 1),
    });
    expect(nextDay).toHaveLength(0);
  });

  it('BI-253 a reversal racing the close is either in the photo or refused: with the close first, refused', async () => {
    const invoiceId = await anInvoice();
    const paid = await pay(invoiceId, '10.00');
    const repository = new PrismaCashRepository(
      scene.prisma as unknown as PrismaService,
    );
    // The close takes the drawer's lock first, the way the repository does,
    // and holds it while the reversal tries.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const closing = scene.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT cash_drawer_lock(${scene.siteId}::uuid, ${scene.userId}::uuid)`;
        await held;
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "cash_session"
            ("site_id", "user_id", "closed_at", "collected_total",
             "expected_cash", "declared_cash", "pending_total", "pending_count")
          VALUES (${scene.siteId}::uuid, ${scene.userId}::uuid, ${new Date()},
                  10, 10, 10, 0, 0)
          RETURNING "id"`;
        await tx.$executeRaw`
          INSERT INTO "cash_session_line"
            ("cash_session_id", "payment_method_id", "method_name", "sri_code",
             "payment_count", "amount")
          VALUES (${row!.id}::uuid, ${scene.cashId}::uuid, 'Efectivo', '01', 1, 10)`;
        await tx.$executeRaw`
          UPDATE "payment" SET "cash_session_id" = ${row!.id}::uuid WHERE "id" = ${paid}::uuid`;
      },
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reversing = repository.reversePayment({
      paymentId: paid,
      reversedById: scene.userId,
      reason: null,
      now: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await closing;
    await expect(reversing).rejects.toBeInstanceOf(CashSessionClosedError);
  });

  it('BI-253 with the reversal first, the close waits and leaves it out of the photo (positive control)', async () => {
    const invoiceId = await anInvoice();
    const kept = await pay(invoiceId, '10.00');
    const undone = await pay(invoiceId, '7.00');
    const repository = new PrismaCashRepository(
      scene.prisma as unknown as PrismaService,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reversing = scene.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT cash_drawer_lock(${scene.siteId}::uuid, ${scene.userId}::uuid)`;
        await tx.$executeRaw`
          UPDATE "payment" SET "reversed_at" = ${new Date()},
                 "reversed_by_id" = ${scene.userId}::uuid
           WHERE "id" = ${undone}::uuid`;
        await held;
      },
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const closing = repository.closeCashSession({
      siteId: scene.siteId,
      userId: scene.userId,
      clock: () => new Date(),
      declaredCash: Money.parse('10.00'),
      seenPreviousSessionId: null,
      note: null,
      summarise: summariseCashTurn,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await reversing;
    const session = await closing;
    expect(session.collectedTotal.toString()).toBe('10.00');
    const taken = await scene.prisma.payment.findMany({
      where: { cashSessionId: session.id },
      select: { id: true },
    });
    expect(taken.map((row) => row.id).sort()).toEqual([kept, undone].sort());
  });
});
