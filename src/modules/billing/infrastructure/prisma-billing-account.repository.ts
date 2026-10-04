import { Injectable } from '@nestjs/common';
import type {
  ChargeItem as ChargeItemRow,
  Invoice as InvoiceRow,
  PatientAccount as PatientAccountRow,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';

import type {
  AccountPatientIdentification,
  AccountStatus,
  AccountView,
  BillingAccountRepository,
  ChargedActs,
  ChargeView,
  InvoiceIssuance,
  InvoiceView,
  NewAccount,
  NewCharge,
} from '../domain/billing.repository';
import {
  ActAlreadyChargedError,
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
  totalsOf,
} from '../domain/charge';
import {
  type BuyerIdentificationType,
  type InvoiceStatus,
  type PaymentMethod,
  nextSequential,
} from '../domain/invoice';
import { Money, Percentage, Quantity } from '../domain/money';
import { toClinicalDate } from '../domain/price-list';
import { asDateColumn } from './prisma-billing-catalogue.repository';

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
   * BI-033. Writes the payer and its list together; the service has already
   * refused an account that holds charges.
   */
  async changeAccountPayer(
    accountId: string,
    payer: { payerId: string; priceListId: string },
  ): Promise<AccountView> {
    const row = await this.prisma.patientAccount.update({
      where: { id: accountId },
      data: payer,
      include: ACCOUNT_INCLUDE,
    });
    return toAccountView(row);
  }

  /**
   * BI-071. `patient_account_closed_states_its_instant` ties the status and
   * the instant in both directions, so the two are written together or the
   * row is refused.
   */
  async closeAccount(accountId: string): Promise<AccountView> {
    const row = await this.prisma.patientAccount.update({
      where: { id: accountId },
      data: { status: 'SETTLED', closedAt: new Date() },
      include: ACCOUNT_INCLUDE,
    });
    return toAccountView(row);
  }

  /**
   * BI-074. Every charge of the account, voided ones included, in the order
   * they were raised; which ones count is the caller's filter.
   */
  async listCharges(accountId: string): Promise<ChargeView[]> {
    const rows = await this.prisma.chargeItem.findMany({
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

      const service = await tx.billableService.findUniqueOrThrow({
        where: { id: command.billableServiceId },
        include: { taxRate: true },
      });

      const price = await tx.price.findFirst({
        where: {
          priceListId: account.priceListId,
          billableServiceId: command.billableServiceId,
          validFrom: { lte: on },
          OR: [{ validTo: null }, { validTo: { gt: on } }],
        },
      });

      if (price === null) {
        throw new PriceNotFoundError(
          command.billableServiceId,
          account.payerId,
          command.serviceDate,
        );
      }

      const row = await tx.chargeItem.create({
        data: {
          accountId: command.accountId,
          billableServiceId: command.billableServiceId,
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
      },
    });

    return {
      consultation: rows.some((row) => row.origin === 'CONSULTATION'),
      encounterProcedureIds: rows
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
      where: { id: chargeId, status: 'PLANNED' },
      data: { status: 'BILLABLE' },
    });
    return toChargeView(row);
  }

  /**
   * BI-055. The void, WITH ITS REASON KEPT.
   *
   * The four columns move together because the database demands it:
   * `charge_item_void_states_who_when_and_why` refuses one without the others,
   * and `charge_item_void_matches_status` refuses a `CANCELLED` row with no
   * instant — and a voided row that is not `CANCELLED`. Demanding a reason the
   * system then throws away looks like an audit trail and is not one.
   *
   * ⚠️ AND IT IS AN UPDATE, NEVER A DELETE. The row stays, which is what lets
   * an account explain why its total went down.
   */
  async voidCharge(command: {
    chargeId: string;
    voidedById: string;
    reason: string;
  }): Promise<ChargeView> {
    const row = await this.prisma.chargeItem.update({
      where: { id: command.chargeId, status: { in: ['PLANNED', 'BILLABLE'] } },
      data: {
        status: 'CANCELLED',
        voidedAt: new Date(),
        voidedById: command.voidedById,
        voidReason: command.reason,
      },
    });
    return toChargeView(row);
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
    };
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

        const charges = await tx.chargeItem.findMany({
          where: { accountId: issuance.accountId, status: 'BILLABLE' },
          orderBy: { createdAt: 'asc' },
          include: { billableService: { select: { code: true, name: true } } },
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
          (charge) =>
            charge.billableService.code.length > MAX_VOUCHER_SERVICE_CODE,
        );
        if (tooLong) {
          throw new InvoiceServiceCodeTooLongError(
            tooLong.billableService.name,
            tooLong.billableService.code,
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

        const [last] = await tx.$queryRaw<{ sequential: string | null }[]>`
          SELECT max("sequential") AS "sequential"
            FROM "invoice"
           WHERE "emission_point_id" = ${issuance.emissionPointId}::uuid`;

        const invoice = await tx.invoice.create({
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

        // BI-169. Each charge names the invoice that took it, in the same
        // statement that bills it (`charge_item_billed_carries_its_invoice`):
        // the voucher's lines are read through it.
        await tx.chargeItem.updateMany({
          where: {
            id: { in: charges.map((charge) => charge.id) },
            status: 'BILLABLE',
          },
          data: { status: 'BILLED', invoiceId: invoice.id },
        });

        return toInvoiceView(invoice);
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
    });
    return row === null ? null : toInvoiceView(row);
  }

  async listInvoices(query: {
    siteId: string;
    accountId?: string;
  }): Promise<InvoiceView[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { siteId: query.siteId, accountId: query.accountId },
      orderBy: { sequential: 'desc' },
    });
    return rows.map(toInvoiceView);
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
  if (/invoice_is_never_deleted/.test(message)) {
    return new InvoiceImmutableError('An invoice is never deleted');
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
function databaseMessageOf(error: unknown): string {
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
  };
}

/**
 * Row to view, every amount through `Money`/`Percentage`/`Quantity` parsing.
 * The quantity is rendered at its column's three decimals first; the string
 * casts lean on `charge_item_status_is_known` and
 * `charge_item_origin_is_known`.
 */
function toChargeView(row: ChargeItemRow): ChargeView {
  return {
    id: row.id,
    accountId: row.accountId,
    billableServiceId: row.billableServiceId,
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
    status: row.status as ChargeStatus,
    createdById: row.createdById,
    origin: row.origin as ChargeOrigin,
    encounterProcedureId: row.encounterProcedureId,
    serviceOrderItemId: row.serviceOrderItemId,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
  };
}

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
  };
}

/** BI-184. The same set of ids, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === b.length && b.every((id) => left.has(id));
}
