import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type Payer as PayerRow,
  type Price as PriceStoredRow,
  type PriceList as PriceListRow,
  type Service as ServiceStoredRow,
  type ServiceExam as ServiceExamRow,
  type TaxRate as TaxRateRow,
} from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  BillingCatalogueRepository,
  CurrentPriceView,
  NewPayer,
  NewService,
  OrderExtension,
  PayerKind,
  PayerUpdate,
  PayerView,
  PriceListView,
  ServiceAnalyteView,
  ServiceKind,
  ServiceListFilter,
  ServicePage,
  ServicePriceView,
  ServiceUpdate,
  ServiceView,
  TaxRateView,
  VisitKind,
} from '../domain/billing.repository';
import type { ServiceMatch } from '../domain/charge-proposal';
import { Money, Percentage } from '../domain/money';
import { type PriceChange, type PriceRow, toClinicalDate } from '../domain/price-list'; // prettier-ignore

import { selfPayPriceListId } from './self-pay-list';

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
   * BI-189. By payer name, newest validity first within each payer. Inactive
   * payers included: their old prices are part of the history.
   */
  async listPricesAcrossPayers(serviceId: string): Promise<ServicePriceView[]> {
    const rows = await this.prisma.price.findMany({
      where: { serviceId: serviceId },
      include: {
        priceList: {
          select: { payer: { select: { id: true, name: true, kind: true } } },
        },
      },
      orderBy: [
        { priceList: { payer: { name: 'asc' } } },
        { validFrom: 'desc' },
      ],
    });
    return rows.map((row) => ({
      ...toPriceRow(row),
      priceId: row.id,
      payer: {
        id: row.priceList.payer.id,
        name: row.priceList.payer.name,
        kind: row.priceList.payer.kind as PayerKind,
      },
    }));
  }

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
    return this.prisma.service.count({ where: { taxRateId } });
  }

  /**
   * BI-280. The health-services rate (SRI code `0`) in force, which a new
   * service takes when none is sent. A default, not a classification: it is
   * born unreviewed (D-A-006, BI-024).
   */
  async findHealthTaxRate(): Promise<TaxRateView | null> {
    const row = await this.prisma.taxRate.findFirst({
      where: { sriCode: '0', validTo: null },
      orderBy: { validFrom: 'desc' },
    });
    return row === null ? null : toTaxRateView(row);
  }

  /**
   * BI-282 (D-220 §3). One page, filtered and ordered IN THE DATABASE.
   *
   * The text is matched on the name without accents or case and on the code
   * without case, as a literal (a «%» typed is a «%» searched). With a text,
   * the exact code first and the names that START with it next: the cashier
   * typing «PROC-ECG» or «electro» wants that row on top, not alphabetical
   * order. Without one, by kind and name, which is how the list is read.
   *
   * Two statements and not one: the count is what the pager needs, the ids
   * are the page; the rows are then read with their joins by id.
   */
  async listServices(filter: ServiceListFilter): Promise<ServicePage> {
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (!filter.includeInactive) conditions.push(Prisma.sql`s.active`);
    if (filter.kind !== null) {
      conditions.push(Prisma.sql`s.kind = ${filter.kind}`);
    }
    if (filter.specialtyId !== null) {
      conditions.push(Prisma.sql`s.specialty_id = ${filter.specialtyId}::uuid`);
    }
    const text = filter.query?.trim() ?? '';
    const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    const startsWith = `${text.replace(/[\\%_]/g, '\\$&')}%`;
    if (text !== '') {
      conditions.push(Prisma.sql`(
        immutable_unaccent(lower(s.name)) LIKE immutable_unaccent(lower(${like}))
        OR lower(s.code) LIKE lower(${like}))`);
    }
    const where = Prisma.join(conditions, ' AND ');
    const order =
      text === ''
        ? Prisma.sql`array_position(${[...KIND_ORDER]}::varchar[], s.kind),
                     immutable_unaccent(lower(s.name)), s.code`
        : Prisma.sql`(lower(s.code) = lower(${text})) DESC,
                     (immutable_unaccent(lower(s.name))
                        LIKE immutable_unaccent(lower(${startsWith}))) DESC,
                     immutable_unaccent(lower(s.name)), s.code`;

    const [counted, page] = await Promise.all([
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM service s WHERE ${where}`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM service s WHERE ${where}
         ORDER BY ${order}
         LIMIT ${filter.pageSize} OFFSET ${(filter.page - 1) * filter.pageSize}`,
    ]);
    const ids = page.map((row) => row.id);
    const [rows, prices] = await Promise.all([
      this.prisma.service.findMany({
        where: { id: { in: ids } },
        include: SERVICE_INCLUDE,
      }),
      this.currentPrices(ids, filter.today),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      items: ids
        .map((id) => byId.get(id))
        .filter((row): row is ServiceRow => row !== undefined)
        .map((row) => ({
          ...toServiceView(row),
          prices: prices.get(row.id) ?? [],
        })),
      total: counted[0]?.total ?? 0,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  /**
   * BI-282. The price in force on `today` of each service in the self-pay
   * list and every active payer's list (clinic-wide, `site_id IS NULL`).
   * `price_temporal_unique` makes it at most one per service and list.
   */
  private async currentPrices(
    serviceIds: readonly string[],
    today: ClinicalDate,
  ): Promise<Map<string, CurrentPriceView[]>> {
    if (serviceIds.length === 0) return new Map();
    const day = asDateColumn(today);
    const rows = await this.prisma.price.findMany({
      where: {
        serviceId: { in: [...serviceIds] },
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gt: day } }],
        priceList: { active: true, siteId: null, payer: { active: true } },
      },
      select: {
        id: true,
        serviceId: true,
        amount: true,
        validFrom: true,
        priceListId: true,
        priceList: { select: { payerId: true } },
      },
    });
    const prices = new Map<string, CurrentPriceView[]>();
    for (const row of rows) {
      const list = prices.get(row.serviceId) ?? [];
      list.push({
        priceListId: row.priceListId,
        payerId: row.priceList.payerId,
        priceId: row.id,
        amount: Money.parse(row.amount),
        validFrom: toClinicalDate(row.validFrom),
      });
      prices.set(row.serviceId, list);
    }
    return prices;
  }

  /** One service by id, active or not, with its joins. */
  async findService(serviceId: string): Promise<ServiceView | null> {
    const row = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: SERVICE_INCLUDE,
    });
    return row === null ? null : toServiceView(row);
  }

  /**
   * BI-283. Its analytes in print order, each with the ranges in force
   * (`valid_to IS NULL`, ORD-113). A read: the structure and the ranges are
   * written by the exam catalogue (ORD-105, ORD-106).
   */
  async listAnalytesOfService(
    serviceId: string,
  ): Promise<ServiceAnalyteView[]> {
    const rows = await this.prisma.serviceExamAnalyte.findMany({
      where: { serviceId },
      orderBy: { position: 'asc' },
      select: {
        position: true,
        isReflex: true,
        analyteDefinition: {
          select: {
            id: true,
            code: true,
            name: true,
            unit: true,
            valueType: true,
            decimals: true,
            allowedValues: true,
            loincCode: true,
            active: true,
            referenceRanges: {
              where: { validTo: null },
              orderBy: [{ rangeKind: 'desc' }, { sex: 'asc' }, { ageMinDays: 'asc' }], // prettier-ignore
            },
          },
        },
      },
    });
    return rows.map(({ analyteDefinition: analyte, position, isReflex }) => ({
      id: analyte.id,
      code: analyte.code,
      name: analyte.name,
      unit: analyte.unit,
      valueType: analyte.valueType,
      decimals: analyte.decimals,
      allowedValues: analyte.allowedValues,
      loincCode: analyte.loincCode,
      active: analyte.active,
      position,
      isReflex,
      ranges: analyte.referenceRanges.map((range) => ({
        id: range.id,
        sex: range.sex,
        ageMinDays: range.ageMinDays,
        ageMaxDays: range.ageMaxDays,
        rangeKind: range.rangeKind,
        low: range.low === null ? null : range.low.toString(),
        high: range.high === null ? null : range.high.toString(),
        text: range.text,
      })),
    }));
  }

  /**
   * BI-280. The service, its order extension and its first self-pay price,
   * in ONE transaction. A duplicate `code` is refused by
   * `service_code_unique`, a repeated name by `service_active_name_unique`,
   * and the shape of a consultation by `service_consultation_shape`.
   */
  async createService(service: NewService): Promise<ServiceView> {
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.service.create({
        data: {
          code: service.code,
          name: service.name,
          kind: service.kind,
          mspCode: service.mspCode,
          taxRateId: service.taxRateId,
          specialtyId: service.consultation?.specialtyId ?? null,
          durationMinutes: service.consultation?.durationMinutes ?? null,
          visitKind: service.consultation?.visitKind ?? null,
          ...(service.exam === null
            ? {}
            : { exam: { create: { ...service.exam } } }),
        },
        select: { id: true },
      });
      await tx.price.create({
        data: {
          priceListId: service.selfPay.priceListId,
          serviceId: created.id,
          // A STRING, never a number: bound straight to `numeric(12,2)`.
          amount: service.selfPay.amount.toString(),
          validFrom: asDateColumn(service.selfPay.validFrom),
          validTo: null,
        },
      });
      return created.id;
    });
    return (await this.findService(id))!;
  }

  /**
   * A partial update, in one transaction: Prisma skips `undefined`, so an
   * absent field is left as it is. The extension is created when missing,
   * changed when present and removed on `null` (BI-284).
   */
  async updateService(
    serviceId: string,
    update: ServiceUpdate,
  ): Promise<ServiceView> {
    await this.prisma.$transaction(async (tx) => {
      // BI-024 (D-172.2). Cleared by the row as stored, not by what the
      // service read: a review recorded in between still does not survive a
      // new rate.
      if (update.taxRateId !== undefined && update.taxReview === undefined) {
        await tx.service.updateMany({
          where: { id: serviceId, NOT: { taxRateId: update.taxRateId } },
          data: { taxReviewedAt: null, taxReviewedById: null },
        });
      }
      await tx.service.update({
        where: { id: serviceId },
        data: {
          code: update.code,
          name: update.name,
          mspCode: update.mspCode,
          taxRateId: update.taxRateId,
          active: update.active,
          specialtyId: update.consultation?.specialtyId,
          durationMinutes: update.consultation?.durationMinutes,
          visitKind: update.consultation?.visitKind,
          // BI-256. `service_written_consent_states_who` and
          // `…_needs_a_procedure` are the guarantee underneath.
          ...(update.writtenConsent === undefined
            ? {}
            : {
                requiresWrittenConsent: update.writtenConsent.required,
                writtenConsentSetAt: update.writtenConsent.setAt,
                writtenConsentSetById: update.writtenConsent.setById,
              }),
          // BI-024. Both columns or neither, which is what
          // `service_tax_review_names_who_and_when` demands underneath.
          ...(update.taxReview === undefined
            ? {}
            : {
                taxReviewedAt: update.taxReview?.reviewedAt ?? null,
                taxReviewedById: update.taxReview?.reviewedById ?? null,
              }),
        },
      });
      if (update.exam === null) {
        await tx.serviceExam.deleteMany({ where: { serviceId } });
      } else if (update.exam !== undefined) {
        await tx.serviceExam.upsert({
          where: { serviceId },
          create: { serviceId, ...update.exam },
          update: { ...update.exam },
        });
      }
    });
    return (await this.findService(serviceId))!;
  }

  /** BI-024. Conditional on the rate the reviewer saw (see the port). */
  async markTaxReviewed(
    serviceId: string,
    taxRateId: string,
    review: { reviewedAt: Date; reviewedById: string },
  ): Promise<ServiceView | null> {
    const { count } = await this.prisma.service.updateMany({
      where: { id: serviceId, taxRateId },
      data: {
        taxReviewedAt: review.reviewedAt,
        taxReviewedById: review.reviewedById,
      },
    });
    return count === 0 ? null : this.findService(serviceId);
  }

  /** BI-281, BI-285. A charge of the service printed on an invoice. */
  async hasInvoicedCharges(serviceId: string): Promise<boolean> {
    const found = await this.prisma.chargeItem.count({
      where: { serviceId, invoiceId: { not: null } },
    });
    return found > 0;
  }

  /** BI-281. Any order line, in any status, that froze the code. */
  async codeWasOrdered(code: string): Promise<boolean> {
    const found = await this.prisma.serviceOrderItem.count({
      where: { testCode: code },
    });
    return found > 0;
  }

  /**
   * BI-286. A code of the TARIFF catalogue, of any edition: the procedure a
   * doctor records keeps its code across editions (EN-152), and so does the
   * service that charges it.
   */
  async isTariffProcedureCode(code: string): Promise<boolean> {
    const found = await this.prisma.catalogConcept.count({
      where: { code, system: { code: 'TARIFF' } },
    });
    return found > 0;
  }

  /** BI-286. `service_one_procedure_per_code` is the guarantee underneath. */
  async procedureCodeTakenByOther(
    code: string,
    serviceId: string | null,
  ): Promise<boolean> {
    const found = await this.prisma.service.count({
      where: {
        kind: 'PROCEDURE',
        active: true,
        mspCode: code,
        ...(serviceId === null ? {} : { NOT: { id: serviceId } }),
      },
    });
    return found > 0;
  }

  /** BI-279. */
  async specialtyIsActive(specialtyId: string): Promise<boolean> {
    const found = await this.prisma.specialty.count({
      where: { id: specialtyId, active: true },
    });
    return found > 0;
  }

  /** SP-021. The distinct atoms of every site; see `clinicSlotAtom`. */
  async siteSlotAtoms(): Promise<readonly number[]> {
    const rows = await this.prisma.siteParameter.findMany({
      distinct: ['slotAtomMinutes'],
      select: { slotAtomMinutes: true },
    });
    return rows.map((row) => row.slotAtomMinutes);
  }

  /** BI-280. */
  async codesStartingWith(prefix: string): Promise<string[]> {
    const rows = await this.prisma.service.findMany({
      where: { code: { startsWith: prefix } },
      select: { code: true },
    });
    return rows.map((row) => row.code);
  }

  /** BI-280. */
  async findSelfPayPriceList(): Promise<PriceListView | null> {
    const id = await selfPayPriceListId(this.prisma);
    if (id === null) return null;
    const row = await this.prisma.priceList.findUnique({ where: { id } });
    return row === null ? null : toPriceListView(row);
  }

  /**
   * BI-012, BI-288. Everything a `RESTRICT` key would refuse the delete for:
   * charges, an appointment, somebody waiting and an order line that froze
   * its code. Its own prices and extension go with it (a service nobody used
   * was created by mistake), which is why prices are deleted first.
   */
  async countReferencesToService(serviceId: string): Promise<number> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { code: true },
    });
    const [charges, appointments, waiting, ordered, published] =
      await Promise.all([
        this.prisma.chargeItem.count({ where: { serviceId } }),
        this.prisma.agendaEntry.count({ where: { serviceId } }),
        this.prisma.waitlistEntry.count({ where: { serviceId } }),
        service === null
          ? 0
          : this.prisma.serviceOrderItem.count({
              where: { testCode: service.code },
            }),
        this.prisma.tariffPublicationItem.count({ where: { serviceId } }),
      ]);
    return charges + appointments + waiting + ordered + published;
  }

  /**
   * BI-012. Called only after `countReferencesToService` answered zero; the
   * `RESTRICT` keys refuse it anyway if something slipped in between. A price
   * no charge froze goes with its service; one a charge froze would have made
   * the count non-zero.
   */
  async deleteService(serviceId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.price.deleteMany({ where: { serviceId } }),
      this.prisma.service.delete({ where: { id: serviceId } }),
    ]);
  }

  /**
   * BI-287. The service the appointment booked, IF IT IS A CONSULTATION,
   * active or not.
   *
   * The active flag travels instead of filtering: a proposal that silently
   * skipped a deactivated consultation would look identical to one for an
   * appointment with no consultation, and those two need different answers at
   * the counter — «reactive el servicio» against «cobre a mano».
   */
  async findConsultationService(
    serviceId: string,
  ): Promise<ServiceMatch | null> {
    const row = await this.prisma.service.findFirst({
      where: { id: serviceId, kind: 'CONSULTATION' },
      select: { id: true, active: true },
    });
    return row === null ? null : { serviceId: row.id, active: row.active };
  }

  /**
   * BI-286. A tariff code → the procedure service carrying it, for a whole
   * visit in ONE query. `service_one_procedure_per_code` keeps it at most one
   * ACTIVE service per code; when only retired ones carry it, the newest one
   * travels, inactive, so caja reads «reactive el servicio» instead of
   * «nadie lo cobra».
   */
  async findServicesByProcedureCode(
    codes: readonly string[],
  ): Promise<Map<string, ServiceMatch>> {
    if (codes.length === 0) return new Map();

    const rows = await this.prisma.service.findMany({
      where: { kind: 'PROCEDURE', mspCode: { in: [...codes] } },
      select: { id: true, active: true, mspCode: true },
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    });

    const byCode = new Map<string, ServiceMatch>();
    for (const row of rows) {
      const code = row.mspCode;
      if (code === null || byCode.has(code)) continue;
      byCode.set(code, { serviceId: row.id, active: row.active });
    }
    return byCode;
  }

  /**
   * BI-151, BI-284. The code an order line froze → the service with that
   * code. Since ADR-013 the exam IS its service, so the join is the service's
   * own unique `code`; the price is simply the service's (BI-040), resolved
   * on the service date like any other charge.
   */
  async findServicesByExamCode(
    codes: readonly string[],
  ): Promise<Map<string, ServiceMatch>> {
    if (codes.length === 0) return new Map();

    const rows = await this.prisma.service.findMany({
      where: { code: { in: [...codes] } },
      select: { id: true, code: true, active: true },
    });
    return new Map(
      rows.map((row) => [row.code, { serviceId: row.id, active: row.active }]),
    );
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
    serviceId: string,
  ): Promise<PriceRow[]> {
    const rows = await this.prisma.price.findMany({
      where: { priceListId, serviceId },
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
      orderBy: [{ serviceId: 'asc' }, { validFrom: 'desc' }],
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
    serviceId: string,
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
          serviceId,
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

  /** BI-230. */
  async findPrice(
    priceId: string,
  ): Promise<(PriceRow & { priceListId: string }) | null> {
    const row = await this.prisma.price.findUnique({ where: { id: priceId } });
    return row ? { ...toPriceRow(row), priceListId: row.priceListId } : null;
  }

  /** BI-230. */
  async countOpenChargesAt(priceId: string, amount: Money): Promise<number> {
    return this.prisma.chargeItem.count({
      where: {
        resolvedPriceId: priceId,
        status: { in: ['PLANNED', 'BILLABLE'] },
        unitAmount: amount.toString(),
      },
    });
  }

  /** BI-230. The stamp is what lets `trg_price_record_version` archive. */
  async correctPriceAmount(
    priceId: string,
    amount: Money,
    stamp: { by: string; at: Date },
  ): Promise<PriceRow> {
    const row = await this.prisma.price.update({
      where: { id: priceId },
      data: {
        amount: amount.toString(),
        changedById: stamp.by,
        changedAt: stamp.at,
      },
    });
    return toPriceRow(row);
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

/** BI-282. The order of the kinds in the unfiltered list. */
const KIND_ORDER: readonly ServiceKind[] = [
  'CONSULTATION',
  'LAB_EXAM',
  'IMAGING',
  'PROCEDURE',
  'SUPPLY',
  'OTHER',
];

/** What every service read joins: its rate, its specialty, its extension. */
const SERVICE_INCLUDE = {
  taxRate: true,
  specialty: { select: { name: true } },
  exam: true,
  taxReviewedBy: { select: { firstName: true, lastName: true } },
  writtenConsentSetBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ServiceInclude;

type ServiceRow = ServiceStoredRow & {
  taxRate: TaxRateRow;
  specialty: { name: string } | null;
  exam: ServiceExamRow | null;
  taxReviewedBy: { firstName: string; lastName: string } | null;
  writtenConsentSetBy: { firstName: string; lastName: string } | null;
};

/** BI-284. The extension's fields, without its key and stamps. */
function toOrderExtension(row: ServiceExamRow): OrderExtension {
  return {
    form010Section: row.form010Section,
    specimenType: row.specimenType,
    patientPreparation: row.patientPreparation,
    turnaroundHours: row.turnaroundHours,
    requiresFasting: row.requiresFasting,
    fastingHours: row.fastingHours,
    performedExternally: row.performedExternally,
    externalLabName: row.externalLabName,
    externalLabCode: row.externalLabCode,
  };
}

/**
 * Row to view, with the tax code and percentage taken from the joined rate.
 * The casts lean on `service_kind_is_known` and
 * `service_visit_kind_is_known`; `service_consultation_shape` keeps the three
 * consultation columns together.
 */
function toServiceView(row: ServiceRow): ServiceView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as ServiceKind,
    consultation:
      row.specialtyId === null || row.durationMinutes === null
        ? null
        : {
            specialtyId: row.specialtyId,
            specialtyName: row.specialty?.name ?? '',
            durationMinutes: row.durationMinutes,
            visitKind: row.visitKind as VisitKind | null,
          },
    exam: row.exam === null ? null : toOrderExtension(row.exam),
    mspCode: row.mspCode,
    taxRateId: row.taxRateId,
    taxSriCode: row.taxRate.sriCode,
    taxPercentage:
      row.taxRate.percentage === null
        ? null
        : Percentage.parse(row.taxRate.percentage),
    active: row.active,
    writtenConsent: {
      required: row.requiresWrittenConsent,
      setAt: row.writtenConsentSetAt,
      setById: row.writtenConsentSetById,
      setByName:
        row.writtenConsentSetBy === null
          ? null
          : `${row.writtenConsentSetBy.firstName} ${row.writtenConsentSetBy.lastName}`,
    },
    // The CHECK keeps the two columns together; the user comes with the id.
    taxReview:
      row.taxReviewedAt === null ||
      row.taxReviewedById === null ||
      row.taxReviewedBy === null
        ? null
        : {
            reviewedAt: row.taxReviewedAt,
            reviewedById: row.taxReviewedById,
            reviewedByName: `${row.taxReviewedBy.firstName} ${row.taxReviewedBy.lastName}`,
          },
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
    serviceId: row.serviceId,
    amount: Money.parse(row.amount),
    validFrom: toClinicalDate(row.validFrom),
    validTo: row.validTo === null ? null : toClinicalDate(row.validTo),
  };
}
