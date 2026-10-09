import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
} from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';

/**
 * billing/B6: what the DATABASE guarantees about payments and the daily close
 * of cash — the balance a payment cannot exceed, the payment that is only
 * reversed and never edited or deleted, the closed day that takes nothing
 * more, and the close that is a photo of what was really collected.
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

/** The clinic's date (YYYY-MM-DD) of an instant, from the shared helper. */
const dayOf = (instant: Date) => clinicalDateOf(instant);

/**
 * A close written by raw SQL in one transaction, header and lines, so the
 * deferred check looks at the end of it.
 */
async function close(
  day: string,
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
  options: { closedAt?: Date; userId?: string } = {},
): Promise<string> {
  return scene.prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "cash_session"
        ("site_id", "user_id", "cash_date", "closed_at", "collected_total",
         "expected_cash", "declared_cash", "pending_total", "pending_count")
      VALUES (${scene.siteId}::uuid, ${options.userId ?? scene.userId}::uuid,
              ${day}::date, ${options.closedAt ?? new Date()},
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
    return row!.id;
  });
}

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

describe('billing/B6 — the daily close, guaranteed by the database', () => {
  it('BI-104 after the close, no payment nor reversal of that user that day; another user still collects (control)', async () => {
    const invoiceId = await anInvoice();
    const now = new Date();
    const today = dayOf(now);
    const paid = await pay(invoiceId, '10.00');
    await close(today, {
      collected: '10.00',
      expectedCash: '10.00',
      lines: [
        { methodId: scene.cashId, sriCode: '01', count: 1, amount: '10.00' },
      ],
    });
    await expect(pay(invoiceId, '5.00')).rejects.toThrowError(
      /cash_session_closed/,
    );
    await expect(
      scene.prisma.$executeRaw`
        UPDATE "payment" SET "reversed_at" = ${new Date()},
               "reversed_by_id" = ${scene.userId}::uuid,
               "reversal_reason" = 'Error'
         WHERE "id" = ${paid}::uuid`,
    ).rejects.toThrowError(/cash_session_closed/);
    await expect(
      pay(invoiceId, '5.00', { userId: scene.otherUserId }),
    ).resolves.toBeTypeOf('string');
  });

  it('BI-252 one close per user, site and day; none of a day still to come (positive control: today)', async () => {
    const now = new Date();
    const empty = { collected: '0', expectedCash: '0', lines: [] };
    await expect(
      close(addDays(dayOf(now), 1), empty, { closedAt: now }),
    ).rejects.toThrowError(/cash_session_date_in_future/);
    await expect(
      close(dayOf(now), empty, { closedAt: now }),
    ).resolves.toBeTypeOf('string');
    await expect(
      close(dayOf(now), empty, { closedAt: now }),
    ).rejects.toThrowError(/cash_session_one_per_day/);
  });

  it('BI-252 the close must add up to what was really collected, method by method (positive control)', async () => {
    const invoiceId = await anInvoice();
    await pay(invoiceId, '10.00');
    await pay(invoiceId, '25.00', { methodId: scene.transferId });
    const today = dayOf(new Date());
    // Short of the transfer: refused.
    await expect(
      close(today, {
        collected: '10.00',
        expectedCash: '10.00',
        lines: [
          { methodId: scene.cashId, sriCode: '01', count: 1, amount: '10.00' },
        ],
      }),
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    // Cash claimed for the transfer: refused.
    await expect(
      close(today, {
        collected: '35.00',
        expectedCash: '35.00',
        lines: [
          { methodId: scene.cashId, sriCode: '01', count: 1, amount: '10.00' },
          {
            methodId: scene.transferId,
            sriCode: '01',
            count: 1,
            amount: '25.00',
          },
        ],
      }),
    ).rejects.toThrowError(/cash_session_matches_its_payments/);
    // What it really was, with a dollar short in the drawer: accepted, and
    // the difference is the database's.
    const id = await close(today, {
      collected: '35.00',
      expectedCash: '10.00',
      declaredCash: '9.00',
      lines: [
        { methodId: scene.cashId, sriCode: '01', count: 1, amount: '10.00' },
        {
          methodId: scene.transferId,
          sriCode: '20',
          count: 1,
          amount: '25.00',
        },
      ],
    });
    const [row] = await scene.prisma.$queryRaw<{ difference: string }[]>`
      SELECT "difference"::text AS "difference" FROM "cash_session" WHERE "id" = ${id}::uuid`;
    expect(row!.difference).toBe('-1.00');
  });

  it('BI-252 a close and its lines never change nor go away, and no line is added afterwards', async () => {
    const id = await close(dayOf(new Date()), {
      collected: '0',
      expectedCash: '0',
      lines: [],
    });
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
  });

  it('BI-253 a payment racing the close either is in the photo or is refused', async () => {
    const invoiceId = await anInvoice();
    const today = dayOf(new Date());
    // The close takes the day's lock first, the way the service does, and
    // holds it while a payment tries to go in.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const closing = scene.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT cash_day_lock(${scene.siteId}::uuid, ${scene.userId}::uuid, ${today}::date)`;
        await held;
        await tx.$executeRaw`
          INSERT INTO "cash_session"
            ("site_id", "user_id", "cash_date", "closed_at", "collected_total",
             "expected_cash", "declared_cash", "pending_total", "pending_count")
          VALUES (${scene.siteId}::uuid, ${scene.userId}::uuid, ${today}::date,
                  ${new Date()}, 0, 0, 0, 0, 0)`;
      },
      { timeout: 20_000 },
    );
    const paying = pay(invoiceId, '10.00');
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await closing;
    await expect(paying).rejects.toThrowError(/cash_session_closed/);
  });
});
