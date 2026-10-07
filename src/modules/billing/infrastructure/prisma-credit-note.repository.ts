import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import {
  CreditNoteExceedsInvoiceError,
  CreditNoteFinalConsumerError,
  CreditNoteInvoiceNotAuthorisedError,
  CreditNoteLineAlreadyCreditedError,
  CreditNoteLineNotInInvoiceError,
} from '../domain/billing.errors';
import { lineBase, lineTax, totalsOf, type ChargeLine } from '../domain/charge';
import type { CreditNoteReasonCode } from '../domain/credit-note';
import type {
  CreditedInvoice,
  CreditNoteIssuance,
  CreditNoteRepository,
  CreditNoteView,
  IssuedCreditNote,
} from '../domain/credit-note.repository';
import {
  nextSequential,
  type BuyerIdentificationType,
  type InvoiceStatus,
} from '../domain/invoice';
import { Money, Percentage, Quantity } from '../domain/money';

import { databaseMessageOf } from './prisma-billing-account.repository';

const CREDIT_NOTE_INCLUDE = {
  lines: { orderBy: { createdAt: 'asc' } },
  invoice: { select: { sequential: true } },
} satisfies Prisma.CreditNoteInclude;

type CreditNoteRow = Prisma.CreditNoteGetPayload<{
  include: typeof CREDIT_NOTE_INCLUDE;
}>;

/**
 * BI-208 to BI-214. The credit note, and the lines it sends back to the
 * account to be billed again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS LOCKED, AND IN WHICH ORDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. THE INVOICE. Two cashiers correcting it at once read the same «not yet
 *      credited» lines; the lock makes the second one read the first's
 *      result. `trg_credit_note_within_its_invoice` takes the same lock.
 *   2. THE EMISSION POINT, as issuing an invoice does: the credit notes have
 *      their own sequence per point, consecutive and not merely unique.
 *   3. THE ACCOUNT the lines go back to, before it is reopened.
 *
 * Every rule is checked again by the database (`credit_note_*`,
 * `charge_item_one_correction_per_charge`); what this file adds is that a
 * refusal reaches the cashier as the sentence of its own error.
 */
@Injectable()
export class PrismaCreditNoteRepository implements CreditNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findCreditedInvoice(query: {
    invoiceId: string;
    siteId: string;
  }): Promise<CreditedInvoice | null> {
    const row = await this.prisma.invoice.findFirst({
      where: { id: query.invoiceId, siteId: query.siteId },
      select: {
        id: true,
        accountId: true,
        siteId: true,
        status: true,
        isFinalConsumer: true,
        issuedAt: true,
        createdAt: true,
        chargeItems: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, creditNoteLine: { select: { id: true } } },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.accountId,
      siteId: row.siteId,
      status: row.status as InvoiceStatus,
      isFinalConsumer: row.isFinalConsumer,
      issuedOn: clinicalDateOf(row.issuedAt ?? row.createdAt),
      chargeIds: row.chargeItems.map((charge) => charge.id),
      creditedChargeIds: row.chargeItems
        .filter((charge) => charge.creditNoteLine !== null)
        .map((charge) => charge.id),
    };
  }

  async issue(issuance: CreditNoteIssuance): Promise<IssuedCreditNote> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [invoice] = await tx.$queryRaw<
          {
            status: string;
            is_final_consumer: boolean;
            emission_point_id: string;
            account_id: string;
            buyer_identification_type: string;
            buyer_identification: string;
            buyer_name: string;
            buyer_email: string | null;
          }[]
        >`
          SELECT "status", "is_final_consumer", "emission_point_id",
                 "account_id", "buyer_identification_type",
                 "buyer_identification", "buyer_name", "buyer_email"
            FROM "invoice"
           WHERE "id" = ${issuance.invoiceId}::uuid
             AND "site_id" = ${issuance.siteId}::uuid
             FOR UPDATE`;
        // The service checked both before; under the lock, again.
        if (!invoice || invoice.status !== 'AUTHORISED') {
          throw new CreditNoteInvoiceNotAuthorisedError();
        }
        if (invoice.is_final_consumer) throw new CreditNoteFinalConsumerError();

        const charges = await tx.chargeItem.findMany({
          where: { id: { in: [...issuance.chargeIds] } },
          include: {
            billableService: { select: { code: true } },
            creditNoteLine: { select: { id: true } },
          },
          orderBy: { createdAt: 'asc' },
        });
        if (
          charges.length !== issuance.chargeIds.length ||
          charges.some((charge) => charge.invoiceId !== issuance.invoiceId)
        ) {
          throw new CreditNoteLineNotInInvoiceError();
        }
        if (charges.some((charge) => charge.creditNoteLine !== null)) {
          throw new CreditNoteLineAlreadyCreditedError();
        }

        const lines: (ChargeLine & { row: (typeof charges)[number] })[] =
          charges.map((row) => ({
            row,
            quantity: Quantity.parse(row.quantity.toFixed(3)),
            unitAmount: Money.parse(row.unitAmount),
            discountAmount: Money.parse(row.discountAmount),
            taxPercentage:
              row.taxPercentage === null
                ? null
                : Percentage.parse(row.taxPercentage),
          }));
        const totals = totalsOf(lines);

        await tx.$queryRaw`
          SELECT "id" FROM "emission_point"
           WHERE "id" = ${invoice.emission_point_id}::uuid
             FOR UPDATE`;
        const [last] = await tx.$queryRaw<{ sequential: string | null }[]>`
          SELECT max("sequential") AS "sequential"
            FROM "credit_note"
           WHERE "emission_point_id" = ${invoice.emission_point_id}::uuid`;

        const created = await tx.creditNote.create({
          data: {
            invoiceId: issuance.invoiceId,
            siteId: issuance.siteId,
            emissionPointId: invoice.emission_point_id,
            sequential: nextSequential(last?.sequential ?? null),
            reasonCode: issuance.reasonCode,
            reason: issuance.reason,
            // BI-210 (D-152.2). The invoice's receiver, even when it was the
            // error: the SRI checks it against the document it modifies.
            buyerIdentificationType: invoice.buyer_identification_type,
            buyerIdentification: invoice.buyer_identification,
            buyerName: invoice.buyer_name,
            buyerEmail: invoice.buyer_email,
            subtotalTaxed: totals.subtotalTaxed.toString(),
            subtotalUntaxed: totals.subtotalUntaxed.toString(),
            discountTotal: totals.discountTotal.toString(),
            taxTotal: totals.taxTotal.toString(),
            amount: totals.total.toString(),
            status: 'ISSUED',
            issuedById: issuance.issuedById,
            issuedAt: issuance.now,
            lines: {
              create: lines.map((line) => ({
                chargeItemId: line.row.id,
                serviceCode: line.row.billableService.code,
                description: line.row.serviceDisplay,
                quantity: line.row.quantity,
                unitAmount: line.row.unitAmount,
                discountAmount: line.row.discountAmount,
                taxSriCode: line.row.taxSriCode,
                taxPercentage: line.row.taxPercentage,
                netAmount: lineBase(line).toString(),
                taxAmount: lineTax(line).toString(),
              })),
            },
          },
          include: CREDIT_NOTE_INCLUDE,
        });

        let rebilledAccountId: string | null = null;
        if (issuance.rebill) {
          rebilledAccountId = await reopenForRebilling(tx, {
            accountId: invoice.account_id,
            changedById: issuance.issuedById,
            now: issuance.now,
          });
          // BI-214. A new charge per credited line, the same frozen values,
          // naming what it corrects. The original stays BILLED (BI-096).
          await tx.chargeItem.createMany({
            data: charges.map((row) => ({
              accountId: rebilledAccountId!,
              billableServiceId: row.billableServiceId,
              encounterId: row.encounterId,
              origin: 'CORRECTION',
              correctsChargeItemId: row.id,
              serviceDate: row.serviceDate,
              quantity: row.quantity,
              unitAmount: row.unitAmount,
              resolvedPriceId: row.resolvedPriceId,
              serviceDisplay: row.serviceDisplay,
              taxSriCode: row.taxSriCode,
              taxPercentage: row.taxPercentage,
              discountAmount: row.discountAmount,
              discountReason: row.discountReason,
              discountAuthorisedById: row.discountAuthorisedById,
              status: 'BILLABLE',
              createdById: issuance.issuedById,
            })),
          });
        }

        return { creditNote: toCreditNoteView(created), rebilledAccountId };
      });
    } catch (error) {
      throw translateCreditNoteRejection(error);
    }
  }

  async list(query: {
    siteId: string;
    invoiceId?: string;
  }): Promise<CreditNoteView[]> {
    const rows = await this.prisma.creditNote.findMany({
      where: { siteId: query.siteId, invoiceId: query.invoiceId },
      orderBy: [{ issuedAt: 'desc' }, { sequential: 'desc' }],
      take: 500,
      include: CREDIT_NOTE_INCLUDE,
    });
    return rows.map(toCreditNoteView);
  }
}

/**
 * BI-214. Where the credited lines go back to: the invoice's account, reopened
 * if it was settled (stamped, so its previous status is versioned, BI-215).
 * If the visit already has ANOTHER open account
 * (`patient_account_one_open_per_encounter`), they go to that one.
 */
async function reopenForRebilling(
  tx: Prisma.TransactionClient,
  command: { accountId: string; changedById: string; now: Date },
): Promise<string> {
  const [account] = await tx.$queryRaw<
    {
      status: string;
      encounter_id: string | null;
      changed_at: Date | null;
    }[]
  >`
    SELECT "status", "encounter_id", "changed_at"
      FROM "patient_account"
     WHERE "id" = ${command.accountId}::uuid
       FOR UPDATE`;
  if (!account || account.status === 'OPEN') return command.accountId;

  if (account.encounter_id !== null) {
    const open = await tx.patientAccount.findFirst({
      where: { encounterId: account.encounter_id, status: 'OPEN' },
      select: { id: true },
    });
    if (open) return open.id;
  }

  const changedAt =
    account.changed_at && account.changed_at >= command.now
      ? new Date(account.changed_at.getTime() + 1)
      : command.now;
  await tx.patientAccount.update({
    where: { id: command.accountId },
    data: {
      status: 'OPEN',
      closedAt: null,
      changedById: command.changedById,
      changedAt,
    },
  });
  return command.accountId;
}

/** The database's refusals, as the sentences of their own errors. */
export function translateCreditNoteRejection(error: unknown): unknown {
  const message = databaseMessageOf(error);
  if (/credit_note_final_consumer/.test(message)) {
    return new CreditNoteFinalConsumerError();
  }
  if (/credit_note_invoice_not_authorised/.test(message)) {
    return new CreditNoteInvoiceNotAuthorisedError();
  }
  if (/credit_note_exceeds_invoice/.test(message)) {
    return new CreditNoteExceedsInvoiceError();
  }
  if (
    /credit_note_line_one_per_charge|charge_item_one_correction_per_charge/.test(
      message,
    )
  ) {
    return new CreditNoteLineAlreadyCreditedError();
  }
  if (/credit_note_line_not_in_invoice/.test(message)) {
    return new CreditNoteLineNotInInvoiceError();
  }
  return error;
}

function toCreditNoteView(row: CreditNoteRow): CreditNoteView {
  const lines = row.lines.map((line) => ({
    chargeItemId: line.chargeItemId,
    serviceCode: line.serviceCode,
    description: line.description,
    quantity: Quantity.parse(line.quantity.toFixed(3)),
    unitAmount: Money.parse(line.unitAmount),
    discountAmount: Money.parse(line.discountAmount),
    taxSriCode: line.taxSriCode,
    netAmount: Money.parse(line.netAmount),
    taxAmount: Money.parse(line.taxAmount),
  }));
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    siteId: row.siteId,
    emissionPointId: row.emissionPointId,
    sequential: row.sequential,
    accessKey: row.accessKey,
    reasonCode: row.reasonCode as CreditNoteReasonCode,
    reason: row.reason,
    receiver: {
      buyerIdentificationType:
        row.buyerIdentificationType as BuyerIdentificationType,
      buyerIdentification: row.buyerIdentification,
      buyerName: row.buyerName,
      buyerEmail: row.buyerEmail,
      isFinalConsumer: false,
    },
    totals: {
      subtotalTaxed: Money.parse(row.subtotalTaxed),
      subtotalUntaxed: Money.parse(row.subtotalUntaxed),
      discountTotal: Money.parse(row.discountTotal),
      taxTotal: Money.parse(row.taxTotal),
      total: Money.parse(row.amount),
    },
    status: row.status as CreditNoteView['status'],
    issuedAt: row.issuedAt ?? row.createdAt,
    lines,
    invoiceSequential: row.invoice.sequential,
  };
}
