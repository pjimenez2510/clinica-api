import { Injectable } from '@nestjs/common';
import type {
  ChargeItem as ChargeItemRow,
  PatientAccount as PatientAccountRow,
  Prisma,
} from '@prisma/client';
import type { IssuedDocumentFilter } from '../domain/document-search';
import { issuedDocumentWhere } from './document-search.where';

import { invoiceDocumentNumber } from '../../../shared/billing/document-number';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';

import type {
  AccountPatientIdentification,
  AccountStatus,
  AccountView,
  BillingAccountRepository,
  ChargedActs,
  ChargeEdit,
  DiscountWrite,
  ChargeStamp,
  ChargeView,
  InvoiceIssuance,
  InvoiceView,
  NewAccount,
  NewCharge,
  RepricedLine,
} from '../domain/billing.repository';
import {
  AccountClosedError,
  AccountNoChargeReasonRequiredError,
  PaymentMethodInactiveError,
  AccountHasOpenChargesError,
  CorrectionAwaitsCreditNoteError,
  AccountHasBilledChargesError,
  ActAlreadyChargedError,
  ChargeAlreadyInvoicedError,
  ChargeHasDiscountError,
  ChargeNotConfirmedError,
  ChargeAlreadyVoidedError,
  ChargeNotRemovedError,
  InvoiceChargesChangedError,
  InvoiceHasNoItemsError,
  InvoiceImmutableError,
  InvoiceServiceCodeTooLongError,
  PriceNotFoundError,
} from '../domain/billing.errors';
import { MAX_VOUCHER_SERVICE_CODE } from '../domain/invoice';
import {
  PATIENT_IDENTITY_SELECT,
  toPatientIdentity,
} from './patient-identity.select';
import type { ChargeOrigin } from '../domain/charge-proposal';
import {
  type ChargeStatus,
  type DocumentTotals,
  OPEN_CHARGE_STATUSES,
  totalsOf,
} from '../domain/charge';
import {
  type BuyerIdentificationType,
  type FrequentBuyer,
  type InvoiceReceiver,
  type InvoiceStatus,
  type PaymentMethod,
  nextSequential,
} from '../domain/invoice';
import { Money, Percentage, Quantity } from '../domain/money';
import { toClinicalDate } from '../domain/price-list';
import { asDateColumn } from './prisma-billing-catalogue.repository';
import { writeBillingTrail } from './billing-trail.write';
import {
  INVOICE_BALANCE,
  INVOICE_COUNTS_TOWARD_BALANCE,
} from './invoice-balance.sql';
import type { BillingTrail } from '../domain/billing-trail';
import { selfPayPriceListId } from './self-pay-list';

/**
 * The account, the charge and the invoice, in PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO THINGS THIS FILE EXISTS TO GET RIGHT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE FREEZE HAPPENS IN THE SAME TRANSACTION AS THE RESOLUTION (BI-050).
 *    Reading the price in the service and inserting here would leave a window
 *    in which somebody reprices between the two, and the charge would be born
 *    quoting a row that no longer says that amount.
 *
 * 2. THE SEQUENTIAL IS ALLOCATED UNDER THE EMISSION POINT'S ROW LOCK (BI-085,
 *    SC-023). Two cashiers invoicing in the same second is the case the
 *    requirement is about, and `max(sequential) + 1` read outside a lock is
 *    the same number twice. `invoice_sequential_unique` would catch the
 *    collision — as a failed invoice, which is a worse outcome than waiting a
 *    few milliseconds.
 *
 * ⚠️ AND THERE IS NO `updateInvoice` AND NO `deleteInvoice`. Not «there is one
 * and it is guarded»: there is none, which is BI-090 in the one layer that
 * could still spell it. `trg_invoice_immutable` and `trg_invoice_no_delete`
 * say the same thing from underneath, for the writes that never come through
 * here.
 */
@Injectable()
export class PrismaBillingAccountRepository implements BillingAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * BI-070. Opens the account ON THE SURVIVING CHART.
   *
   * ⚠️ D-031, PA-055. Charts merge, and nothing is re-pointed: the absorbed
   * one keeps its rows and the survivor reads them by following the link. That
   * works for what was written BEFORE the merge. An account opened AFTERWARDS
   * on the absorbed chart would be born on a dead record — visible only by
   * following a link nobody follows on the way in — and an unpaid balance that
   * nobody can see is one nobody collects.
   *
   * So the write resolves the link and stores the survivor. It is the same
   * distinction `patient_identifier` makes: a READ follows the link, a WRITE
   * names a live row.
   */
  async openAccount(account: NewAccount): Promise<AccountView> {
    const row = await this.prisma.patientAccount.create({
      data: { ...account, patientId: await this.survivingChart(account.patientId) }, // prettier-ignore
      include: ACCOUNT_INCLUDE,
    });
    return toAccountView(row);
  }

  /**
   * BI-150, BI-274. Two «enviar a caja» of the same visit at the same second
   * both read «no open account» and both insert; the index lets one through
   * and refuses the other. The refused one answers with the winner instead
   * of a 409, so both cashiers land on the same account.
   *
   * If the winner is gone by the time it is read (closed in between), the
   * refusal is the honest answer and goes up untouched.
   */
  async openOrRecoverEncounterAccount(
    account: NewAccount & { encounterId: string },
  ): Promise<AccountView> {
    try {
      return await this.openAccount(account);
    } catch (error) {
      if (!isOpenAccountOfEncounterTaken(error)) throw error;
      const winner = await this.findOpenAccountOfEncounter({
        encounterId: account.encounterId,
        siteId: account.siteId,
      });
      if (winner === null) throw error;
      return winner;
    }
  }

  /**
   * The chart a merged one was absorbed into, or the chart itself.
   *
   * ONE HOP AND NEVER A TREE: `trg_patient_merge_not_chained` refuses A→B→C in
   * both directions (PA-046), so an absorbed chart cannot itself have absorbed
   * one, and walking further would cost every write for a shape the database
   * forbids.
   */
  private async survivingChart(patientId: string): Promise<string> {
    const chart = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { mergedIntoId: true },
    });
    return chart?.mergedIntoId ?? patientId;
  }

  /** BI-135. The site is part of the KEY, not a check afterwards. */
  async findAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView | null> {
    const row = await this.prisma.patientAccount.findFirst({
      where: { id: query.accountId, siteId: query.siteId },
      include: ACCOUNT_INCLUDE,
    });
    return row === null ? null : toAccountView(row);
  }

  /**
   * BI-070, BI-133. The site's accounts, and one chart's THROUGH THE MERGE.
   *
   * ⚠️ `chartScope` AND NOT `where: { patientId }` (PA-055, D-038). When two
   * charts of the same person are merged, nothing is re-pointed: an account of
   * the absorbed chart keeps its `patient_id` there. A bare filter would stop
   * returning it, so an unpaid balance would silently disappear — it would not
   * be collected and nobody would know it existed. It is the shape of PA-009,
   * where a newborn stopped being reachable once the mother's charts merged,
   * and money is the version of it nobody reports as a defect.
   */
  async listAccounts(query: {
    siteId: string;
    patientId?: string;
    status?: AccountStatus;
  }): Promise<AccountView[]> {
    const rows = await this.prisma.patientAccount.findMany({
      where: {
        siteId: query.siteId,
        status: query.status,
        ...(query.patientId === undefined ? {} : chartScope(query.patientId)),
      },
      orderBy: { openedAt: 'desc' },
      include: ACCOUNT_INCLUDE,
    });
    return rows.map(toAccountView);
  }

  /**
   * BI-198. The payer, its list and every OPEN line's price, together.
   *
   * The account row is locked first, so an issuance (which locks it too)
   * either sees the old prices or the new ones, never a mix. A BILLED line
   * refuses the change; a line the new list cannot price throws
   * `PRICE_NOT_FOUND` from inside the transaction, so the payer does not move
   * either. Removed lines keep their price: «Deshacer» reprices them
   * (BI-195). A line whose price row would not change is not touched, so no
   * correction is stamped that corrected nothing.
   *
   * «No se cobra» lines are repriced too: they meant «this costs $0», and a
   * line that costs something under the new payer goes back to PROPOSED, for
   * the cashier to review — never left at $0 without anyone deciding it.
   *
   * ⚠️ THE CHARGES ARE LOCKED HERE, after the account and before reading
   * them. An edit or a restore locks its line and then reads the account's
   * list; without this lock a concurrent edit could get the old service's
   * price written over its new service, or a restore the old payer's price.
   */
  async changeAccountPayer(command: {
    accountId: string;
    payerId: string;
    priceListId: string;
    changedById: string;
    now: Date;
  }): Promise<AccountView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ changed_at: Date | null }[]>`
        SELECT "changed_at" FROM "patient_account"
         WHERE "id" = ${command.accountId}::uuid
           FOR UPDATE`;
      await tx.$queryRaw`
        SELECT "id" FROM "charge_item"
         WHERE "account_id" = ${command.accountId}::uuid
         ORDER BY "id"
           FOR UPDATE`;

      const charges = await tx.chargeItem.findMany({
        where: { accountId: command.accountId },
      });
      if (charges.some((charge) => charge.status === 'BILLED')) {
        throw new AccountHasBilledChargesError();
      }

      for (const charge of charges) {
        if (!isRepriced(charge.status)) continue;
        const price = await findPriceOn(tx, {
          priceListId: command.priceListId,
          payerId: command.payerId,
          serviceId: charge.serviceId,
          serviceDate: charge.serviceDate,
        });
        const reopens =
          charge.status === 'NOT_BILLABLE' && !price.amount.isZero();
        if (price.id === charge.resolvedPriceId && !reopens) continue;
        // BI-244. A discounted line is not repriced behind its discount.
        if (!charge.discountAmount.isZero()) throw new ChargeHasDiscountError();

        await tx.chargeItem.update({
          where: { id: charge.id },
          data: {
            unitAmount: price.amount.toFixed(2),
            resolvedPriceId: price.id,
            ...(reopens ? { status: 'PLANNED' } : {}),
            changedById: command.changedById,
            changedAt: stampAfter(charge.changedAt, command.now),
          },
        });
      }

      return tx.patientAccount.update({
        where: { id: command.accountId },
        data: {
          payerId: command.payerId,
          priceListId: command.priceListId,
          // BI-215: the previous payer is archived by the database.
          changedById: command.changedById,
          changedAt: stampAfter(locked?.changed_at ?? null, command.now),
        },
        include: ACCOUNT_INCLUDE,
      });
    });
    return toAccountView(row);
  }

  /** BI-198. The same resolution as above, read-only, for the confirmation. */
  async previewRepricing(query: {
    accountId: string;
    priceListId: string;
  }): Promise<RepricedLine[]> {
    const charges = await this.prisma.chargeItem.findMany({
      where: {
        accountId: query.accountId,
        status: { in: [...REPRICED_STATUSES] },
      },
      orderBy: { createdAt: 'asc' },
    });

    return Promise.all(
      charges.map(async (charge) => {
        const price = await priceInForce(
          this.prisma,
          query.priceListId,
          charge.serviceId,
          charge.serviceDate,
        );
        return {
          chargeId: charge.id,
          unitAmount: price === null ? null : Money.parse(price.amount),
        };
      }),
    );
  }

  /**
   * BI-071. `patient_account_closed_states_its_instant` ties the status and
   * the instant in both directions, so the two are written together or the
   * row is refused.
   */
  async closeAccount(command: {
    accountId: string;
    closedById: string;
    noChargeReason: string | null;
    now: Date;
  }): Promise<AccountView> {
    const row = await this.prisma.$transaction(async (tx) => {
      // Locked and counted again here: a credit note may have sent charges
      // back between the service's check and this write (review, M-1/I5).
      const [current] = await tx.$queryRaw<
        { status: string; changed_at: Date | null }[]
      >`
        SELECT "status", "changed_at" FROM "patient_account"
         WHERE "id" = ${command.accountId}::uuid
           FOR UPDATE`;
      if (!current || current.status !== 'OPEN') throw new AccountClosedError();
      const open = await tx.chargeItem.findMany({
        where: {
          accountId: command.accountId,
          status: { in: [...OPEN_CHARGE_STATUSES] },
        },
        select: { id: true },
      });
      if (open.length > 0) {
        throw new AccountHasOpenChargesError(open.map((charge) => charge.id));
      }
      // BI-237: with something invoiced there is nothing to explain.
      const billed = await tx.chargeItem.count({
        where: { accountId: command.accountId, status: 'BILLED' },
      });
      if (billed === 0 && command.noChargeReason === null) {
        throw new AccountNoChargeReasonRequiredError();
      }
      // BI-215: closing is a change of the account, stamped and versioned.
      // BI-236: `trg_patient_account_closes_its_encounter` closes the
      // discharged attention in this same transaction, with `closedAt` and
      // the stamp below.
      return tx.patientAccount.update({
        where: { id: command.accountId },
        data: {
          status: 'SETTLED',
          closedAt: command.now,
          noChargeReason: billed === 0 ? command.noChargeReason : null,
          changedById: command.closedById,
          changedAt: stampAfter(current.changed_at, command.now),
        },
        include: ACCOUNT_INCLUDE,
      });
    });
    return toAccountView(row);
  }

  /**
   * BI-074. Every charge of the account, voided ones included, in the order
   * they were raised; which ones count is the caller's filter.
   */
  async listCharges(accountId: string): Promise<ChargeView[]> {
    const rows = await this.prisma.chargeItem.findMany({
      include: CHARGE_INCLUDE,
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toChargeView);
  }

  /**
   * BI-047, BI-050, BI-052. Resolves BY SERVICE DATE and freezes, atomically.
   *
   * ⚠️ THE HALF-OPEN PERIOD IS SPELLED OUT AND NOT DELEGATED TO A `@>`:
   * `validFrom <= date < validTo`, with an open end. It is the same interval
   * `daterange(valid_from, valid_to, '[)')` builds in the generated column, so
   * the query and `price_temporal_unique` agree by construction — and at most
   * one row can match, which is what makes «¿cuánto costaba ese día?»
   * answerable at all.
   */
  async addCharge(command: NewCharge): Promise<ChargeView> {
    const on = asDateColumn(command.serviceDate);

    try {
      return await this.insertCharge(command, on);
    } catch (error) {
      throw translateChargeRejection(error);
    }
  }

  private async insertCharge(
    command: NewCharge,
    on: Date,
  ): Promise<ChargeView> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.patientAccount.findUniqueOrThrow({
        where: { id: command.accountId },
        select: { priceListId: true, payerId: true },
      });

      const service = await tx.service.findUniqueOrThrow({
        where: { id: command.serviceId },
        include: { taxRate: true },
      });

      const price = await priceInForce(
        tx,
        account.priceListId,
        command.serviceId,
        on,
      );

      if (price === null) {
        throw new PriceNotFoundError(
          command.serviceId,
          account.payerId,
          command.serviceDate,
        );
      }

      const row = await tx.chargeItem.create({
        include: CHARGE_INCLUDE,
        data: {
          accountId: command.accountId,
          serviceId: command.serviceId,
          encounterId: command.encounterId,
          serviceDate: on,
          quantity: command.quantity.toString(),
          // BI-153. WHICH CLINICAL ACT THIS LINE CAME FROM, so the cashier
          // reads «de dónde viene» instead of guessing, and so the three
          // partial unique indexes can refuse a second charge for it.
          origin: command.origin,
          encounterProcedureId: command.encounterProcedureId,
          serviceOrderItemId: command.serviceOrderItemId,
          // THE FROZEN BLOCK. Copies, every one of them, and the price row it
          // came from beside them so the resolution is auditable years later.
          unitAmount: price.amount.toFixed(2),
          resolvedPriceId: price.id,
          serviceDisplay: service.name,
          taxSriCode: service.taxRate.sriCode,
          taxPercentage: service.taxRate.percentage?.toFixed(2) ?? null,
          // BI-152. `PLANNED` for what the system derived, `BILLABLE` for what
          // a person typed. `issueInvoice` only ever takes the latter, which
          // is what makes «propone, no impone» structural instead of a habit.
          status: command.status,
          createdById: command.createdById,
        },
      });

      return toChargeView(row);
    });
  }

  /**
   * BI-150. The one OPEN account of a visit.
   *
   * `patient_account_one_open_per_encounter` — partial unique, `WHERE status =
   * 'OPEN' AND encounter_id IS NOT NULL` — makes «findFirst» honest: there
   * cannot be a second row to have picked wrongly. That index is also what
   * turns two cashiers pressing «enviar a caja» at the same second into one
   * account and one rejection, instead of two accounts nobody can reconcile.
   */
  async findOpenAccountOfEncounter(query: {
    encounterId: string;
    siteId: string;
  }): Promise<AccountView | null> {
    const row = await this.prisma.patientAccount.findFirst({
      where: {
        encounterId: query.encounterId,
        siteId: query.siteId,
        status: 'OPEN',
      },
      include: ACCOUNT_INCLUDE,
    });
    return row === null ? null : toAccountView(row);
  }

  /**
   * BI-154, BI-157. Which acts of this visit already have a charge.
   *
   * ⚠️ NO STATUS FILTER, AND THAT IS THE REQUIREMENT. A charge the cashier
   * voided is still a charge for that act: the row stays (BI-055) and holds
   * its slot in the unique index, so the next press must not offer it again.
   * Filtering `CANCELLED` out here would resurrect on the second press exactly
   * the line a person decided not to charge for.
   *
   * ⚠️ AND IT IS SCOPED TO THE VISIT, NOT TO ONE ACCOUNT. An act charged on a
   * previous account of the same visit is charged; asking per account would
   * duplicate it the moment a second account exists.
   */
  async listChargedActs(encounterId: string): Promise<ChargedActs> {
    const rows = await this.prisma.chargeItem.findMany({
      where: { encounterId, origin: { not: 'MANUAL' } },
      select: {
        origin: true,
        encounterProcedureId: true,
        serviceOrderItemId: true,
        status: true,
      },
    });

    return {
      consultation: rows.some((row) => row.origin === 'CONSULTATION'),
      encounterProcedureIds: rows
        .map((row) => row.encounterProcedureId)
        .filter((id): id is string => id !== null),
      liveEncounterProcedureIds: rows
        .filter((row) => row.status !== 'CANCELLED')
        .map((row) => row.encounterProcedureId)
        .filter((id): id is string => id !== null),
      serviceOrderItemIds: rows
        .map((row) => row.serviceOrderItemId)
        .filter((id): id is string => id !== null),
    };
  }

  /** BI-135. The account is part of the KEY, not a check afterwards. */
  async findCharge(query: {
    chargeId: string;
    accountId: string;
  }): Promise<ChargeView | null> {
    const row = await this.prisma.chargeItem.findFirst({
      include: CHARGE_INCLUDE,
      where: { id: query.chargeId, accountId: query.accountId },
    });
    return row === null ? null : toChargeView(row);
  }

  /**
   * BI-152. `PLANNED` → `BILLABLE`, and NOTHING ELSE IS TOUCHED.
   *
   * The frozen block is not rewritten: the amount, the tax and the price row
   * were resolved by the date of the act when the charge was raised, and
   * re-resolving them here is the join to `price` that BI-051 exists to
   * forbid. Confirming is a person accepting a line, not a second pricing.
   *
   * The `where` names the status too, so a row that changed underneath —
   * voided by somebody else while this screen was open — matches nothing and
   * is refused rather than silently revived (BI-059).
   */
  async confirmCharge(chargeId: string): Promise<ChargeView> {
    const row = await this.prisma.chargeItem.update({
      include: CHARGE_INCLUDE,
      where: { id: chargeId, status: 'PLANNED' },
      data: { status: 'BILLABLE' },
    });
    return toChargeView(row);
  }

  /**
   * BI-055, BI-195. The removal, with who and when, and the reason if given.
   *
   * `charge_item_void_states_who_and_when` ties the instant and the author,
   * and `charge_item_void_matches_status` the instant and the status. The
   * stamp is what `trg_charge_item_record_version` demands to archive the
   * previous row — the row «Deshacer» puts back.
   *
   * ⚠️ AND IT IS AN UPDATE, NEVER A DELETE. The row stays, which is what lets
   * an account explain why its total went down.
   */
  async voidCharge(command: {
    chargeId: string;
    voidedById: string;
    reason: string | null;
    now: Date;
    onlyIfStatus?: ChargeStatus;
  }): Promise<ChargeView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockCharge(tx, command.chargeId);
      // BI-243. Under the lock: a line caja confirmed meanwhile is caja's.
      if (command.onlyIfStatus && current.status !== command.onlyIfStatus) {
        return toChargeView(current);
      }
      requireOpen(current.status);

      const row = await tx.chargeItem.update({
        include: CHARGE_INCLUDE,
        where: { id: command.chargeId },
        data: {
          status: 'CANCELLED',
          voidedAt: command.now,
          voidedById: command.voidedById,
          voidReason: command.reason,
          // BI-244. A removed line takes its discount with it: «Deshacer»
          // reprices it, and a discount granted on yesterday's price would
          // not be the one that was authorised. The version keeps it.
          ...(current.discountAmount.isZero() ? {} : NO_DISCOUNT),
          changedById: command.voidedById,
          changedAt: stampAfter(current.changedAt, command.now),
        },
      });
      return toChargeView(row);
    });
  }

  /** BI-203. One row at most, by `charge_item_one_consultation_per_encounter`. */
  async findConsultationCharge(
    encounterId: string,
  ): Promise<ChargeView | null> {
    const row = await this.prisma.chargeItem.findFirst({
      include: CHARGE_INCLUDE,
      where: { encounterId, origin: 'CONSULTATION' },
    });
    return row === null ? null : toChargeView(row);
  }

  /** BI-240 to BI-243. At most one, by `charge_item_one_per_encounter_procedure`. */
  async findProcedureCharge(
    encounterProcedureId: string,
  ): Promise<ChargeView | null> {
    const row = await this.prisma.chargeItem.findFirst({
      include: CHARGE_INCLUDE,
      where: { encounterProcedureId, origin: 'PROCEDURE' },
    });
    return row === null ? null : toChargeView(row);
  }

  /** BI-196. The amount was checked by the service: this only moves status. */
  async markNotBillable(command: ChargeStamp): Promise<ChargeView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockCharge(tx, command.chargeId);
      requireOpen(current.status);

      const row = await tx.chargeItem.update({
        include: CHARGE_INCLUDE,
        where: { id: command.chargeId },
        data: {
          status: 'NOT_BILLABLE',
          changedById: command.changedById,
          changedAt: stampAfter(current.changedAt, command.now),
        },
      });
      return toChargeView(row);
    });
  }

  /**
   * BI-195, BI-196. «Deshacer».
   *
   * The status it goes back to is the one the database archived before the
   * removal (`record_version`).
   *
   * ⚠️ ONLY A REMOVAL WITH A VERSION IS UNDONE. A line voided before this
   * delivery was corrected the old way —void it and add another (BI-059)—,
   * so reviving it would charge the same service twice.
   *
   * ⚠️ IT IS REPRICED from the account's list as it is NOW. The payer may
   * have changed while the line was out (BI-198), and a line that came back
   * at the old payer's price would leave an account with two tariffs.
   */
  async restoreCharge(command: ChargeStamp): Promise<ChargeView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockCharge(tx, command.chargeId);
      if (current.status !== 'CANCELLED' && current.status !== 'NOT_BILLABLE') {
        throw new ChargeNotRemovedError();
      }

      const archived = await tx.$queryRaw<{ status: string }[]>`
        SELECT "data" ->> 'status' AS "status"
          FROM "record_version"
         WHERE "resource_type" = 'charge_item'
           AND "resource_id" = ${command.chargeId}::uuid
           AND "data" ->> 'status' IN ('PLANNED', 'BILLABLE')
         ORDER BY "version" DESC
         LIMIT 1`;
      const status = archived[0]?.status;
      if (status === undefined) throw new ChargeNotRemovedError();

      const account = await tx.patientAccount.findUniqueOrThrow({
        where: { id: current.accountId },
        select: { priceListId: true, payerId: true },
      });
      const price = await findPriceOn(tx, {
        ...account,
        serviceId: current.serviceId,
        serviceDate: current.serviceDate,
      });

      const row = await tx.chargeItem.update({
        include: CHARGE_INCLUDE,
        where: { id: command.chargeId },
        data: {
          status,
          voidedAt: null,
          voidedById: null,
          voidReason: null,
          unitAmount: price.amount.toFixed(2),
          resolvedPriceId: price.id,
          changedById: command.changedById,
          changedAt: stampAfter(current.changedAt, command.now),
        },
      });
      return toChargeView(row);
    });
  }

  /**
   * BI-197. In place, while the line is open.
   *
   * A new service or date is a new resolution: price, tax and name are
   * frozen again from the account's list on the (new) service date, in this
   * transaction — the same block `insertCharge` writes. A new quantity alone
   * moves no price. The status is NOT touched: editing a proposal does not
   * confirm it.
   */
  async editCharge(command: ChargeEdit): Promise<ChargeView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await lockCharge(tx, command.chargeId);
        // BI-243. Under the lock: a line caja confirmed meanwhile is caja's.
        if (command.onlyIfStatus && current.status !== command.onlyIfStatus) {
          return toChargeView(current);
        }
        requireOpen(current.status);

        const serviceId = command.serviceId ?? current.serviceId;
        const serviceDate =
          command.serviceDate === undefined
            ? current.serviceDate
            : asDateColumn(command.serviceDate);
        const reresolve =
          serviceId !== current.serviceId ||
          serviceDate.getTime() !== current.serviceDate.getTime();
        const quantity = command.quantity?.toString();

        if (
          !reresolve &&
          (quantity === undefined || current.quantity.equals(quantity))
        ) {
          return toChargeView(current);
        }
        // BI-244. Under the lock: the discount is in dollars and the ceiling
        // a percentage, so the line keeps its amount while it carries one.
        if (!current.discountAmount.isZero())
          throw new ChargeHasDiscountError();

        const data: Prisma.ChargeItemUncheckedUpdateInput = {
          ...(quantity === undefined ? {} : { quantity }),
          changedById: command.changedById,
          changedAt: stampAfter(current.changedAt, command.now),
        };

        if (reresolve) {
          const account = await tx.patientAccount.findUniqueOrThrow({
            where: { id: current.accountId },
            select: { priceListId: true, payerId: true },
          });
          const service = await tx.service.findUniqueOrThrow({
            where: { id: serviceId },
            include: { taxRate: true },
          });
          const price = await findPriceOn(tx, {
            ...account,
            serviceId,
            serviceDate,
          });
          Object.assign(data, {
            serviceId,
            serviceDate,
            unitAmount: price.amount.toFixed(2),
            resolvedPriceId: price.id,
            serviceDisplay: service.name,
            taxSriCode: service.taxRate.sriCode,
            taxPercentage: service.taxRate.percentage?.toFixed(2) ?? null,
          });
        }

        const row = await tx.chargeItem.update({
          include: CHARGE_INCLUDE,
          where: { id: command.chargeId },
          data,
        });
        return toChargeView(row);
      });
    } catch (error) {
      throw translateChargeRejection(error);
    }
  }

  /**
   * BI-060 to BI-066, BI-246. One discount act, decided under the row lock.
   *
   * EVERY ACT CARRIES A NEW `discount_applied_at`, removal included: it is
   * what `trg_charge_item_discount_is_permanent` reads as «a new act and not
   * an edit», and what makes `record_version` keep the one it replaces.
   */
  async applyDiscount(command: DiscountWrite): Promise<ChargeView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockCharge(tx, command.chargeId);
      requireOpen(current.status);
      if (current.status === 'PLANNED') throw new ChargeNotConfirmedError();

      const { amount, authorisedById } = command.decide(toChargeView(current));
      if (amount.isZero() && Money.parse(current.discountAmount).isZero()) {
        return toChargeView(current);
      }

      const stamp = stampAfter(current.changedAt, command.now);
      const appliedAt = stampAfter(current.discountAppliedAt, command.now);
      const row = await tx.chargeItem.update({
        where: { id: command.chargeId },
        include: CHARGE_INCLUDE,
        data: amount.isZero()
          ? {
              ...NO_DISCOUNT,
              changedById: command.changedById,
              changedAt: stamp,
            }
          : {
              discountAmount: amount.toString(),
              discountReason: command.reason,
              discountAppliedById: command.changedById,
              discountAppliedAt: appliedAt,
              discountAuthorisedById: authorisedById,
              discountAuthorisedAt: authorisedById === null ? null : appliedAt,
              changedById: command.changedById,
              changedAt: stamp,
            },
      });
      return toChargeView(row);
    });
  }

  /** BI-062. One ceiling per role the user holds here; none is zero. */
  async discountCeilings(query: {
    userId: string;
    siteId: string;
  }): Promise<Percentage[]> {
    const grants = await this.prisma.userRoleGrant.findMany({
      where: activeGrantAt(query),
      select: { role: { select: { discountLimit: { select: { maxDiscountPercentage: true } } } } }, // prettier-ignore
    });
    return grants.flatMap((grant) =>
      grant.role.discountLimit
        ? [Percentage.parse(grant.role.discountLimit.maxDiscountPercentage)]
        : [],
    );
  }

  /**
   * BI-063. Revoked grants, inactive roles and inactive accounts are filtered
   * IN THE QUERY, as agenda's `authoriserPermissions` does: someone who left
   * the clinic cannot be named as today's authoriser.
   */
  async permissionsAt(query: {
    userId: string;
    siteId: string;
  }): Promise<readonly string[]> {
    const grants = await this.prisma.userRoleGrant.findMany({
      where: activeGrantAt(query),
      select: { role: { select: { permissions: { select: { permissionCode: true } } } } }, // prettier-ignore
    });
    return [
      ...new Set(
        grants.flatMap((grant) =>
          grant.role.permissions.map((held) => held.permissionCode),
        ),
      ),
    ];
  }

  /** BI-245. Who the cashier can ask, by name, never herself (BI-064). */
  async discountAuthorisers(query: {
    siteId: string;
    permission: string;
    exceptUserId: string;
  }): Promise<{ userId: string; name: string }[]> {
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: query.exceptUserId },
        active: true,
        roleGrants: {
          some: {
            revokedAt: null,
            OR: [{ siteId: query.siteId }, { siteId: null }],
            role: {
              active: true,
              permissions: { some: { permissionCode: query.permission } },
            },
          },
        },
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return users.map((user) => ({
      userId: user.id,
      name: `${user.firstName} ${user.lastName}`,
    }));
  }

  /**
   * BI-082. The patient's OFFICIAL identifier, and nothing else about them.
   *
   * ⚠️ READ THROUGH THIS MODULE'S OWN ADAPTER AND NOT BY IMPORTING
   * `modules/patients`. No module imports another; billing declares the two
   * fields it needs and answers them itself, exactly as `agenda` does for the
   * merge state of a chart.
   *
   * ⚠️ AND IT FOLLOWS THE MERGE FORWARDS, WHICH IS THE OPPOSITE DIRECTION FROM
   * `listAccounts`. A listing asks «what happened to this person» and reaches
   * back into the absorbed charts (`chartScope`). This asks «who is this
   * invoice made out to», and the answer is a LIVING chart: the identifiers of
   * an absorbed one were consolidated into the survivor inside the merge
   * transaction (PA-043) and are marked `patient_merged`, so reading them here
   * would put on the invoice a number that no longer identifies anybody — and
   * the SRI would attribute the expense to nobody.
   */
  async findAccountPatient(
    accountId: string,
  ): Promise<AccountPatientIdentification | null> {
    const chart = {
      familyName: true,
      secondFamilyName: true,
      givenName: true,
      secondGivenName: true,
      email: true,
      identifiers: {
        where: { use: 'OFFICIAL', patientMerged: false } as const,
        orderBy: { createdAt: 'asc' } as const,
        take: 1,
        select: { type: true, issuingCountry: true, value: true },
      },
    } as const;

    const account = await this.prisma.patientAccount.findUnique({
      where: { id: accountId },
      select: {
        patientId: true,
        patient: {
          select: {
            ...chart,
            mergedIntoId: true,
            // One hop and never a tree: `trg_patient_merge_not_chained`
            // refuses A→B→C in both directions (PA-046).
            mergedInto: { select: { id: true, ...chart } },
          },
        },
      },
    });

    if (account === null) return null;

    const living = account.patient.mergedInto ?? account.patient;
    const identifier = living.identifiers[0] ?? null;
    const family = [living.familyName, living.secondFamilyName]
      .filter((part): part is string => part !== null && part !== '')
      .join(' ');
    const given = [living.givenName, living.secondGivenName]
      .filter((part): part is string => part !== null && part !== '')
      .join(' ');

    return {
      patientId: account.patient.mergedIntoId ?? account.patientId,
      identifierType: identifier?.type ?? null,
      identifierIssuingCountry: identifier?.issuingCountry ?? null,
      identifierValue: identifier?.value ?? null,
      // Filing order, which is how it is printed on the document.
      fullName: `${family}, ${given}`,
      // BI-270. The LIVING chart's, like the identifier: an absorbed chart's
      // e-mail is a datum the merge already decided against.
      email: living.email,
    };
  }

  /**
   * BI-271. Read through `chartScope`: an invoice of an absorbed chart keeps
   * its account there (D-031), and its buyer is still this person's habit.
   * ISSUED and AUTHORISED only — a voided or returned invoice is, most often,
   * the wrong receiver being undone.
   */
  async recentInvoiceReceivers(query: {
    chartId: string;
    siteId: string;
    limit: number;
  }): Promise<FrequentBuyer[]> {
    const rows = await this.prisma.invoice.findMany({
      where: {
        siteId: query.siteId,
        status: { in: ['ISSUED', 'AUTHORISED'] },
        isFinalConsumer: false,
        account: chartScope(query.chartId),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: {
        buyerIdentificationType: true,
        buyerIdentification: true,
        buyerName: true,
        buyerEmail: true,
      },
    });
    return rows.map((row) => ({
      identificationType: row.buyerIdentificationType as BuyerIdentificationType, // prettier-ignore
      identification: row.buyerIdentification,
      name: row.buyerName,
      email: row.buyerEmail,
    }));
  }

  async findEmissionPoint(query: {
    emissionPointId: string;
    siteId: string;
  }): Promise<{ id: string; code: string; active: boolean } | null> {
    return this.prisma.emissionPoint.findFirst({
      where: { id: query.emissionPointId, siteId: query.siteId },
      select: { id: true, code: true, active: true },
    });
  }

  /**
   * BI-085, BI-086, BI-088, BI-089. The issuance, as ONE transaction.
   *
   * The order inside it is not arbitrary:
   *
   *   1. LOCK the emission point. Everything after it is serialised per point,
   *      which is what makes the sequentials consecutive under two cashiers
   *      (SC-023) instead of merely unique.
   *   2. Read the charges that are still `BILLABLE`. This is also BI-088:
   *      whatever a previous invoice took is already `BILLED` and no longer
   *      here, so the same charge cannot land on two live invoices.
   *   3. Compose the totals FROM THE FROZEN COLUMNS (BI-086, BI-051). No join
   *      to `price`, to `billable_service` or to `tax_rate` — the amounts on
   *      the document are the ones that were agreed on the day of service, and
   *      a rate raised since must not reach them.
   *   4. Insert, and move the charges to `BILLED` in the same breath.
   *
   * `invoice_total_is_consistent` re-checks step 3 in the database. If the
   * arithmetic here ever disagreed with it, the correct outcome is that NO
   * invoice exists — a document the SRI rejects could never be corrected
   * afterwards (D-A-007).
   */
  async issueInvoice(issuance: InvoiceIssuance): Promise<InvoiceView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "emission_point"
           WHERE "id" = ${issuance.emissionPointId}::uuid
             FOR UPDATE`;

        // The account too: two issuances of the same account through two
        // emission points would otherwise read the same pending charges, and
        // the second would take the lines of the first.
        await tx.$queryRaw`
          SELECT "id" FROM "patient_account"
           WHERE "id" = ${issuance.accountId}::uuid
             FOR UPDATE`;

        // And the pending charges themselves: an annulment or a confirmation
        // in flight waits for this issuance, or this one reads its result —
        // never half of it (BI-184).
        await tx.$queryRaw`
          SELECT "id" FROM "charge_item"
           WHERE "account_id" = ${issuance.accountId}::uuid
             AND "status" = 'BILLABLE'
             FOR UPDATE`;

        const charges = await tx.chargeItem.findMany({
          where: { accountId: issuance.accountId, status: 'BILLABLE' },
          orderBy: { createdAt: 'asc' },
          include: { service: { select: { code: true, name: true } } },
        });

        if (charges.length === 0) throw new InvoiceHasNoItemsError();
        // BI-184. Exactly what the cashier saw, or nothing.
        if (
          issuance.expectedChargeIds !== undefined &&
          !sameIds(
            issuance.expectedChargeIds,
            charges.map((row) => row.id),
          )
        ) {
          throw new InvoiceChargesChangedError();
        }

        // BI-171. Before the sequential is taken.
        const tooLong = charges.find(
          (charge) => charge.service.code.length > MAX_VOUCHER_SERVICE_CODE,
        );
        if (tooLong) {
          throw new InvoiceServiceCodeTooLongError(
            tooLong.service.name,
            tooLong.service.code,
          );
        }

        const totals = totalsOf(
          charges.map((row) => {
            const charge = toChargeView(row);
            return {
              quantity: charge.quantity,
              unitAmount: charge.unitAmount,
              discountAmount: charge.discountAmount,
              taxPercentage: charge.taxPercentage,
            };
          }),
        );

        // BI-184, BI-197. Since a pending line can be EDITED in place, the
        // same ids no longer mean the same amount: the total the cashier was
        // shown has to match too.
        if (
          issuance.expectedTotal !== undefined &&
          !totals.total.equals(issuance.expectedTotal)
        ) {
          throw new InvoiceChargesChangedError();
        }

        const [last] = await tx.$queryRaw<{ sequential: string | null }[]>`
          SELECT max("sequential") AS "sequential"
            FROM "invoice"
           WHERE "emission_point_id" = ${issuance.emissionPointId}::uuid`;

        const invoice = await tx.invoice.create({
          include: INVOICE_NUMBER_INCLUDE,
          data: {
            accountId: issuance.accountId,
            siteId: issuance.siteId,
            emissionPointId: issuance.emissionPointId,
            sequential: nextSequential(last?.sequential ?? null),
            buyerIdentificationType: issuance.receiver.buyerIdentificationType,
            buyerIdentification: issuance.receiver.buyerIdentification,
            buyerName: issuance.receiver.buyerName,
            buyerEmail: issuance.receiver.buyerEmail,
            isFinalConsumer: issuance.receiver.isFinalConsumer,
            // BI-170. Declared by the cashier; the base refuses another code.
            paymentMethod: issuance.paymentMethod,
            subtotalTaxed: totals.subtotalTaxed.toString(),
            subtotalUntaxed: totals.subtotalUntaxed.toString(),
            discountTotal: totals.discountTotal.toString(),
            taxTotal: totals.taxTotal.toString(),
            total: totals.total.toString(),
            /**
             * BORN `ISSUED`, NEVER `DRAFT`. A draft an operator can go back
             * and change is «editar factura» arriving through the back door
             * (D-A-007); the document either exists with its number or it does
             * not exist. `AUTHORISED` is the SRI's word and Fase 2's job.
             */
            status: 'ISSUED',
            issuedAt: new Date(),
            issuedById: issuance.issuedById,
          },
        });

        // BI-273. The entry commits with the invoice: written before the
        // charges are billed and the payment taken, so a refusal of either
        // undoes it too.
        await writeBillingTrail(tx, {
          resourceType: 'invoice',
          resourceId: invoice.id,
          action: 'CREATE',
          trail: issuance.trail,
        });

        // BI-169. Each charge names the invoice that took it, in the same
        // statement that bills it (`charge_item_billed_carries_its_invoice`):
        // the voucher's lines are read through it.
        const billed = await tx.chargeItem.updateMany({
          where: {
            id: { in: charges.map((charge) => charge.id) },
            status: 'BILLABLE',
          },
          data: { status: 'BILLED', invoiceId: invoice.id },
        });
        // The total above counted every one of them: if any changed after all,
        // nothing is issued rather than an invoice that does not add up.
        if (billed.count !== charges.length) {
          throw new InvoiceChargesChangedError();
        }

        // BI-247. Collected at the desk: the payment of the whole total, in
        // the same transaction, so an invoice is never «cobrada» on the
        // screen and owed in the database. `trg_payment_guard` still checks
        // the method and the balance; it goes into the cashier's open turn.
        // A $0.00 invoice has nothing to collect.
        if (issuance.payment && totals.total.isGreaterThan(Money.ZERO)) {
          await tx.payment.create({
            data: {
              invoiceId: invoice.id,
              siteId: issuance.siteId,
              paymentMethodId: issuance.payment.paymentMethodId,
              amount: totals.total.toString(),
              reference: issuance.payment.reference,
              receivedAt: issuance.payment.receivedAt,
              receivedById: issuance.issuedById,
              // BI-250. Replaced by the trigger with the Guayaquil date.
              cashDate: issuance.payment.receivedAt,
            },
          });
        }

        return toInvoiceView(
          await tx.invoice.findUniqueOrThrow({
            where: { id: invoice.id },
            include: INVOICE_NUMBER_INCLUDE,
          }),
        );
      });
    } catch (error) {
      throw translateInvoiceRejection(error);
    }
  }

  async findInvoice(query: {
    invoiceId: string;
    siteId: string;
  }): Promise<InvoiceView | null> {
    const row = await this.prisma.invoice.findFirst({
      where: { id: query.invoiceId, siteId: query.siteId },
      include: INVOICE_NUMBER_INCLUDE,
    });
    return row === null ? null : toInvoiceView(row);
  }

  async correctRejectedInvoice(correction: {
    invoiceId: string;
    siteId: string;
    receiver: InvoiceReceiver;
    paymentMethod: PaymentMethod;
    changedById: string;
    now: Date;
    trail: BillingTrail;
  }): Promise<InvoiceView | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ changed_at: Date | null }[]>`
          SELECT "changed_at" FROM "invoice"
           WHERE "id" = ${correction.invoiceId}::uuid
             AND "site_id" = ${correction.siteId}::uuid
             AND "status" = 'REJECTED'
             FOR UPDATE`;
        if (!locked) return null;
        const row = await tx.invoice.update({
          where: { id: correction.invoiceId },
          include: INVOICE_NUMBER_INCLUDE,
          data: {
            buyerIdentificationType:
              correction.receiver.buyerIdentificationType,
            buyerIdentification: correction.receiver.buyerIdentification,
            buyerName: correction.receiver.buyerName,
            buyerEmail: correction.receiver.buyerEmail,
            isFinalConsumer: correction.receiver.isFinalConsumer,
            paymentMethod: correction.paymentMethod,
            // BI-217: the previous receiver is archived by the database.
            changedById: correction.changedById,
            changedAt: stampAfter(locked.changed_at, correction.now),
          },
        });
        // BI-273. Who corrected the receiver, with the correction.
        await writeBillingTrail(tx, {
          resourceType: 'invoice',
          resourceId: row.id,
          action: 'UPDATE',
          trail: correction.trail,
        });
        return toInvoiceView(row);
      });
    } catch (error) {
      throw translateInvoiceRejection(error);
    }
  }

  async listInvoices(query: {
    siteId: string;
    accountId?: string;
    filter: IssuedDocumentFilter;
    owed?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ items: InvoiceView[]; total: number }> {
    const issued = issuedDocumentWhere(query.filter);
    const where: Prisma.InvoiceWhereInput = {
      siteId: query.siteId,
      accountId: query.accountId,
      ...issued,
      ...(query.owed
        ? {
            id: {
              in: await this.owedInvoiceIds({
                siteId: query.siteId,
                accountId: query.accountId ?? null,
                issuedFrom: issued.issuedAt?.gte ?? null,
                issuedBefore: issued.issuedAt?.lt ?? null,
              }),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: INVOICE_NUMBER_INCLUDE,
        // BI-233: by issue, newest first; sequentials of two emission points
        // interleave, so they only break ties. A draft has no date: last.
        orderBy: [
          { issuedAt: { sort: 'desc', nulls: 'last' } },
          { sequential: 'desc' },
          { id: 'desc' },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { items: rows.map(toInvoiceView), total };
  }

  /**
   * BI-259. The site's invoices still owed: the balance derived as BI-103
   * asks —`INVOICE_BALANCE`, the same one `pendingOf` and the patient's
   * balance use—, never stored. A credited-in-excess one (money in the patient's favour) is not
   * owed. The ids go back into the paged query, so the other filters, the
   * order and the count stay the ones of BI-233.
   *
   * Bounded by the account and the days asked for, so only «Con saldo» of
   * every day reads all the site's owed ones: what a clinic is owed at once
   * (hundreds), far below what one `IN` carries.
   */
  private async owedInvoiceIds(bounds: {
    siteId: string;
    accountId: string | null;
    issuedFrom: Date | null;
    issuedBefore: Date | null;
  }): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i."id"
        FROM "invoice" i
       WHERE i."site_id" = ${bounds.siteId}::uuid
         AND (${bounds.accountId}::uuid IS NULL OR i."account_id" = ${bounds.accountId}::uuid)
         AND (${bounds.issuedFrom}::timestamptz IS NULL OR i."issued_at" >= ${bounds.issuedFrom}::timestamptz)
         AND (${bounds.issuedBefore}::timestamptz IS NULL OR i."issued_at" < ${bounds.issuedBefore}::timestamptz)
         AND ${INVOICE_COUNTS_TOWARD_BALANCE}
         AND ${INVOICE_BALANCE} > 0`;
    return rows.map((row) => row.id);
  }
}

/**
 * BI-154. The three partial unique indexes, as a sentence.
 *
 * ⚠️ THIS IS NOT A SECOND COPY OF THE RULE. The rule is the index, and it
 * still refuses an import and a `psql`; what this decides is what the
 * rejection MEANS. The checkout turns it into a line reported as already
 * charged — a race that resolved itself correctly is not an incident — and a
 * caller that reached it any other way gets a 409 that says so.
 *
 * They arrive as Prisma's `P2002` with the index name in `meta.target`, which
 * is why the names are matched textually: they are the same strings the
 * migration writes and `check-migrations.mts` protects.
 */
export function translateChargeRejection(error: unknown): unknown {
  const message = JSON.stringify(
    (error as { meta?: unknown })?.meta ?? '',
  ).concat(databaseMessageOf(error));

  return /charge_item_one_(per_encounter_procedure|per_service_order_item|consultation_per_encounter)/.test(
    message,
  )
    ? new ActAlreadyChargedError()
    : error;
}

/**
 * BI-274. Whether this is `patient_account_one_open_per_encounter` refusing
 * a second open account of the visit — matched by name, like
 * `translateChargeRejection`, since it arrives as a `P2002` naming the index.
 */
function isOpenAccountOfEncounterTaken(error: unknown): boolean {
  return /patient_account_one_open_per_encounter/.test(
    JSON.stringify((error as { meta?: unknown })?.meta ?? '').concat(
      databaseMessageOf(error),
    ),
  );
}

/**
 * Which refusal the invoice triggers raised, or the original error.
 *
 * ⚠️ NOT A SECOND COPY OF THE RULE. The rule is `trg_invoice_immutable` and
 * `trg_invoice_no_delete`, and both still refuse an import and a `psql`. What
 * this decides is only what the rejection MEANS to whoever is at the desk —
 * and it matters more here than anywhere else in this system, because the
 * untranslated answer is a 500 and the person reading it would go looking for
 * an «editar factura» button that does not exist and never will (BI-090).
 *
 * They arrive by SQLSTATE and WITHOUT A NAME: PL/pgSQL emits no «violates
 * check constraint "…"» clause, so `constraint-meanings.ts` has nothing to
 * look up. The sentence each one raises is what tells them apart — the same
 * resolution `agenda` used for the three waiting-list refusals and `patients`
 * for `trg_patient_merge_not_chained`.
 */
export function translateInvoiceRejection(error: unknown): unknown {
  const message = databaseMessageOf(error);

  if (/invoice_authorised_is_immutable/.test(message)) {
    return new InvoiceImmutableError(
      'An authorised invoice cannot be modified',
    );
  }
  if (/invoice_voided_is_final/.test(message)) {
    return new InvoiceImmutableError('A voided invoice does not come back');
  }
  // C1 (D-152.7): what a credit note credited waits for its authorisation.
  if (/charge_item_correction_awaits_credit_note/.test(message)) {
    return new CorrectionAwaitsCreditNoteError();
  }
  if (/invoice_is_never_deleted/.test(message)) {
    return new InvoiceImmutableError('An invoice is never deleted');
  }
  // BI-247. The payment written with the issuance: its method was switched
  // off meanwhile. A closed cash turn no longer refuses it (BI-104).
  if (/payment_method_inactive/.test(message)) {
    return new PaymentMethodInactiveError();
  }
  return error;
}

/**
 * Everything PostgreSQL said, from both layers.
 *
 * ⚠️ NEITHER `detail` NOR THE FAILING ROW IS EVER READ. That is where the
 * buyer's identification is, and it is personal data that must not reach a log
 * (BI-007) — the same warning `database-problem.ts` carries at its head.
 */
export function databaseMessageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';

  const candidate = error as {
    message?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } };
  };

  const parts: string[] = [];
  if (typeof candidate.message === 'string') parts.push(candidate.message);
  const original = candidate.meta?.driverAdapterError?.cause?.originalMessage;
  if (typeof original === 'string') parts.push(original);

  return parts.join('\n');
}

/** BI-183. Every account read carries who it is for, by projection. */
const ACCOUNT_INCLUDE = {
  patient: { select: PATIENT_IDENTITY_SELECT },
} satisfies Prisma.PatientAccountInclude;

type AccountRow = PatientAccountRow & {
  patient: Prisma.PatientGetPayload<{ select: typeof PATIENT_IDENTITY_SELECT }>;
};

/**
 * Row to view. The `status` cast leans on `patient_account_status_is_known`.
 */
function toAccountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    siteId: row.siteId,
    patientId: row.patientId,
    patient: toPatientIdentity(row.patient),
    encounterId: row.encounterId,
    payerId: row.payerId,
    priceListId: row.priceListId,
    status: row.status as AccountStatus,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    noChargeReason: row.noChargeReason,
  };
}

/**
 * Row to view, every amount through `Money`/`Percentage`/`Quantity` parsing.
 * The quantity is rendered at its column's three decimals first; the string
 * casts lean on `charge_item_status_is_known` and
 * `charge_item_origin_is_known`.
 */
type Transaction = Prisma.TransactionClient;

/**
 * BI-195 to BI-198. The row, locked: two cashiers correcting the same line
 * queue here instead of both reading the same stamp — the second would carry
 * an equal instant and `record_version_change_is_stamped` would refuse it.
 */
async function lockCharge(
  tx: Transaction,
  chargeId: string,
): Promise<ChargeItemWithNames> {
  await tx.$queryRaw`
    SELECT "id" FROM "charge_item"
     WHERE "id" = ${chargeId}::uuid
       FOR UPDATE`;
  return tx.chargeItem.findUniqueOrThrow({
    where: { id: chargeId },
    include: CHARGE_INCLUDE,
  });
}

function isOpen(status: string): boolean {
  return (OPEN_CHARGE_STATUSES as readonly string[]).includes(status);
}

/** BI-244. What removing a discount writes: the amount and every stamp. */
const NO_DISCOUNT = {
  discountAmount: '0',
  discountReason: null,
  discountAppliedById: null,
  discountAppliedAt: null,
  discountAuthorisedById: null,
  discountAuthorisedAt: null,
} as const;

/** BI-062, BI-063. A live grant of a live role of a live account, here. */
function activeGrantAt(query: {
  userId: string;
  siteId: string;
}): Prisma.UserRoleGrantWhereInput {
  return {
    userId: query.userId,
    revokedAt: null,
    user: { active: true },
    role: { active: true },
    // AU-011: `siteId: null` is a grant everywhere.
    OR: [{ siteId: query.siteId }, { siteId: null }],
  };
}

/** BI-198. What a payer change reprices: the open lines and the $0 ones. */
const REPRICED_STATUSES = [...OPEN_CHARGE_STATUSES, 'NOT_BILLABLE'] as const;

function isRepriced(status: string): boolean {
  return (REPRICED_STATUSES as readonly string[]).includes(status);
}

/** BI-056, BI-059. What a correction of a line that left review says. */
function requireOpen(status: string): void {
  if (status === 'BILLED') throw new ChargeAlreadyInvoicedError();
  if (!isOpen(status)) throw new ChargeAlreadyVoidedError();
}

/** BI-047. The half-open validity, spelled out as in `insertCharge`. */
function priceOn(
  priceListId: string,
  serviceId: string,
  on: Date,
): Prisma.PriceWhereInput {
  return {
    priceListId,
    serviceId,
    validFrom: { lte: on },
    OR: [{ validTo: null }, { validTo: { gt: on } }],
  };
}

/**
 * BI-047, BI-297 (ADR-013). The price of a service on a day, for a list: its
 * own row in force, or —when the list is a company agreement's or a private
 * insurer's and does not price it— the self-pay list's. «Un convenio guarda excepciones» sobre el
 * particular: what it does not list, it charges at the self-pay price, and
 * `resolvedPriceId` keeps WHICH row that was, so the resolution stays
 * auditable. Neither in force → `null`, the caller's `PRICE_NOT_FOUND`.
 */
async function priceInForce(
  client: Prisma.TransactionClient,
  priceListId: string,
  serviceId: string,
  on: Date,
) {
  const own = await client.price.findFirst({
    where: priceOn(priceListId, serviceId, on),
  });
  if (own !== null) return own;
  const list = await client.priceList.findUnique({
    where: { id: priceListId },
    select: { payer: { select: { kind: true } } },
  });
  // D-230. The public network settles by the SNS tariff: a self-pay amount on
  // its claim is a figure it never agreed to. Only agreements and insurers
  // fall back; the public network without its own price is refused.
  if (!list || !INHERITS_SELF_PAY.has(list.payer.kind)) return null;
  const selfPay = await selfPayPriceListId(client);
  if (selfPay === null || selfPay === priceListId) return null;
  return client.price.findFirst({ where: priceOn(selfPay, serviceId, on) });
}

/** BI-297, D-230. The payer kinds whose missing price is the self-pay one. */
const INHERITS_SELF_PAY: ReadonlySet<string> = new Set([
  'COMPANY_AGREEMENT',
  'PRIVATE_INSURANCE',
]);

async function findPriceOn(
  tx: Transaction,
  query: {
    priceListId: string;
    payerId: string;
    serviceId: string;
    serviceDate: Date;
  },
) {
  const price = await priceInForce(
    tx,
    query.priceListId,
    query.serviceId,
    query.serviceDate,
  );
  if (price === null) {
    throw new PriceNotFoundError(
      query.serviceId,
      query.payerId,
      toClinicalDate(query.serviceDate),
    );
  }
  return price;
}

/**
 * D-127.2. The stamp has to MOVE for `record_version_archive` to accept it:
 * two corrections within the same millisecond would otherwise carry the same
 * instant. Copied per repository, as in `encounter` and `patients`.
 */
function stampAfter(previous: Date | null, now: Date): Date {
  return previous && previous >= now ? new Date(previous.getTime() + 1) : now;
}

/**
 * BI-066, SC-021. Who applied and who authorised a discount, by name, so the
 * line says it without asking anybody. Two first/last names and nothing else.
 */
const PERSON_NAME = { select: { firstName: true, lastName: true } } as const;
/** D-185.1, BI-235. What a printed number is made of. */
const NUMBER_PARTS = {
  select: { code: true, site: { select: { sriEstablishmentCode: true } } },
} as const;

/**
 * BI-260. The credit note that credited a line, unless the SRI rejected it:
 * the same rule as `creditedTotal` (BI-103). A credit note shares its
 * invoice's emission point, and so the parts of its number.
 */
const CREDITING_NOTE = {
  select: {
    creditNote: {
      select: {
        id: true,
        sequential: true,
        accessKey: true,
        status: true,
        emissionPoint: NUMBER_PARTS,
      },
    },
  },
} as const;

const CHARGE_INCLUDE = {
  discountAppliedBy: PERSON_NAME,
  discountAuthorisedBy: PERSON_NAME,
  creditNoteLine: CREDITING_NOTE,
  // BI-074. A copy counts while the note that credited its original stands.
  correctsChargeItem: {
    select: {
      creditNoteLine: { select: { creditNote: { select: { status: true } } } },
    },
  },
} satisfies Prisma.ChargeItemInclude;
type ChargeItemWithNames = Prisma.ChargeItemGetPayload<{
  include: typeof CHARGE_INCLUDE;
}>;
type PersonName = { firstName: string; lastName: string };

function nameOf(person: PersonName | null | undefined): string | null {
  return person ? `${person.firstName} ${person.lastName}` : null;
}

type CreditingNoteRow = NonNullable<ChargeItemWithNames['creditNoteLine']>;

/** BI-260. `null` when nothing credited it, or the SRI rejected the note. */
function creditingNoteOf(
  line: CreditingNoteRow | null | undefined,
): ChargeView['creditNote'] {
  const note = line?.creditNote;
  if (!note || note.status === 'REJECTED') return null;
  return {
    id: note.id,
    documentNumber: invoiceDocumentNumber({
      accessKey: note.accessKey,
      establishmentCode: note.emissionPoint.site.sriEstablishmentCode,
      emissionPointCode: note.emissionPoint.code,
      sequential: note.sequential,
    }),
    status: note.status,
  };
}

function toChargeView(
  row: ChargeItemRow &
    Partial<
      Pick<
        ChargeItemWithNames,
        | 'discountAppliedBy'
        | 'discountAuthorisedBy'
        | 'creditNoteLine'
        | 'correctsChargeItem'
      >
    >,
): ChargeView {
  return {
    id: row.id,
    accountId: row.accountId,
    serviceId: row.serviceId,
    encounterId: row.encounterId,
    serviceDate: toClinicalDate(row.serviceDate),
    quantity: Quantity.parse(row.quantity.toFixed(3)),
    unitAmount: Money.parse(row.unitAmount),
    resolvedPriceId: row.resolvedPriceId,
    serviceDisplay: row.serviceDisplay,
    taxSriCode: row.taxSriCode,
    taxPercentage:
      row.taxPercentage === null ? null : Percentage.parse(row.taxPercentage),
    discountAmount: Money.parse(row.discountAmount),
    discountReason: row.discountReason,
    discountAuthorisedById: row.discountAuthorisedById,
    discountAuthorisedAt: row.discountAuthorisedAt,
    discountAuthorisedByName: nameOf(row.discountAuthorisedBy),
    discountAppliedById: row.discountAppliedById,
    discountAppliedAt: row.discountAppliedAt,
    discountAppliedByName: nameOf(row.discountAppliedBy),
    status: row.status as ChargeStatus,
    createdById: row.createdById,
    origin: row.origin as ChargeOrigin,
    encounterProcedureId: row.encounterProcedureId,
    serviceOrderItemId: row.serviceOrderItemId,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    invoiceId: row.invoiceId,
    correctsChargeItemId: row.correctsChargeItemId,
    creditNote: creditingNoteOf(row.creditNoteLine),
    correctedNoteRejected:
      row.correctsChargeItem?.creditNoteLine?.creditNote.status === 'REJECTED',
  };
}

/**
 * D-185.1, BI-235. What the printed number is made of: the site's SRI code
 * and the emission point's, read with every invoice.
 */
const INVOICE_NUMBER_INCLUDE = {
  emissionPoint: {
    select: { code: true, site: { select: { sriEstablishmentCode: true } } },
  },
  // BI-103, BI-249. What it was paid and credited, read with it: the balance
  // is derived on every read and never stored.
  payments: { where: { reversedAt: null }, select: { amount: true } },
  // BI-103, BI-260. All of them: the rejected ones do not credit (the total
  // below skips them) but the row says the SRI returned them.
  creditNotes: {
    orderBy: { issuedAt: 'asc' },
    select: { id: true, amount: true, sequential: true, accessKey: true, status: true }, // prettier-ignore
  },
  // BI-260. The invoices that billed the copies of its credited lines.
  chargeItems: {
    where: { creditNoteLine: { isNot: null } },
    select: {
      correctedBy: {
        where: { invoiceId: { not: null } },
        select: {
          invoice: {
            select: {
              id: true,
              accountId: true,
              sequential: true,
              accessKey: true,
              status: true,
              issuedAt: true,
              emissionPoint: NUMBER_PARTS,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{
  include: typeof INVOICE_NUMBER_INCLUDE;
}>;

/**
 * Row to view. The totals are the STORED ones, read back as written at issuance
 * and never recomputed from the charges (BI-086).
 */
function toInvoiceView(row: InvoiceRow): InvoiceView {
  const totals: DocumentTotals = {
    subtotalTaxed: Money.parse(row.subtotalTaxed),
    subtotalUntaxed: Money.parse(row.subtotalUntaxed),
    discountTotal: Money.parse(row.discountTotal),
    taxTotal: Money.parse(row.taxTotal),
    total: Money.parse(row.total),
  };

  return {
    id: row.id,
    accountId: row.accountId,
    siteId: row.siteId,
    emissionPointId: row.emissionPointId,
    sequential: row.sequential,
    documentNumber: invoiceDocumentNumber({
      accessKey: row.accessKey,
      establishmentCode: row.emissionPoint.site.sriEstablishmentCode,
      emissionPointCode: row.emissionPoint.code,
      sequential: row.sequential,
    }),
    accessKey: row.accessKey,
    receiver: {
      buyerIdentificationType:
        row.buyerIdentificationType as BuyerIdentificationType,
      buyerIdentification: row.buyerIdentification,
      buyerName: row.buyerName,
      buyerEmail: row.buyerEmail,
      isFinalConsumer: row.isFinalConsumer,
    },
    totals,
    status: row.status as InvoiceStatus,
    paymentMethod: row.paymentMethod as PaymentMethod | null,
    issuedAt: row.issuedAt,
    authorisedAt: row.authorisedAt,
    issuedById: row.issuedById,
    paidTotal: Money.sum(row.payments.map((p) => Money.parse(p.amount))),
    creditedTotal: Money.sum(
      row.creditNotes
        .filter((note) => note.status !== 'REJECTED')
        .map((note) => Money.parse(note.amount)),
    ),
    // A credit note shares its invoice's emission point (BI-210).
    creditNotes: row.creditNotes.map((note) => ({
      id: note.id,
      documentNumber: invoiceDocumentNumber({
        accessKey: note.accessKey,
        establishmentCode: row.emissionPoint.site.sriEstablishmentCode,
        emissionPointCode: row.emissionPoint.code,
        sequential: note.sequential,
      }),
      status: note.status,
    })),
    replacedBy: replacementsOf(row),
  };
}

/** BI-260. Each replacing invoice once, oldest first. */
function replacementsOf(row: InvoiceRow): InvoiceView['replacedBy'] {
  const invoices = new Map(
    row.chargeItems
      .flatMap((charge) => charge.correctedBy)
      // BI-260. A draft or a voided invoice replaces nothing.
      .filter(
        ({ invoice }) =>
          invoice !== null &&
          invoice.status !== 'DRAFT' &&
          invoice.status !== 'VOIDED',
      )
      .flatMap(({ invoice }) =>
        invoice ? [[invoice.id, invoice] as const] : [],
      ),
  );
  return [...invoices.values()]
    .sort((a, b) => (a.issuedAt?.getTime() ?? 0) - (b.issuedAt?.getTime() ?? 0))
    .map((invoice) => ({
      id: invoice.id,
      accountId: invoice.accountId,
      documentNumber: invoiceDocumentNumber({
        accessKey: invoice.accessKey,
        establishmentCode: invoice.emissionPoint.site.sriEstablishmentCode,
        emissionPointCode: invoice.emissionPoint.code,
        sequential: invoice.sequential,
      }),
      status: invoice.status,
    }));
}

/** BI-184. The same set of ids, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === b.length && b.every((id) => left.has(id));
}
