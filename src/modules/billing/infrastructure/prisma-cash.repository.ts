import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { invoiceDocumentNumber } from '../../../shared/billing/document-number';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CashDayLine,
  CashDaySummary,
  CashSessionView,
  PaymentView,
  PendingInvoices,
} from '../domain/cash';
import type { CashDayKey, CashRepository } from '../domain/cash.repository';
import {
  CashDayChangedError,
  CashSessionAlreadyClosedError,
  CashSessionClosedError,
  CashSessionDateInFutureError,
  InvoiceNotPayableError,
  PaymentAlreadyReversedError,
  PaymentExceedsBalanceError,
  PaymentMethodInactiveError,
  PaymentNotFoundError,
} from '../domain/billing.errors';
import type { PaymentMethod } from '../domain/invoice';
import { Money } from '../domain/money';
import { toClinicalDate } from '../domain/price-list';
import { databaseMessageOf } from './prisma-billing-account.repository';
import { asDateColumn } from './prisma-billing-catalogue.repository';

/**
 * Payments and the daily close of cash (B6) over PostgreSQL.
 *
 * Every rule that is a sum of money lives in the migration
 * `20261009130000_payment_and_cash_session`: the balance a payment cannot
 * exceed and the closed day are decided by `trg_payment_guard` under the
 * invoice's row lock and the day's advisory lock, and the close is checked
 * against its payments at commit. This adapter only writes, reads, and says
 * what a refusal MEANS.
 */
@Injectable()
export class PrismaCashRepository implements CashRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPaymentMethod(id: string) {
    const row = await this.prisma.paymentMethod.findUnique({
      where: { id },
      select: { id: true, sriCode: true, active: true },
    });
    return row ? { ...row, sriCode: row.sriCode as PaymentMethod } : null;
  }

  async recordPayment(payment: {
    invoiceId: string;
    siteId: string;
    paymentMethodId: string;
    amount: Money;
    reference: string | null;
    receivedAt: Date;
    receivedById: string;
  }): Promise<PaymentView> {
    try {
      const row = await this.prisma.payment.create({
        include: PAYMENT_INCLUDE,
        data: {
          invoiceId: payment.invoiceId,
          siteId: payment.siteId,
          paymentMethodId: payment.paymentMethodId,
          amount: payment.amount.toString(),
          reference: payment.reference,
          receivedAt: payment.receivedAt,
          receivedById: payment.receivedById,
          // BI-250. Replaced by `trg_payment_guard` with the Guayaquil date of
          // `receivedAt`; the column is NOT NULL, so something has to go in.
          cashDate: payment.receivedAt,
        },
      });
      return toPaymentView(row);
    } catch (error) {
      throw translatePaymentRejection(error);
    }
  }

  async findPayment(query: {
    paymentId: string;
    siteId: string;
  }): Promise<PaymentView | null> {
    const row = await this.prisma.payment.findFirst({
      where: { id: query.paymentId, siteId: query.siteId },
      include: PAYMENT_INCLUDE,
    });
    return row ? toPaymentView(row) : null;
  }

  async reversePayment(reversal: {
    paymentId: string;
    reversedById: string;
    reason: string | null;
    now: Date;
  }): Promise<PaymentView> {
    try {
      const row = await this.prisma.payment.update({
        where: { id: reversal.paymentId },
        include: PAYMENT_INCLUDE,
        data: {
          reversedAt: reversal.now,
          reversedById: reversal.reversedById,
          reversalReason: reversal.reason,
        },
      });
      return toPaymentView(row);
    } catch (error) {
      throw translatePaymentRejection(error);
    }
  }

  async listDayPayments(key: CashDayKey): Promise<PaymentView[]> {
    const rows = await this.prisma.payment.findMany({
      where: dayWhere(key),
      include: PAYMENT_INCLUDE,
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toPaymentView);
  }

  pendingOfDay(key: CashDayKey): Promise<PendingInvoices> {
    return pendingOf(this.prisma, key);
  }

  async findCashSession(key: CashDayKey): Promise<CashSessionView | null> {
    const row = await this.prisma.cashSession.findUnique({
      where: {
        siteId_userId_cashDate: {
          siteId: key.siteId,
          userId: key.userId,
          cashDate: asDateColumn(key.day),
        },
      },
      include: SESSION_INCLUDE,
    });
    return row ? toSessionView(row) : null;
  }

  async closeCashSession(
    close: CashDayKey & {
      closedAt: Date;
      declaredCash: Money;
      /** BI-255. The expected cash the cashier was shown, when she was. */
      seenExpectedCash?: Money;
      note: string | null;
      summarise: (payments: readonly PaymentView[]) => CashDaySummary;
    },
  ): Promise<CashSessionView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // BI-253. The day's lock FIRST: no payment of this drawer lands
        // between what is read here and the photo written below.
        await tx.$executeRaw`
          SELECT cash_day_lock(${close.siteId}::uuid, ${close.userId}::uuid, ${close.day}::date)`;
        const existing = await tx.cashSession.findUnique({
          where: {
            siteId_userId_cashDate: {
              siteId: close.siteId,
              userId: close.userId,
              cashDate: asDateColumn(close.day),
            },
          },
          select: { id: true },
        });
        if (existing) throw new CashSessionAlreadyClosedError();

        const payments = (
          await tx.payment.findMany({
            where: dayWhere(close),
            include: PAYMENT_INCLUDE,
          })
        ).map(toPaymentView);
        const summary = close.summarise(payments);
        // BI-255. Under the lock: what she counted against is still what is.
        if (
          close.seenExpectedCash &&
          !close.seenExpectedCash.equals(summary.expectedCash)
        ) {
          throw new CashDayChangedError();
        }
        const pending = await pendingOf(tx, close);

        const session = await tx.cashSession.create({
          data: {
            siteId: close.siteId,
            userId: close.userId,
            cashDate: asDateColumn(close.day),
            closedAt: close.closedAt,
            collectedTotal: summary.collectedTotal.toString(),
            expectedCash: summary.expectedCash.toString(),
            declaredCash: close.declaredCash.toString(),
            pendingTotal: pending.total.toString(),
            pendingCount: pending.count,
            note: close.note,
            lines: {
              create: summary.lines.map((line) => ({
                paymentMethodId: line.paymentMethodId,
                methodName: line.methodName,
                sriCode: line.sriCode,
                paymentCount: line.paymentCount,
                amount: line.amount.toString(),
              })),
            },
          },
          include: SESSION_INCLUDE,
        });
        return toSessionView(session);
      });
    } catch (error) {
      throw translatePaymentRejection(error);
    }
  }

  async patientBalance(query: {
    siteId: string;
    patientId: string;
  }): Promise<Money> {
    const [row] = await this.prisma.$queryRaw<{ balance: string | null }[]>`
      SELECT SUM(i."total"
                 - COALESCE((SELECT SUM(c."amount") FROM "credit_note" c
                              WHERE c."invoice_id" = i."id" AND c."status" <> 'REJECTED'), 0)
                 - COALESCE((SELECT SUM(p."amount") FROM "payment" p
                              WHERE p."invoice_id" = i."id" AND p."reversed_at" IS NULL), 0)
             )::text AS "balance"
        FROM "invoice" i
        JOIN "patient_account" a ON a."id" = i."account_id"
       WHERE i."site_id" = ${query.siteId}::uuid
         AND a."patient_id" = ${query.patientId}::uuid
         AND i."status" NOT IN ('DRAFT', 'VOIDED')`;
    return Money.parse(row?.balance ?? '0');
  }
}

async function pendingOf(
  client: Pick<PrismaService, '$queryRaw'>,
  key: CashDayKey,
): Promise<PendingInvoices> {
  // What this cashier issued that Guayaquil day, with its balance still
  // owed: derived, as BI-103 asks, never stored.
  const [row] = await client.$queryRaw<
    { total: string | null; count: bigint }[]
  >`
    SELECT SUM(b."balance")::text AS "total", COUNT(*) AS "count"
      FROM (
        SELECT i."total"
               - COALESCE((SELECT SUM(c."amount") FROM "credit_note" c
                            WHERE c."invoice_id" = i."id" AND c."status" <> 'REJECTED'), 0)
               - COALESCE((SELECT SUM(p."amount") FROM "payment" p
                            WHERE p."invoice_id" = i."id" AND p."reversed_at" IS NULL), 0)
               AS "balance"
          FROM "invoice" i
         WHERE i."site_id" = ${key.siteId}::uuid
           AND i."issued_by_id" = ${key.userId}::uuid
           AND i."status" NOT IN ('DRAFT', 'VOIDED')
           AND (i."issued_at" AT TIME ZONE 'America/Guayaquil')::date = ${key.day}::date
      ) AS b
     WHERE b."balance" > 0`;
  return {
    total: Money.parse(row?.total ?? '0'),
    count: Number(row?.count ?? 0),
  };
}

function dayWhere(key: CashDayKey): Prisma.PaymentWhereInput {
  return {
    siteId: key.siteId,
    receivedById: key.userId,
    cashDate: asDateColumn(key.day),
  };
}

const PAYMENT_INCLUDE = {
  paymentMethod: { select: { name: true, sriCode: true, displayOrder: true } },
  invoice: {
    select: {
      accessKey: true,
      sequential: true,
      buyerName: true,
      emissionPoint: {
        select: {
          code: true,
          site: { select: { sriEstablishmentCode: true } },
        },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

function toPaymentView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceDocumentNumber: invoiceDocumentNumber({
      accessKey: row.invoice.accessKey,
      establishmentCode: row.invoice.emissionPoint.site.sriEstablishmentCode,
      emissionPointCode: row.invoice.emissionPoint.code,
      sequential: row.invoice.sequential,
    }),
    buyerName: row.invoice.buyerName,
    paymentMethodId: row.paymentMethodId,
    paymentMethodName: row.paymentMethod.name,
    sriCode: row.paymentMethod.sriCode as PaymentMethod,
    displayOrder: row.paymentMethod.displayOrder,
    amount: Money.parse(row.amount),
    reference: row.reference,
    receivedAt: row.receivedAt,
    receivedById: row.receivedById,
    cashDate: toClinicalDate(row.cashDate),
    reversal:
      row.reversedAt && row.reversedById
        ? {
            at: row.reversedAt,
            byId: row.reversedById,
            reason: row.reversalReason,
          }
        : null,
  };
}

const SESSION_INCLUDE = {
  lines: true,
  user: { select: { firstName: true, lastName: true } },
} satisfies Prisma.CashSessionInclude;

type SessionRow = Prisma.CashSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

function toSessionView(row: SessionRow): CashSessionView {
  const lines: CashDayLine[] = row.lines.map((line) => ({
    paymentMethodId: line.paymentMethodId,
    methodName: line.methodName,
    sriCode: line.sriCode as PaymentMethod,
    paymentCount: line.paymentCount,
    amount: Money.parse(line.amount),
  }));
  return {
    id: row.id,
    siteId: row.siteId,
    userId: row.userId,
    userName: `${row.user.firstName} ${row.user.lastName}`,
    cashDate: toClinicalDate(row.cashDate),
    closedAt: row.closedAt,
    lines,
    collectedTotal: Money.parse(row.collectedTotal),
    expectedCash: Money.parse(row.expectedCash),
    declaredCash: Money.parse(row.declaredCash),
    difference: Money.parse(row.difference),
    pendingTotal: Money.parse(row.pendingTotal),
    pendingCount: row.pendingCount,
    note: row.note,
  };
}

/**
 * What the payment and close triggers raised, as the error the desk reads, or
 * the original error.
 *
 * ⚠️ NOT A SECOND COPY OF THE RULE: the rules are the triggers, and they still
 * refuse a script and a `psql`. They arrive by phrase, because PL/pgSQL does
 * not emit the «violates constraint» clause; the unique index arrives as
 * Prisma's `P2002`.
 */
export function translatePaymentRejection(error: unknown): unknown {
  const message = databaseMessageOf(error).concat(
    JSON.stringify((error as { meta?: unknown })?.meta ?? ''),
  );
  if (/payment_exceeds_balance/.test(message)) {
    return new PaymentExceedsBalanceError();
  }
  if (/cash_session_closed/.test(message)) return new CashSessionClosedError();
  if (/cash_session_one_per_day/.test(message)) {
    return new CashSessionAlreadyClosedError();
  }
  if (/cash_session_date_in_future/.test(message)) {
    return new CashSessionDateInFutureError();
  }
  if (/payment_already_reversed/.test(message)) {
    return new PaymentAlreadyReversedError();
  }
  if (/payment_method_inactive/.test(message)) {
    return new PaymentMethodInactiveError();
  }
  if (/invoice_not_payable/.test(message)) return new InvoiceNotPayableError();
  if (/payment_site_is_its_invoices/.test(message)) {
    return new PaymentNotFoundError();
  }
  // A cash session matching nothing is a bug of the summariser, not of the
  // cashier: it goes up as it came.
  return error;
}
