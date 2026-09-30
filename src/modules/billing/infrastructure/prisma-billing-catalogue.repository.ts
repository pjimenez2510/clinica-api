import { Injectable } from '@nestjs/common';
import type {
  BillableService as BillableServiceRow,
  Payer as PayerRow,
  Price as PriceStoredRow,
  PriceList as PriceListRow,
  TaxRate as TaxRateRow,
} from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  BillableServiceUpdate,
  BillableServiceView,
  BillingCatalogueRepository,
  ConsultationMapping,
  NewBillableService,
  NewPayer,
  PayerKind,
  PayerUpdate,
  PayerView,
  PriceListView,
  TaxRateView,
} from '../domain/billing.repository';
import type { ServiceMatch } from '../domain/charge-proposal';
import type { VisitSequence } from '../domain/clinical-acts.port';
import { Money, Percentage } from '../domain/money';
import { type PriceChange, type PriceRow, toClinicalDate } from '../domain/price-list'; // prettier-ignore

/**
 * The catalogue, the payers and the tariff, in PostgreSQL.
 *
 * ⚠️ MONEY NEVER BECOMES A `number` ANYWHERE IN THIS FILE. `numeric(12,2)`
 * arrives as a `Prisma.Decimal`, is read through `Money.parse` — which asks it
 * for `toFixed(2)`, a string — and is written back as a string, which the
 * driver binds to the numeric column without a float ever existing. A single
 * `Number(row.amount)` would put every price one rounding away from a cent of
 * drift, and the drift only shows up on the invoice nobody can correct.
 *
 * ⚠️ AND NO CHECK BEFORE THE INSERT FOR WHAT THE DATABASE ARBITRATES. The
 * non-overlap of validities is `price_temporal_unique`; asking first and
 * writing afterwards would only add the window it exists to close. The
 * rejection travels back as `PRICE_PERIOD_OVERLAP` through the constraint
 * registry.
 */
@Injectable()
export class PrismaBillingCatalogueRepository implements BillingCatalogueRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * BI-020, BI-021. Every rate, historical ones included, grouped by SRI code
   * with the newest validity first.
   */
  async listTaxRates(): Promise<TaxRateView[]> {
    const rows = await this.prisma.taxRate.findMany({
      orderBy: [{ sriCode: 'asc' }, { validFrom: 'desc' }],
    });
    return rows.map(toTaxRateView);
  }

  /** One rate by id, whatever its validity. */
  async findTaxRate(taxRateId: string): Promise<TaxRateView | null> {
    const row = await this.prisma.taxRate.findUnique({
      where: { id: taxRateId },
    });
    return row === null ? null : toTaxRateView(row);
  }

  /**
   * BI-026. Services only: a charge keeps the SRI code and percentage it froze,
   * not a key to this row.
   */
  async countServicesUsingTaxRate(taxRateId: string): Promise<number> {
    return this.prisma.billableService.count({ where: { taxRateId } });
  }

  /**
   * BI-014, BI-023. Inactive services are excluded by default and served on
   * request, never hidden: the ones that already appear on a charge have to
   * keep being readable.
   */
  async listBillableServices(filter: {
    includeInactive: boolean;
  }): Promise<BillableServiceView[]> {
    const rows = await this.prisma.billableService.findMany({
      where: filter.includeInactive ? {} : { active: true },
      include: { taxRate: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toServiceView);
  }

  /** One service by id, active or not, with its tax rate joined in. */
  async findBillableService(
    serviceId: string,
  ): Promise<BillableServiceView | null> {
    const row = await this.prisma.billableService.findUnique({
      where: { id: serviceId },
      include: { taxRate: true },
    });
    return row === null ? null : toServiceView(row);
  }

  /**
   * BI-010. The fields are copied one by one, so nothing outside
   * `NewBillableService` reaches the insert. A duplicate `code` is refused by
   * `billable_service_code_unique`.
   */
  async createBillableService(
    service: NewBillableService,
  ): Promise<BillableServiceView> {
    const row = await this.prisma.billableService.create({
      data: {
        code: service.code,
        name: service.name,
        category: service.category,
        tariffCode: service.tariffCode,
        taxRateId: service.taxRateId,
      },
      include: { taxRate: true },
    });
    return toServiceView(row);
  }

  /**
   * A partial update: Prisma skips `undefined`, so an absent field is left as
   * it is.
   */
  async updateBillableService(
    serviceId: string,
    update: BillableServiceUpdate,
  ): Promise<BillableServiceView> {
    const row = await this.prisma.billableService.update({
      where: { id: serviceId },
      data: {
        name: update.name,
        category: update.category,
        tariffCode: update.tariffCode,
        taxRateId: update.taxRateId,
        active: update.active,
        // BI-158. `null` clears the pair, `undefined` leaves it alone, and
        // half a pair is impossible to express — which is what
        // `billable_service_consultation_states_both` refuses underneath.
        ...(update.consultation === undefined
          ? {}
          : {
              specialtyId: update.consultation?.specialtyId ?? null,
              visitSequence: update.consultation?.visitSequence ?? null,
            }),
      },
      include: { taxRate: true },
    });
    return toServiceView(row);
  }

  /**
   * BI-158. The consultation of a specialty, ACTIVE OR NOT.
   *
   * The active flag travels instead of filtering: a proposal that silently
   * skipped a deactivated consultation would look identical to one for a
   * specialty nobody ever mapped, and those two need different answers at the
   * counter — «reactive la prestación» against «dígale a administración cuál
   * es la consulta de dermatología».
   */
  async findConsultationService(
    mapping: ConsultationMapping,
  ): Promise<ServiceMatch | null> {
    const row = await this.prisma.billableService.findFirst({
      where: {
        specialtyId: mapping.specialtyId,
        visitSequence: mapping.visitSequence,
      },
      select: { id: true, active: true },
    });
    return row === null ? null : { billableServiceId: row.id, active: row.active }; // prettier-ignore
  }

  /**
   * BI-151. Concept → service, for a whole visit in ONE query.
   *
   * `billable_service.procedure_concept_id` is the tie the schema already
   * carried for exactly this — «so a charge can be raised from the encounter
   * instead of typed at the cashier» — and it is a plain column, so two
   * services pointing at the same concept is possible. The map keeps the FIRST
   * by name, deterministically: an arbitrary order here would charge different
   * amounts for the same procedure on different days.
   */
  async findServicesByProcedureConcept(
    conceptIds: readonly string[],
  ): Promise<Map<string, ServiceMatch>> {
    if (conceptIds.length === 0) return new Map();

    const rows = await this.prisma.billableService.findMany({
      where: { procedureConceptId: { in: [...conceptIds] } },
      select: { id: true, active: true, procedureConceptId: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });

    const byConcept = new Map<string, ServiceMatch>();
    for (const row of rows) {
      const conceptId = row.procedureConceptId;
      if (conceptId === null || byConcept.has(conceptId)) continue;
      byConcept.set(conceptId, { billableServiceId: row.id, active: row.active }); // prettier-ignore
    }
    return byConcept;
  }

  /**
   * BI-151. Exam code → service, through `exam_definition.billable_service_id`.
   *
   * ⚠️ THE CATALOGUE OF EXAMS IS READ HERE AND NOT THROUGH `modules/orders`.
   * No module imports another; `exam_definition` is a table, and the question
   * billing asks of it — «what does this orderable cost» — is not the question
   * `orders` asks. Its own service says so out loud: «AND IT SERVES NO PRICE».
   *
   * A definition with no `billable_service_id` produces no entry, which the
   * derivation reports as `NO_BILLABLE_SERVICE`: the exam was ordered and
   * nobody has said what it costs.
   */
  async findServicesByExamCode(
    codes: readonly string[],
  ): Promise<Map<string, ServiceMatch>> {
    if (codes.length === 0) return new Map();

    const rows = await this.prisma.examDefinition.findMany({
      where: { code: { in: [...codes] }, billableServiceId: { not: null } },
      select: {
        code: true,
        billableService: { select: { id: true, active: true } },
      },
    });

    const byCode = new Map<string, ServiceMatch>();
    for (const row of rows) {
      if (row.billableService === null) continue;
      byCode.set(row.code, {
        billableServiceId: row.billableService.id,
        active: row.billableService.active,
      });
    }
    return byCode;
  }

  /**
   * BI-012. Counts prices AND charges, because either one makes the service
   * un-deletable and the two `RESTRICT` keys would refuse it anyway.
   */
  async countReferencesToService(serviceId: string): Promise<number> {
    const [prices, charges] = await Promise.all([
      this.prisma.price.count({ where: { billableServiceId: serviceId } }),
      this.prisma.chargeItem.count({ where: { billableServiceId: serviceId } }),
    ]);
    return prices + charges;
  }

  /**
   * BI-012. Called only after `countReferencesToService` answered zero; the
   * `RESTRICT` keys refuse it anyway if something slipped in between.
   */
  async deleteBillableService(serviceId: string): Promise<void> {
    await this.prisma.billableService.delete({ where: { id: serviceId } });
  }

  /**
   * BI-030. Active payers by default, alphabetically; inactive ones on request.
   */
  async listPayers(filter: { includeInactive: boolean }): Promise<PayerView[]> {
    const rows = await this.prisma.payer.findMany({
      where: filter.includeInactive ? {} : { active: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(toPayerView);
  }

  /** One payer by id, active or not. */
  async findPayer(payerId: string): Promise<PayerView | null> {
    const row = await this.prisma.payer.findUnique({ where: { id: payerId } });
    return row === null ? null : toPayerView(row);
  }

  /**
   * BI-031. Asked before deactivating a payer: the last active one may not go,
   * or no account could be opened.
   */
  async countActivePayers(): Promise<number> {
    return this.prisma.payer.count({ where: { active: true } });
  }

  /** BI-032. Price lists and accounts that name the payer. */
  async countReferencesToPayer(payerId: string): Promise<number> {
    const [lists, accounts] = await Promise.all([
      this.prisma.priceList.count({ where: { payerId } }),
      this.prisma.patientAccount.count({ where: { payerId } }),
    ]);
    return lists + accounts;
  }

  /**
   * BI-030. The RUC has already been checked by the service for institutional
   * kinds (BI-034).
   */
  async createPayer(payer: NewPayer): Promise<PayerView> {
    const row = await this.prisma.payer.create({
      data: {
        code: payer.code,
        name: payer.name,
        kind: payer.kind,
        ruc: payer.ruc,
        agreementReference: payer.agreementReference,
      },
    });
    return toPayerView(row);
  }

  /** A partial update; `code` and `kind` are never written here. */
  async updatePayer(payerId: string, update: PayerUpdate): Promise<PayerView> {
    const row = await this.prisma.payer.update({
      where: { id: payerId },
      data: {
        name: update.name,
        ruc: update.ruc,
        agreementReference: update.agreementReference,
        active: update.active,
      },
    });
    return toPayerView(row);
  }

  /**
   * BI-040. The list of a payer for EVERY site (`site_id IS NULL`).
   *
   * A per-site list is admitted by the column and not used by this delivery:
   * what the clinic charges is the clinic's, not one branch's, and a tariff
   * split by site is the mistake nobody can consolidate into a report
   * afterwards. When a clinic with branches that charge differently needs one,
   * the column is already there.
   */
  async findPriceListOfPayer(payerId: string): Promise<PriceListView | null> {
    const row = await this.prisma.priceList.findFirst({
      where: { payerId, siteId: null, active: true },
      orderBy: { createdAt: 'asc' },
    });
    return row === null ? null : toPriceListView(row);
  }

  /**
   * BI-041. The whole price history of one service in one list, newest validity
   * first.
   */
  async listPricesOfService(
    priceListId: string,
    billableServiceId: string,
  ): Promise<PriceRow[]> {
    const rows = await this.prisma.price.findMany({
      where: { priceListId, billableServiceId },
      orderBy: { validFrom: 'desc' },
    });
    return rows.map(toPriceRow);
  }

  /**
   * BI-040, BI-041. Every price of the list with every validity, grouped by
   * service, newest first within each.
   */
  async listPricesOfList(priceListId: string): Promise<PriceRow[]> {
    const rows = await this.prisma.price.findMany({
      where: { priceListId },
      orderBy: [{ billableServiceId: 'asc' }, { validFrom: 'desc' }],
    });
    return rows.map(toPriceRow);
  }

  /**
   * BI-044. Closing the old validity and opening the new one, AS ONE
   * TRANSACTION.
   *
   * Observable apart, the two writes leave either a day with no price — a
   * charge dated then would be refused with `PRICE_NOT_FOUND` for no real
   * reason — or an overlap, which `price_temporal_unique` refuses with a
   * message nobody at a tariff screen can act on. Neither is a state any
   * reader should ever see.
   */
  async applyPriceChange(
    priceListId: string,
    billableServiceId: string,
    change: PriceChange,
  ): Promise<PriceRow> {
    return this.prisma.$transaction(async (tx) => {
      if (change.closes !== null) {
        await tx.price.update({
          where: { id: change.closes.priceId },
          data: { validTo: asDateColumn(change.closes.validTo) },
        });
      }

      const created = await tx.price.create({
        data: {
          priceListId,
          billableServiceId,
          // A STRING, never a number: the driver binds it straight to
          // `numeric(12,2)` and no float is constructed on the way.
          amount: change.opens.amount.toString(),
          validFrom: asDateColumn(change.opens.validFrom),
          validTo: null,
        },
      });

      return toPriceRow(created);
    });
  }
}

/** A `ClinicalDate` as a `@db.Date` column takes it: midnight UTC, no zone shift. */
export function asDateColumn(date: ClinicalDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

/**
 * Row to view. A null percentage stays null: «no objeto» and «exento» are not
 * 0%.
 */
function toTaxRateView(row: TaxRateRow): TaxRateView {
  return {
    id: row.id,
    sriCode: row.sriCode,
    name: row.name,
    percentage: row.percentage === null ? null : Percentage.parse(row.percentage), // prettier-ignore
    validFrom: toClinicalDate(row.validFrom),
    validTo: row.validTo === null ? null : toClinicalDate(row.validTo),
  };
}

/**
 * Row to view, with the tax code and percentage taken from the joined rate. The
 * `visitSequence` cast leans on `billable_service_visit_sequence_is_known`.
 */
function toServiceView(
  row: BillableServiceRow & { taxRate: TaxRateRow },
): BillableServiceView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    tariffCode: row.tariffCode,
    taxRateId: row.taxRateId,
    taxSriCode: row.taxRate.sriCode,
    taxPercentage:
      row.taxRate.percentage === null
        ? null
        : Percentage.parse(row.taxRate.percentage),
    active: row.active,
    specialtyId: row.specialtyId,
    visitSequence: row.visitSequence as VisitSequence | null,
  };
}

/** Row to view; the dates come back as `ClinicalDate`, never as an instant. */
function toPayerView(row: PayerRow): PayerView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    // `payer_kind_is_known` is what guarantees the column holds one of the
    // four; the cast states that rather than re-checking it in TypeScript.
    kind: row.kind as PayerKind,
    ruc: row.ruc,
    agreementReference: row.agreementReference,
    agreementValidTo:
      row.agreementValidTo === null ? null : toClinicalDate(row.agreementValidTo), // prettier-ignore
    active: row.active,
  };
}

/** Row to view, field for field. */
function toPriceListView(row: PriceListRow): PriceListView {
  return {
    id: row.id,
    name: row.name,
    payerId: row.payerId,
    siteId: row.siteId,
    publiclyListed: row.publiclyListed,
    active: row.active,
  };
}

/**
 * Row to view: the amount through `Money.parse`, the validity as
 * `ClinicalDate`s with an open end kept as `null`.
 */
export function toPriceRow(row: PriceStoredRow): PriceRow {
  return {
    id: row.id,
    billableServiceId: row.billableServiceId,
    amount: Money.parse(row.amount),
    validFrom: toClinicalDate(row.validFrom),
    validTo: row.validTo === null ? null : toClinicalDate(row.validTo),
  };
}
