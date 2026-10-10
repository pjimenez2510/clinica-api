import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { invoiceDocumentNumber } from '../../../shared/billing/document-number';
import {
  clinicalDayBounds,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CashLine,
  CashSessionView,
  CashTurnSummary,
  PaymentView,
  PendingInvoices,
} from '../domain/cash';
import type { CashDrawerKey, CashRepository } from '../domain/cash.repository';
import { INVOICE_BALANCE, INVOICE_CAN_OWE } from './invoice-balance.sql';
import {
  CashSessionAlreadyClosedError,
  CashSessionChangedError,
  CashSessionClosedError,
  CashSessionEmptyError,
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

/**
 * Payments and the close of a cash turn (B6) over PostgreSQL.
 *
 * Every rule that is a sum of money lives in the migrations
 * `20261009130000_payment_and_cash_session` and
 * `20261010100000_cash_session_by_turn`: the balance a payment cannot exceed
 * is decided by `trg_payment_guard` under the invoice's row lock, a closed
 * payment by `trg_payment_only_reverses`, and the close is checked against
 * the payments it took at commit. This adapter only writes, reads, takes the
 * drawer's lock, and says what a refusal MEANS.
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
      return await this.prisma.$transaction(async (tx) => {
        const owner = await tx.payment.findUniqueOrThrow({
          where: { id: reversal.paymentId },
          select: { siteId: true, receivedById: true },
        });
        // BI-253. The drawer's lock BEFORE the row's: a close holding it
        // either took this payment already (and the trigger refuses) or
        // waits for the reversal and leaves it out of the photo.
        await tx.$executeRaw`
          SELECT cash_drawer_lock(${owner.siteId}::uuid, ${owner.receivedById}::uuid)`;
        const row = await tx.payment.update({
          where: { id: reversal.paymentId },
          include: PAYMENT_INCLUDE,
          data: {
            reversedAt: reversal.now,
            reversedById: reversal.reversedById,
            reversalReason: reversal.reason,
          },
        });
        return toPaymentView(row);
      });
    } catch (error) {
      throw translatePaymentRejection(error);
    }
  }

  async listOpenTurnPayments(key: CashDrawerKey): Promise<PaymentView[]> {
    const rows = await this.prisma.payment.findMany({
      where: openTurnWhere(key),
      include: PAYMENT_INCLUDE,
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toPaymentView);
  }

  async findLastCashSession(
    key: CashDrawerKey,
  ): Promise<CashSessionView | null> {
    const [last, before] = await this.prisma.cashSession.findMany({
      where: { siteId: key.siteId, userId: key.userId },
      orderBy: { closedAt: 'desc' },
      take: 2,
      include: SESSION_INCLUDE,
    });
    return last ? toSessionView(last, before?.closedAt ?? null) : null;
  }

  pendingOfTurn(
    key: CashDrawerKey & { since: Date | null; until: Date },
  ): Promise<PendingInvoices> {
    return pendingOf(this.prisma, key);
  }

  async listCashSessionsOfDay(
    key: CashDrawerKey & { day: ClinicalDate },
  ): Promise<CashSessionView[]> {
    const { startsAt, endsAtExclusive } = clinicalDayBounds(key.day);
    const drawer = { siteId: key.siteId, userId: key.userId };
    const [rows, before] = await Promise.all([
      this.prisma.cashSession.findMany({
        where: { ...drawer, closedAt: { gte: startsAt, lt: endsAtExclusive } },
        orderBy: { closedAt: 'asc' },
        include: SESSION_INCLUDE,
      }),
      this.prisma.cashSession.findFirst({
        where: { ...drawer, closedAt: { lt: startsAt } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      }),
    ]);
    // BI-258. «Since when» is the close before it: derived, never stored.
    let previous = before?.closedAt ?? null;
    return rows.map((row) => {
      const view = toSessionView(row, previous);
      previous = row.closedAt;
      return view;
    });
  }

  async closeCashSession(
    close: CashDrawerKey & {
      clock: () => Date;
      declaredCash: Money;
      seenPreviousSessionId: string | null;
      seenExpectedCash?: Money;
      note: string | null;
      summarise: (payments: readonly PaymentView[]) => CashTurnSummary;
    },
  ): Promise<CashSessionView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // BI-253. The drawer's lock FIRST: no reversal of this drawer lands
        // between what is read here and the photo written below. A payment
        // may: it is born open, and stays for the next turn.
        await tx.$executeRaw`
          SELECT cash_drawer_lock(${close.siteId}::uuid, ${close.userId}::uuid)`;
        // The instant of the close, read now that the lock is held: what was
        // committed while it waited is not later than it.
        const closedAt = close.clock();
        const previous = await tx.cashSession.findFirst({
          where: { siteId: close.siteId, userId: close.userId },
          orderBy: { closedAt: 'desc' },
          select: { id: true, closedAt: true },
        });
        // BI-252. The turn she saw is still the open one: a second tab or a
        // second click does not close it twice.
        if ((previous?.id ?? null) !== close.seenPreviousSessionId) {
          throw new CashSessionAlreadyClosedError();
        }

        const payments = (
          await tx.payment.findMany({
            // A payment stamped after the close (another API's clock) stays
            // for the next turn instead of making the close fail.
            where: { ...openTurnWhere(close), receivedAt: { lte: closedAt } },
            include: PAYMENT_INCLUDE,
          })
        ).map(toPaymentView);
        if (payments.length === 0) throw new CashSessionEmptyError();
        const summary = close.summarise(payments);
        // BI-255. Under the lock: what she counted against is still what is.
        if (
          close.seenExpectedCash &&
          !close.seenExpectedCash.equals(summary.expectedCash)
        ) {
          throw new CashSessionChangedError();
        }
        const since = previous?.closedAt ?? null;
        const pending = await pendingOf(tx, {
          ...close,
          since,
          until: closedAt,
        });

        const session = await tx.cashSession.create({
          data: {
            siteId: close.siteId,
            userId: close.userId,
            closedAt,
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
        // BI-252. Exactly the payments read under the lock, reversed ones
        // included: the photo says what the turn had.
        await tx.payment.updateMany({
          where: { id: { in: payments.map((payment) => payment.id) } },
          data: { cashSessionId: session.id },
        });
        return toSessionView(session, since);
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
      SELECT SUM(${INVOICE_BALANCE})::text AS "balance"
        FROM "invoice" i
        JOIN "patient_account" a ON a."id" = i."account_id"
       WHERE i."site_id" = ${query.siteId}::uuid
         AND a."patient_id" = ${query.patientId}::uuid
         AND ${INVOICE_CAN_OWE}`;
    return Money.parse(row?.balance ?? '0');
  }
}

async function pendingOf(
  client: Pick<PrismaService, '$queryRaw'>,
  key: CashDrawerKey & { since: Date | null; until: Date },
): Promise<PendingInvoices> {
  // What this cashier issued during the turn, with its balance still owed:
  // derived, as BI-103 asks (`INVOICE_BALANCE`), never stored.
  const [row] = await client.$queryRaw<
    { total: string | null; count: bigint }[]
  >`
    SELECT SUM(b."balance")::text AS "total", COUNT(*) AS "count"
      FROM (
        SELECT ${INVOICE_BALANCE} AS "balance"
          FROM "invoice" i
         WHERE i."site_id" = ${key.siteId}::uuid
           AND i."issued_by_id" = ${key.userId}::uuid
           AND ${INVOICE_CAN_OWE}
           AND (${key.since}::timestamptz IS NULL OR i."issued_at" > ${key.since}::timestamptz)
           AND i."issued_at" <= ${key.until}::timestamptz
      ) AS b
     WHERE b."balance" > 0`;
  return {
    total: Money.parse(row?.total ?? '0'),
    count: Number(row?.count ?? 0),
  };
}

function openTurnWhere(key: CashDrawerKey): Prisma.PaymentWhereInput {
  return {
    siteId: key.siteId,
    receivedById: key.userId,
    cashSessionId: null,
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
    cashSessionId: row.cashSessionId,
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

function toSessionView(
  row: SessionRow,
  previousClosedAt: Date | null,
): CashSessionView {
  const lines: CashLine[] = row.lines.map((line) => ({
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
    previousClosedAt,
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
  // Another close of the same drawer got in first: the turn she saw is gone.
  if (/cash_session_after_the_last/.test(message)) {
    return new CashSessionAlreadyClosedError();
  }
  // The turn moved under the close (a payment the summary did not see): she
  // closes again on what is there now. The rule stays the trigger's.
  if (
    /payment_session_is_its_drawer|cash_session_matches_its_payments/.test(
      message,
    )
  ) {
    return new CashSessionChangedError();
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
  return error;
}
