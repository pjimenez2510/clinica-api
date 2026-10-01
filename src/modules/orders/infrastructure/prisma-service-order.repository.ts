import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  CatalogConceptNotFoundError,
  CatalogConceptNotInForceError,
} from '../../../shared/domain/errors/catalog-reference.errors';
import { CLINIC_TIME_ZONE } from '../../../shared/domain/clinic-time';
import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import {
  ExamNotOrderableError,
  OrderEncounterNotFoundError,
  OrderEncounterNotOpenError,
  OrderItemNotPendingError,
  OrderNotFoundError,
} from '../domain/orders.errors';
import { admitsNewOrders, isPending } from '../domain/service-order';
import { ageingOf } from '../domain/order-ageing';
import type {
  CancelOrderItem,
  NewServiceOrder,
  OrderQuery,
  PendingOrderEntry,
  PendingOrdersQuery,
  ServiceOrderRepository,
  ServiceOrderView,
  SiteScopeFilter,
} from '../domain/service-order.repository';

/**
 * Order rows in, domain shapes out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY CHECK IS INSIDE THE TRANSACTION THAT WRITES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three things can change between a read and a write here: the attention gets
 * closed by whoever is settling the account, a catalogue release retires the
 * tariff concept, the clinic disables the exam. A caller who could ask any of
 * them first and act later is the race AG-045 was left open by. So the state,
 * the catalogue and the validity are all resolved in the same transaction that
 * inserts the rows, and either everything lands or nothing does (ORD-003).
 *
 * ⚠️ NOTHING HERE READS OR WRITES AN AMOUNT (ORD-002). What the line costs is a
 * `charge_item` of `billing`, resolved from the price list of the payer on the
 * service date. A value that is never loaded cannot leak onto a clinical
 * screen.
 */

/** The catalogue an order line has to be invoiced under (ORD-004). */
const TARIFF = 'TARIFF';

/** One order line with its frozen code and display (ORD-002). */
const ITEM_SELECT = {
  id: true,
  testCode: true,
  testDisplay: true,
  conceptId: true,
  status: true,
  completedAt: true,
  createdAt: true,
} satisfies Prisma.ServiceOrderItemSelect;

/** An order with its lines in the order they were created. */
const ORDER_SELECT = {
  id: true,
  encounterId: true,
  siteId: true,
  orderedById: true,
  number: true,
  category: true,
  priority: true,
  clinicalNoteText: true,
  pendingItems: true,
  requestedAt: true,
  // The chart id travels because the screen links to it. NOTHING about what
  // the person HAS comes with it (ORD-024).
  encounter: { select: { patientId: true } },
  items: { orderBy: { createdAt: 'asc' }, select: ITEM_SELECT },
} satisfies Prisma.ServiceOrderSelect;

/** The shape `ORDER_SELECT` produces. */
type OrderRow = Prisma.ServiceOrderGetPayload<{ select: typeof ORDER_SELECT }>;

/** What one statement can say about a tariff concept, in an attention's date. */
interface ConceptRow {
  id: string;
  concept_code: string;
  system_code: string;
  in_force: boolean;
}

/** The `ServiceOrderRepository` adapter. */
@Injectable()
export class PrismaServiceOrderRepository implements ServiceOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** ORD-001 to ORD-006. Writes one order and every one of its lines. */
  async place(order: NewServiceOrder): Promise<ServiceOrderView> {
    const row = await this.prisma.$transaction(async (tx) => {
      /**
       * THE ATTENTION'S ROW, LOCKED FIRST. Agenda locks it FOR UPDATE when
       * reception marks «se fue sin ser atendido» or the doctor annuls the
       * attention; locking it here serialises the two, and every read below
       * —this transaction is READ COMMITTED— sees the attention as it ended
       * up. Without it, a write that read «open» an instant before the
       * annulment committed lands in an annulled attention.
       */
      await tx.$queryRaw`SELECT id FROM "encounter" WHERE id = ${order.encounterId}::uuid FOR UPDATE`;

      /**
       * ORD-005, ORD-090. The attention, inside the caller's scope, WITH ITS
       * STATE — and the site comes from here rather than from the request. An
       * order emitted at one site and stored under another breaks the scope of
       * everything that later hangs off it, and the caller has no business
       * choosing.
       */
      const encounter = await tx.encounter.findFirst({
        where: { id: order.encounterId, ...siteFilter(order.sites) },
        select: {
          id: true,
          siteId: true,
          status: true,
          // ORD-001. WHO SIGNS THE ORDER, taken from the attention and never
          // from the request. See the note on `NewServiceOrder`.
          practitionerId: true,
        },
      });
      if (!encounter) throw new OrderEncounterNotFoundError();
      if (!admitsNewOrders(encounter.status)) {
        throw new OrderEncounterNotOpenError(encounter.status);
      }

      /**
       * ORD-002, ORD-003. The orderables, read again INSIDE the transaction.
       * The service already refused a retired one and this is not ceremony: a
       * catalogue edit can land between the two, and the row that lands is the
       * one that matters.
       */
      const examIds = [...new Set(order.lines.map((l) => l.examDefinitionId))];
      const exams = await tx.examDefinition.findMany({
        where: { id: { in: examIds }, active: true },
        select: { id: true, code: true, name: true, tariffCode: true },
      });
      if (exams.length !== examIds.length) throw new ExamNotOrderableError();
      const examById = new Map(exams.map((exam) => [exam.id, exam]));

      const conceptByExam = await tariffConceptsInForce(
        tx,
        order.encounterId,
        exams,
      );

      return tx.serviceOrder.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          orderedById: encounter.practitionerId,
          category: order.category,
          priority: order.priority,
          clinicalNoteText: order.clinicalNoteText ?? null,
          items: {
            create: order.lines.map((line) => ({
              conceptId: conceptByExam.get(line.examDefinitionId) ?? '',
              /**
               * ORD-002. FROZEN HERE, from the definition read in this same
               * transaction. In fifteen years the catalogue may have been
               * migrated, pruned or reloaded and the order still has to say
               * what was asked for — the same reason an invoice stores the
               * price and not only the product id.
               */
              testCode: examById.get(line.examDefinitionId)?.code ?? '',
              testDisplay: examById.get(line.examDefinitionId)?.name ?? '',
            })),
          },
        },
        select: ORDER_SELECT,
      });
    });

    return toOrderView(row);
  }

  /** ORD-009. One order, within the caller's scope. */
  async byId(query: OrderQuery): Promise<ServiceOrderView | undefined> {
    const row = await this.prisma.serviceOrder.findFirst({
      where: { id: query.orderId, ...siteFilter(query.sites) },
      select: ORDER_SELECT,
    });
    return row ? toOrderView(row) : undefined;
  }

  /** ORD-002, ORD-009. The orders of one attention, newest first. */
  async ofEncounter(
    encounterId: string,
    sites: SiteScopeFilter,
  ): Promise<ServiceOrderView[]> {
    const rows = await this.prisma.serviceOrder.findMany({
      where: { encounterId, ...siteFilter(sites) },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      select: ORDER_SELECT,
    });
    return rows.map(toOrderView);
  }

  /**
   * ORD-020 to ORD-025. What was asked for and has not come back, oldest
   * first.
   *
   * ⚠️ IT FILTERS ON `pending_items > 0` AND NOT ON A SUBQUERY, which is the
   * whole reason that denormalised counter exists: index predicates cannot
   * contain subqueries, so `service_order_pending_by_site` could not otherwise
   * be partial — and a partial index is what keeps this list answerable from
   * cache no matter how many orders the clinic has ever placed. The counter is
   * maintained by `trg_service_order_item_pending`, never by this file.
   *
   * ⚠️ AND THE CHART FILTER GOES THROUGH `chartScope` (ORD-093, PA-055). If the
   * patient had two charts and a merge absorbed one, an order placed on the
   * absorbed chart is STILL hers. Reading by a bare `patient_id` would return
   * half her history WITHOUT FAILING, which is the worst way to be wrong.
   */
  async pending(query: PendingOrdersQuery): Promise<PendingOrderEntry[]> {
    const rows = await this.prisma.serviceOrder.findMany({
      where: {
        pendingItems: { gt: 0 },
        ...siteFilter(query.sites),
        ...(query.category ? { category: query.category } : {}),
        ...(query.chartId ? { encounter: chartScope(query.chartId) } : {}),
        items: {
          some: {
            completedAt: null,
            ...(query.examCode ? { testCode: query.examCode } : {}),
          },
        },
      },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      select: {
        id: true,
        siteId: true,
        encounterId: true,
        orderedById: true,
        number: true,
        category: true,
        priority: true,
        requestedAt: true,
        encounter: {
          select: {
            patientId: true,
            // ORD-026. Read only when asked: the plain worklist never sees it.
            patient: query.includePatientName
              ? { select: { givenName: true, familyName: true } }
              : false,
          },
        },
        items: {
          where: {
            completedAt: null,
            ...(query.examCode ? { testCode: query.examCode } : {}),
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, testCode: true, testDisplay: true },
        },
      },
    });

    /**
     * ORD-022. The promised turnaround belongs to the DEFINITION, not to the
     * line, so it is read once for every code on the page rather than per row.
     * An exam retired since is still resolved — `test_code` was frozen for
     * exactly this.
     */
    const codes = [...new Set(rows.flatMap((r) => r.items.map((i) => i.testCode)))]; // prettier-ignore
    const turnaround = new Map<string, number | null>(
      (
        await this.prisma.examDefinition.findMany({
          where: { code: { in: codes } },
          select: { code: true, turnaroundHours: true },
        })
      ).map((exam) => [exam.code, exam.turnaroundHours]),
    );

    return rows.flatMap((order) =>
      order.items.map((item) => ({
        orderId: order.id,
        orderNumber: order.number,
        itemId: item.id,
        siteId: order.siteId,
        patientId: order.encounter.patientId,
        encounterId: order.encounterId,
        orderedById: order.orderedById,
        category: order.category,
        priority: order.priority,
        testCode: item.testCode,
        testDisplay: item.testDisplay,
        requestedAt: order.requestedAt,
        patientName: order.encounter.patient
          ? `${order.encounter.patient.givenName} ${order.encounter.patient.familyName}`
          : null,
        /**
         * ORD-022. `undefined` from the map — a code with no definition at all
         * — becomes `null`, «no hay plazo comprometido». It must not become a
         * default number: a made-up deadline says «va bien» or «lleva retraso»
         * about an exam nobody promised anything for, and both are lies.
         */
        ageing: ageingOf(
          order.requestedAt,
          query.now,
          turnaround.get(item.testCode) ?? null,
        ),
      })),
    );
  }

  /** ORD-007, ORD-008. Cancels one line, leaving the row where it is. */
  async cancelItem(request: CancelOrderItem): Promise<ServiceOrderView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const item = await tx.serviceOrderItem.findFirst({
        where: {
          id: request.itemId,
          serviceOrderId: request.orderId,
          serviceOrder: siteFilter(request.sites),
        },
        select: { id: true, status: true },
      });
      if (!item) throw new OrderNotFoundError();
      if (!isPending(item.status)) throw new OrderItemNotPendingError();

      /**
       * ORD-007. BOTH COLUMNS, and neither alone is enough: the status is what
       * a human reads, and `completed_at` is what takes the row out of
       * `service_order_item_pending` and makes the trigger lower
       * `pending_items`. Setting one and not the other leaves the record and
       * the worklist disagreeing about the same line.
       */
      await tx.serviceOrderItem.update({
        where: { id: item.id },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });

      return tx.serviceOrder.findFirstOrThrow({
        where: { id: request.orderId },
        select: ORDER_SELECT,
      });
    });

    return toOrderView(row);
  }

  /**
   * ORD-080, ORD-081. The LIVE chart that holds this cedula.
   *
   * ⚠️ `patient_merged: false` IS WHAT KEEPS THE ABSORBED CHART OUT.
   * `patient_identifier` is the one child table a merge re-points (PA-043),
   * and the denormalised flag is
   * what lets the surviving chart keep the cedula while the absorbed one
   * releases it. Asking without it would return the absorbed chart and send a
   * paper report to a record nobody opens.
   *
   * ⚠️ AND THE WHERE IS THE KEY AND PREDICATE OF
   * `patient_identifier_active_unique` (its `type <> 'PROVISIONAL'` is implied
   * by `type = 'CEDULA'`). The index is unique on (type, issuing_country,
   * value) and only for `OFFICIAL` rows, so the bare number may sit on two
   * charts: a `COL` cedula and an `ECU` one, or an `OLD` row and the
   * `OFFICIAL` one. Asking for less than the index lets the scan pick the
   * chart, and the paper report lands on somebody else. The cedula of this
   * path is the Ecuadorian one (ORD-081); a chart holding the number only as
   * a foreign document is not found here (D-066).
   *
   * It follows the INDEX, not `valid_to`: nothing writes `valid_to` yet, and
   * whether a closed cedula still resolves is PA-014's decision, to be taken
   * with document replacement.
   *
   * ⚠️ AND THERE IS NO `create` ANYWHERE NEAR THIS METHOD (ORD-080).
   */
  async chartByCedula(cedula: string): Promise<string | undefined> {
    const row = await this.prisma.patientIdentifier.findFirst({
      where: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: cedula,
        use: 'OFFICIAL',
        patientMerged: false,
      },
      select: { patientId: true },
    });
    return row?.patientId;
  }
}

/**
 * ORD-004. The tariff concept of each exam: the version of its
 * `tariff_code` in force on the CLINICAL DATE of the attention.
 *
 * ⚠️ RAW SQL BECAUSE OF ONE COLUMN. `catalog_concept.valid_period` is a
 * `daterange` generated by a manual migration, which Prisma models as
 * `Unsupported`, so `@>` cannot be expressed through the client. Writing the
 * containment here rather than reading the two dates and comparing them in
 * TypeScript is deliberate: `trg_diagnosis_concept_in_force` uses `@>` on the
 * same generated column, and two statements of one predicate is how they end
 * up disagreeing about the last day a code was valid.
 *
 * ⚠️ AND THE DATE IS RESOLVED IN `America/Guayaquil`. A bare `::date` over a
 * `timestamptz` uses the SESSION's zone, so an order placed at 20:00 on the
 * last day a tariff code was in force would be checked against the following
 * day and refused — the defect
 * `20260806040611_clinical_date_in_ecuador_timezone` exists to have fixed.
 */
async function tariffConceptsInForce(
  tx: Prisma.TransactionClient,
  encounterId: string,
  exams: readonly { id: string; tariffCode: string | null }[],
): Promise<Map<string, string>> {
  const codes = [
    ...new Set(
      exams.flatMap((exam) => (exam.tariffCode ? [exam.tariffCode] : [])),
    ),
  ];
  const rows =
    codes.length === 0
      ? []
      : await tx.$queryRaw<ConceptRow[]>`
    SELECT cc."id"::text        AS id,
           cc."code"::text      AS concept_code,
           cs."code"::text      AS system_code,
           (cc."valid_period" @> (e."started_at" AT TIME ZONE ${CLINIC_TIME_ZONE})::date)
                                AS in_force
      FROM "encounter" AS e
      JOIN "catalog_system"  AS cs ON cs."code" = ${TARIFF}
      JOIN "catalog_concept" AS cc
        ON cc."system_id" = cs."id"
       AND cc."code" IN (${Prisma.join(codes)})
     WHERE e."id" = ${encounterId}::uuid
  `;

  const conceptByExam = new Map<string, string>();
  for (const exam of exams) {
    const versions = rows.filter((row) => row.concept_code === exam.tariffCode);
    /**
     * ORD-004. An exam with no tariff code and one whose code is not in the
     * tariff answer the SAME refusal, `CATALOG_CONCEPT_NOT_FOUND` — the shared
     * code, reused rather than reinvented. Only the TARIFF system is read, so
     * a CIE-10 code that happens to match is not found either.
     */
    if (exam.tariffCode === null || versions.length === 0) {
      throw CatalogConceptNotFoundError.byCode(
        TARIFF,
        exam.tariffCode ?? '—',
        'items',
      );
    }
    const inForce = versions.find((row) => row.in_force);
    if (!inForce) {
      throw new CatalogConceptNotInForceError(
        exam.tariffCode,
        'la fecha de la atención',
        'items',
      );
    }
    conceptByExam.set(exam.id, inForce.id);
  }
  return conceptByExam;
}

/**
 * ORD-090. The caller's resolved scope as a `where` fragment on the order.
 *
 * `'all'` yields no filter, and an empty list never reaches here: `siteScope`
 * in `shared/authorisation` throws `SITE_SCOPE_DENIED` when the caller holds
 * the permission at no site, precisely so «no filter to apply» can never be
 * spelled as «every site».
 */
function siteFilter(sites: SiteScopeFilter): { siteId?: { in: string[] } } {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/** A `service_order` row with its lines, as the domain reads it. */
function toOrderView(row: OrderRow): ServiceOrderView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    siteId: row.siteId,
    patientId: row.encounter.patientId,
    orderedById: row.orderedById,
    number: row.number,
    category: row.category,
    priority: row.priority,
    clinicalNoteText: row.clinicalNoteText,
    pendingItems: row.pendingItems,
    requestedAt: row.requestedAt,
    items: row.items.map((item) => ({
      id: item.id,
      testCode: item.testCode,
      testDisplay: item.testDisplay,
      conceptId: item.conceptId,
      status: item.status,
      completedAt: item.completedAt,
      createdAt: item.createdAt,
    })),
  };
}
