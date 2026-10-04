import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  OrderItemNotMatchableError,
  OrderNotFoundError,
  ResultAlreadyMatchedError,
  ResultNotFoundError,
  ResultSupersededError,
} from '../domain/orders.errors';
import { isLineComplete } from '../domain/service-order';
import type {
  CriticalChain,
  CriticalNoticeView,
  DiagnosticReportRepository,
  DiagnosticReportView,
  ExpectedAnalytes,
  FlaggedResultEntry,
  MatchResultCommand,
  MatchableResult,
  NewCriticalNotice,
  NewReport,
  ObservationView,
  OrderPatient,
  ReportQuery,
  ResultQuery,
  SafetyPolicy,
  SafetyWorklistQuery,
} from '../domain/diagnostic-report.repository';
import { chainKey } from '../domain/diagnostic-report.repository';
import type { SiteScopeFilter } from '../domain/service-order.repository';

/**
 * Report rows in, domain shapes out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO `update` OF A VALUE IN THIS FILE, AND THAT IS THE REQUIREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ORD-050. A correction is a new `diagnostic_report` pointing at the old one
 * through `supersedes_id`, and every `observation_result` of the old report
 * stays exactly as it was written. The only `update` this class issues is on
 * `service_order_item.completed_at`, which is a worklist fact and not a
 * clinical value.
 *
 * A value that changes in silence is a safety incident, not an edit: the
 * clinician who read 95 mg/dL and sent the patient home has to be able to see
 * the 95, and the record has to be able to say from when it stopped being
 * true.
 *
 * ⚠️ AND THE FLAG IS NEVER COMPUTED HERE (ORD-035). It arrives already
 * resolved from the domain, together with the unit and the frozen range. An
 * adapter able to compute a flag would be a second place where the clinic's
 * critical thresholds live, and two places is how they end up disagreeing on
 * the one number that decides whether somebody is phoned tonight.
 */

/**
 * ORD-062. A notice with the name of who gave it — the trail says WHO, and a
 * user id is not something a reader of a clinical record recognises.
 */
const NOTICE_SELECT = {
  id: true,
  observationResultId: true,
  recipientKind: true,
  recipientName: true,
  channel: true,
  notifiedAt: true,
  note: true,
  outcome: true,
  readBackConfirmed: true,
  afterHours: true,
  selfNotice: true,
  notifiedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.CriticalResultNoticeSelect;

/** The shape `NOTICE_SELECT` produces. */
type NoticeRow = Prisma.CriticalResultNoticeGetPayload<{
  select: typeof NOTICE_SELECT;
}>;

/**
 * One stored result with its frozen unit, range and flag (ORD-034, ORD-037).
 */
const RESULT_SELECT = {
  id: true,
  orderItemId: true,
  analyteConceptId: true,
  analyteDisplay: true,
  valueNumeric: true,
  valueText: true,
  valueCode: true,
  unit: true,
  referenceLow: true,
  referenceHigh: true,
  referenceText: true,
  abnormalFlag: true,
  observedAt: true,
  notices: {
    orderBy: [{ notifiedAt: 'asc' }, { id: 'asc' }],
    select: NOTICE_SELECT,
  },
} satisfies Prisma.ObservationResultSelect;

/** The shape `RESULT_SELECT` produces. */
type ResultRow = Prisma.ObservationResultGetPayload<{
  select: typeof RESULT_SELECT;
}>;

/**
 * A report with its results in insertion order, and the correction that
 * superseded it, if any.
 */
const REPORT_SELECT = {
  id: true,
  serviceOrderId: true,
  status: true,
  performedById: true,
  conclusion: true,
  issuedAt: true,
  supersedesId: true,
  // ORD-051. The correction that replaced this one, so a reader is told the
  // number in front of them has been superseded — and when.
  supersededBy: { select: { id: true, issuedAt: true, createdAt: true } },
  results: { orderBy: { id: 'asc' }, select: RESULT_SELECT },
} satisfies Prisma.DiagnosticReportSelect;

/** The shape `REPORT_SELECT` produces. */
type ReportRow = Prisma.DiagnosticReportGetPayload<{
  select: typeof REPORT_SELECT;
}>;

/** The `DiagnosticReportRepository` adapter. */
@Injectable()
export class PrismaDiagnosticReportRepository implements DiagnosticReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** ORD-030 to ORD-042. The report, its determinations and the lines it closes. */
  async register(
    report: NewReport,
    expected: readonly ExpectedAnalytes[],
  ): Promise<DiagnosticReportView> {
    const row = await this.prisma.$transaction(async (tx) => {
      /**
       * ORD-090. The order, inside the caller's scope, checked again INSIDE the
       * transaction. The service already refused one out of scope and this is
       * not ceremony: between that read and this write a grant can be revoked,
       * and the row that lands is the one that matters.
       */
      const order = await tx.serviceOrder.findFirst({
        where: { id: report.serviceOrderId, ...siteFilter(report.sites) },
        select: { id: true },
      });
      if (!order) throw new OrderNotFoundError();

      /**
       * ORD-062 (tercera revisión). A correction LOCKS the report it replaces
       * before inserting. `FOR NO KEY UPDATE` conflicts with the `FOR SHARE` a
       * notice takes on the same row, so a notice and a correction no longer
       * pass each other: whichever comes second waits, and then reads what the
       * first committed. The foreign key alone takes `FOR KEY SHARE`, which
       * conflicts with nothing a notice takes.
       */
      if (report.supersedesId) {
        await tx.$queryRaw`
          SELECT 1 FROM "diagnostic_report"
           WHERE "id" = ${report.supersedesId}::uuid
             FOR NO KEY UPDATE
        `;
      }

      const created = await tx.diagnosticReport.create({
        data: {
          serviceOrderId: report.serviceOrderId,
          status: report.status,
          performedById: report.performedById,
          conclusion: report.conclusion ?? null,
          issuedAt: report.issuedAt,
          supersedesId: report.supersedesId ?? null,
          results: {
            create: report.results.map((result) => ({
              orderItemId: result.orderItemId,
              /**
               * ⚠️ **Falta esquema (ORD-031)**, and this `null` is where it
               * shows. `observation_result` has no `analyte_definition_id`;
               * its only pointer is `analyte_concept_id`, which targets
               * `catalog_concept`, and no ANALYTE catalogue system exists. So
               * the resultable definition is NOT referenced from the row, and
               * `analyte_display` is the whole link back — which is the exact
               * fragility the two-catalogue design exists to remove. A
               * concept id invented here would be a false reference into a
               * catalogue that does not contain analytes.
               */
              analyteConceptId: null,
              analyteDisplay: result.analyteDisplay,
              valueNumeric: result.valueNumeric,
              valueText: result.valueText,
              valueCode: result.valueCode,
              unit: result.unit,
              referenceLow: result.referenceLow,
              referenceHigh: result.referenceHigh,
              referenceText: result.referenceText,
              abnormalFlag: result.abnormalFlag,
              observedAt: report.issuedAt,
            })),
          },
        },
        select: { id: true },
      });

      await closeFinishedLines(tx, expected);

      return tx.diagnosticReport.findFirstOrThrow({
        where: { id: created.id },
        select: REPORT_SELECT,
      });
    });

    return toReportView(row);
  }

  /** ORD-051. One report, within the caller's scope. */
  async byId(query: ReportQuery): Promise<DiagnosticReportView | undefined> {
    const row = await this.prisma.diagnosticReport.findFirst({
      where: {
        id: query.reportId,
        serviceOrder: siteFilter(query.sites),
      },
      select: REPORT_SELECT,
    });
    return row ? toReportView(row) : undefined;
  }

  /** ORD-051. Every report of one order, newest first, corrections included. */
  async ofOrder(
    orderId: string,
    sites: SiteScopeFilter,
  ): Promise<DiagnosticReportView[]> {
    const rows = await this.prisma.diagnosticReport.findMany({
      where: { serviceOrderId: orderId, serviceOrder: siteFilter(sites) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: REPORT_SELECT,
    });
    return rows.map(toReportView);
  }

  /**
   * ORD-036. Who the order is for, and how old they were THAT DAY.
   *
   * ⚠️ `age_days` COMES FROM THE ATTENTION AND THE SEX FROM THE CHART, and the
   * asymmetry is deliberate. The age is frozen by `trg_encounter_freeze_age`
   * and never recomputed, so a report transcribed two years later still
   * classifies against the age the patient HAD; deriving it from
   * `birth_date` at transcription time would silently reclassify neonatal
   * results as adult ones.
   */
  async patientOfOrder(
    orderId: string,
    sites: SiteScopeFilter,
  ): Promise<OrderPatient | undefined> {
    const row = await this.prisma.serviceOrder.findFirst({
      where: { id: orderId, ...siteFilter(sites) },
      select: {
        siteId: true,
        encounter: {
          select: {
            patientId: true,
            ageDays: true,
            patient: { select: { sex: true } },
          },
        },
      },
    });
    if (!row) return undefined;

    return {
      patientId: row.encounter.patientId,
      siteId: row.siteId,
      sex: row.encounter.patient.sex,
      ageDays: row.encounter.ageDays,
    };
  }

  /** ORD-040, ORD-041. Values that answer no ordered line. Never auto-matched. */
  async unmatched(query: SafetyWorklistQuery): Promise<FlaggedResultEntry[]> {
    const rows = await this.prisma.observationResult.findMany({
      where: {
        orderItemId: null,
        /**
         * ORD-041, ORD-043. ONLY THE STANDING VERSION, as on the critical
         * queue: a value the laboratory retracted is not somebody's to pair,
         * and pairing it would close a line with a figure that no longer
         * stands.
         */
        report: { serviceOrder: siteFilter(query.sites), supersededBy: null },
      },
      // Oldest first: what has waited longest is what is closest to lost.
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      select: WORKLIST_SELECT,
    });
    return rows.map(toWorklistEntry);
  }

  /** ORD-043. One result of that queue, within the caller's scope. */
  async resultById(query: ResultQuery): Promise<MatchableResult | undefined> {
    const id = toResultId(query.resultId);
    if (id === undefined) return undefined;

    const row = await this.prisma.observationResult.findFirst({
      where: { id, report: { serviceOrder: siteFilter(query.sites) } },
      select: {
        id: true,
        reportId: true,
        orderItemId: true,
        abnormalFlag: true,
        observedAt: true,
        report: {
          select: {
            serviceOrderId: true,
            serviceOrder: {
              select: {
                siteId: true,
                orderedBy: { select: { userId: true } },
              },
            },
            supersededBy: { select: { createdAt: true } },
          },
        },
      },
    });
    if (!row) return undefined;

    return {
      resultId: row.id.toString(),
      reportId: row.reportId,
      orderId: row.report.serviceOrderId,
      orderItemId: row.orderItemId,
      abnormalFlag: row.abnormalFlag,
      observedAt: row.observedAt,
      siteId: row.report.serviceOrder.siteId,
      superseded: row.report.supersededBy !== null,
      supersededAt: row.report.supersededBy?.createdAt ?? null,
      orderedByUserId: row.report.serviceOrder.orderedBy.userId,
    };
  }

  /**
   * ORD-043. Points an orphan result at a line of its own order.
   *
   * ⚠️ EVERY CONDITION IS RE-JUDGED INSIDE THE TRANSACTION, and none of them is
   * ceremony. The line can be cancelled, the grant revoked and a colleague can
   * resolve the same queue entry between the service's read and this write —
   * the third is not hypothetical, it is what two people working one worklist
   * do all morning.
   *
   * ⚠️ AND THE ORDER IS PART OF THE `WHERE`. Nothing in the schema stops an
   * observation of order A from pointing at a line of order B (⚠️ **Falta
   * esquema**, ORD-043: there is no `CHECK` tying `order_item_id` to the
   * report's order), and that pairing would close a line with somebody else's
   * blood. This statement is the whole of the guarantee, so it is written where
   * the row lands rather than one layer up.
   */
  async match(
    command: MatchResultCommand,
    expected: ExpectedAnalytes,
  ): Promise<DiagnosticReportView> {
    const id = toResultId(command.resultId);
    if (id === undefined) throw new ResultNotFoundError();

    const row = await this.prisma.$transaction(async (tx) => {
      /**
       * The line has to be of THIS order and not cancelled. A cancelled line
       * answers nothing — ORD-007 took it out of the worklist on purpose — and
       * pointing a value at it would put a reading under a request that was
       * withdrawn.
       */
      const item = await tx.serviceOrderItem.findFirst({
        where: { id: command.orderItemId, serviceOrderId: command.orderId },
        select: { status: true },
      });
      if (!item || item.status === 'CANCELLED') {
        throw new OrderItemNotMatchableError();
      }

      const updated = await tx.observationResult.updateMany({
        where: {
          id,
          // ORD-040, ORD-043. Still orphaned: the loser of the race is refused
          // rather than allowed to re-point a resolved row.
          orderItemId: null,
          report: {
            serviceOrderId: command.orderId,
            serviceOrder: siteFilter(command.sites),
            // ORD-043. Never a retracted value, judged where the row lands.
            supersededBy: null,
          },
        },
        data: { orderItemId: command.orderItemId },
      });
      if (updated.count === 0) {
        /**
         * Two situations reach here and they are told apart by ONE read: the
         * row is gone or out of scope, or it was already paired. The second is
         * the ordinary one and deserves its own sentence — «actualice la
         * lista» is useless advice to somebody whose row simply is not there.
         */
        const current = await tx.observationResult.findFirst({
          where: { id, report: { serviceOrder: siteFilter(command.sites) } },
          select: {
            orderItemId: true,
            report: { select: { supersededBy: { select: { id: true } } } },
          },
        });
        if (!current) throw new ResultNotFoundError();
        if (current.orderItemId === null && current.report.supersededBy) {
          throw new ResultSupersededError();
        }
        throw new ResultAlreadyMatchedError();
      }

      /**
       * ORD-039. The line may now be complete, and it may not: the analyte that
       * arrived unasked is usually one the exam never promised. The rule is
       * asked either way, with the SAME function the registration uses, so a
       * line closed by a pairing and a line closed by a report cannot disagree
       * about what «completa» means.
       */
      await closeFinishedLines(tx, [expected]);

      return tx.diagnosticReport.findFirstOrThrow({
        where: { results: { some: { id } } },
        select: REPORT_SELECT,
      });
    });

    return toReportView(row);
  }

  /**
   * ORD-060, ORD-061. The values that have to reach a human today.
   *
   * Built on the flag THIS system computed from its own `CRITICAL` ranges, not
   * on anything the laboratory sent — many send only «alto/bajo», some send
   * nothing, and the ones that phone do it to whoever picks up.
   */
  async critical(query: {
    sites: SiteScopeFilter;
  }): Promise<FlaggedResultEntry[]> {
    const rows = await this.prisma.observationResult.findMany({
      where: {
        abnormalFlag: { in: ['CRITICAL_LOW', 'CRITICAL_HIGH'] },
        report: {
          serviceOrder: siteFilter(query.sites),
          /**
           * ⚠️ ONLY THE STANDING VERSION. Found by walking the flow: a glucose
           * of 450 was corrected to 95, and the 450 stayed on this queue as
           * something still to be phoned in.
           *
           * That is not cosmetic. This queue exists to make somebody act on a
           * value, and acting on a figure the laboratory has already retracted
           * means calling a patient about a result that is not theirs — which
           * is worse than the silence the queue was built to prevent.
           *
           * A correction is a NEW report pointing at the old one through
           * `supersedes_id`, and the old one stays readable on purpose (ORD-050, ORD-051
           * — a value that changes in silence is a safety incident). So the
           * record keeps both, and the WORKLIST shows only the one that still
           * stands.
           */
          supersededBy: null,
        },
        /**
         * ORD-062, ORD-067, D-113 b. NOT YET NOTIFIED. A notice actually given
         * takes the value off — somebody was told, with a name and an hour.
         * An unanswered call does NOT (D-111 §5), and neither does the
         * ordering practitioner «notifying» themselves: the patient at home
         * still knows nothing.
         */
        notices: { none: { outcome: 'NOTIFIED', selfNotice: false } },
      },
      /**
       * OLDEST FIRST, and NEVER CUT (ORD-060). A value waiting for its notice
       * off the screen is a value nobody notifies — and with the oldest first,
       * the one cut off would be today's.
       */
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      select: WORKLIST_SELECT,
    });
    return rows.map(toWorklistEntry);
  }

  /**
   * ORD-065, ORD-067. For each report, its correction chain back to the first
   * report: per analyte, when its FIRST CRITICAL version was observed, whether
   * an earlier version was already notified, and the unanswered calls made
   * anywhere along the chain. One recursive query for the whole list.
   */
  async criticalChains(
    reportIds: readonly string[],
  ): Promise<ReadonlyMap<string, CriticalChain>> {
    if (reportIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      {
        start_id: string;
        analyte_display: string;
        first_observed_at: Date | null;
        previously_notified: bigint;
        attempts: bigint;
        ordering_unanswered: bigint;
      }[]
    >`
      WITH RECURSIVE chain AS (
        SELECT r."id" AS start_id, r."id" AS report_id, r."supersedes_id",
               0 AS depth
          FROM "diagnostic_report" r
         WHERE r."id" = ANY(${[...new Set(reportIds)]}::uuid[])
        UNION ALL
        SELECT c.start_id, p."id", p."supersedes_id", c.depth + 1
          FROM chain c
          JOIN "diagnostic_report" p ON p."id" = c."supersedes_id"
         -- A cycle is impossible by construction (the UNIQUE on supersedes_id
         -- and insertion order); the guard costs nothing if that ever changes.
         WHERE c.depth < 100
      )
      SELECT c.start_id::text AS start_id,
             o."analyte_display",
             -- From the first CRITICAL version: a 95 corrected to 22 has been
             -- waiting since the 22, not since the 95 (tercera revisión).
             MIN(o."observed_at") FILTER (
               WHERE o."abnormal_flag" IN ('CRITICAL_LOW', 'CRITICAL_HIGH')
             ) AS first_observed_at,
             -- A notice actually given about an EARLIER version of the chain.
             COUNT(n."id") FILTER (
               WHERE n."outcome" = 'NOTIFIED'
                 AND NOT n."self_notice"
                 AND c.report_id <> c.start_id
             ) AS previously_notified,
             COUNT(n."id") FILTER (WHERE n."outcome" = 'NO_ANSWER') AS attempts,
             COUNT(n."id") FILTER (
               WHERE n."outcome" = 'NO_ANSWER'
                 AND n."recipient_kind" = 'ORDERING_PRACTITIONER'
             ) AS ordering_unanswered
        FROM chain c
        JOIN "observation_result" o ON o."report_id" = c.report_id
        LEFT JOIN "critical_result_notice" n
               ON n."observation_result_id" = o."id"
       GROUP BY c.start_id, o."analyte_display"
    `;

    return new Map(
      rows.map((row) => [
        chainKey(row.start_id, row.analyte_display),
        {
          firstObservedAt: row.first_observed_at,
          previouslyNotified: Number(row.previously_notified) > 0,
          noAnswerAttempts: Number(row.attempts),
          orderingUnanswered: Number(row.ordering_unanswered),
        },
      ]),
    );
  }

  /** ORD-046, ORD-063, ORD-065. Each site's worklist policy. */
  async safetyPolicies(
    siteIds: readonly string[],
  ): Promise<ReadonlyMap<string, SafetyPolicy>> {
    if (siteIds.length === 0) return new Map();

    const rows = await this.prisma.siteParameter.findMany({
      where: { siteId: { in: [...new Set(siteIds)] } },
      select: {
        siteId: true,
        criticalNoticeWithinMinutes: true,
        criticalEscalationRole: { select: { id: true, name: true } },
        unmatchedResultOwnerRole: { select: { id: true, name: true } },
        unmatchedResultDeadlineHours: true,
      },
    });

    return new Map(
      rows.map((row) => [
        row.siteId,
        {
          criticalNoticeWithinMinutes: row.criticalNoticeWithinMinutes,
          criticalEscalationRole: row.criticalEscalationRole,
          unmatchedResultOwnerRole: row.unmatchedResultOwnerRole,
          unmatchedResultDeadlineHours: row.unmatchedResultDeadlineHours,
        },
      ]),
    );
  }

  /**
   * ORD-068. Sites in hours at `at`, judged in `America/Guayaquil`.
   *
   * NO OPENING HOURS EXIST IN THE MODEL, so the site's hours are its
   * practitioners' (`practitioner_schedule_rule`): in hours when some active
   * rule of the site, valid that day (`validity`, inclusive), covers that ISO
   * weekday and wall-clock time, and the day is not a holiday the site keeps —
   * national or its own, unless it works it (`holiday_site_exception`).
   */
  async sitesInHours(
    siteIds: readonly string[],
    at: Date,
  ): Promise<ReadonlySet<string>> {
    if (siteIds.length === 0) return new Set();

    const rows = await this.prisma.$queryRaw<{ site_id: string }[]>`
      WITH here AS (
        SELECT (${at}::timestamptz AT TIME ZONE 'America/Guayaquil') AS local
      )
      SELECT s."id"::text AS site_id
        FROM "site" s, here
       WHERE s."id" = ANY(${[...new Set(siteIds)]}::uuid[])
         AND EXISTS (
               SELECT 1 FROM "practitioner_schedule_rule" r
                WHERE r."site_id" = s."id"
                  AND r."active"
                  AND r."weekday" = EXTRACT(ISODOW FROM here.local)::int
                  AND r."validity" @> here.local::date
                  AND here.local::time >= r."start_time"
                  AND here.local::time <  r."end_time")
         AND NOT EXISTS (
               SELECT 1 FROM "holiday" h
                WHERE h."date" = here.local::date
                  AND (h."site_id" IS NULL OR h."site_id" = s."id")
                  AND NOT EXISTS (
                        SELECT 1 FROM "holiday_site_exception" e
                         WHERE e."holiday_id" = h."id" AND e."site_id" = s."id"))
    `;
    return new Set(rows.map((row) => row.site_id));
  }

  /** ORD-062. The notice of a critical value; never rewritten (ORD-064). */
  async recordNotice(notice: NewCriticalNotice): Promise<CriticalNoticeView> {
    const row = await this.prisma.$transaction((tx) => writeNotice(tx, notice));
    return toNoticeView(row);
  }
}

/**
 * ORD-062. Writes the notice, after judging the scope again inside the
 * transaction — the row that lands is the one that matters.
 */
async function writeNotice(
  tx: Prisma.TransactionClient,
  notice: NewCriticalNotice,
): Promise<NoticeRow> {
  const id = toResultId(notice.resultId);
  if (id === undefined) throw new ResultNotFoundError();

  const result = await tx.observationResult.findFirst({
    where: { id, report: { serviceOrder: siteFilter(notice.sites) } },
    select: { id: true, reportId: true },
  });
  if (!result) throw new ResultNotFoundError();

  /**
   * ORD-062. The report is LOCKED FOR SHARE before the supersession is judged:
   * a correction committing between that read and the insert would otherwise
   * leave a notice on a value already retracted. A correction inserts a new
   * report pointing at this one, which the share lock does not block — so the
   * judgement reads the correction, if any, after taking it.
   */
  await tx.$queryRaw`
    SELECT 1 FROM "diagnostic_report" WHERE "id" = ${result.reportId}::uuid FOR SHARE
  `;
  const correction = await tx.diagnosticReport.findFirst({
    where: { supersedesId: result.reportId },
    select: { createdAt: true },
  });
  // A call made before the laboratory retracted the value still gets its
  // record; one made after it is about a figure that no longer stands.
  if (correction && notice.notifiedAt >= correction.createdAt) {
    throw new ResultSupersededError();
  }

  const written = await tx.criticalResultNotice.create({
    data: {
      observationResultId: id,
      recipientKind: notice.recipientKind,
      recipientName: notice.recipientName,
      channel: notice.channel,
      notifiedById: notice.notifiedById,
      notifiedAt: notice.notifiedAt,
      note: notice.note,
      outcome: notice.outcome,
      readBackConfirmed: notice.readBackConfirmed,
      afterHours: notice.afterHours,
      selfNotice: notice.selfNotice,
    },
    select: NOTICE_SELECT,
  });

  /**
   * ORD-062, ORD-091. THE TRAIL ROW IN THE SAME TRANSACTION, as `MFA_RESET`
   * does: a notice is indelible (ORD-064), so a trail failure after it would
   * answer 500 to a notice that exists, and the retry would write a second.
   * Identifiers only — never the value nor who was called.
   */
  await tx.accessAudit.create({
    data: {
      userId: notice.notifiedById,
      resourceType: 'critical_result_notice',
      resourceId: written.id,
      action: 'CREATE',
      ip: notice.trail.ip ?? null,
      userAgent: notice.trail.userAgent ?? null,
    },
  });

  return written;
}

/**
 * What a safety-worklist entry carries: the value, its flag, and the ids needed
 * to reach the order and the chart. No name and no diagnosis.
 */
const WORKLIST_SELECT = {
  id: true,
  reportId: true,
  analyteDisplay: true,
  valueNumeric: true,
  valueCode: true,
  unit: true,
  abnormalFlag: true,
  observedAt: true,
  report: {
    select: {
      serviceOrderId: true,
      serviceOrder: {
        select: {
          siteId: true,
          encounter: { select: { patientId: true } },
          // ORD-046. Who placed it: the owner of an unmatched result by default.
          orderedBy: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ObservationResultSelect;

/** The shape `WORKLIST_SELECT` produces. */
type WorklistRow = Prisma.ObservationResultGetPayload<{
  select: typeof WORKLIST_SELECT;
}>;

/**
 * ORD-039. Closes every line whose determinations are now all in.
 *
 * ⚠️ IT COUNTS WHAT THE ORDER HAS RECEIVED IN TOTAL, not what this report
 * carried. A laboratory that answers a blood count in two instalments is
 * ordinary, and a line that only closed when one message happened to contain
 * every analyte would stay on the worklist for ever.
 *
 * ⚠️ AND IT WRITES BOTH COLUMNS. `completed_at` is what takes the row out of
 * the partial index `service_order_item_pending` and makes
 * `trg_service_order_item_pending` lower `pending_items`; the status is what a
 * human reads. Setting one without the other leaves the record and the
 * worklist disagreeing about the same line.
 */
async function closeFinishedLines(
  tx: Prisma.TransactionClient,
  expected: readonly ExpectedAnalytes[],
): Promise<void> {
  for (const line of expected) {
    const reported = await tx.observationResult.findMany({
      where: { orderItemId: line.orderItemId },
      select: { analyteDisplay: true },
    });

    const arrived = new Set(reported.map((row) => row.analyteDisplay));
    if (!isLineComplete(line.analytes, arrived)) continue;

    await tx.serviceOrderItem.updateMany({
      // `completedAt: null` in the filter is what makes this idempotent: a
      // second report on a closed line must not move the instant at which it
      // was answered.
      where: { id: line.orderItemId, completedAt: null },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }
}

/** ORD-090. The caller's resolved scope, as a filter on the order. */
function siteFilter(sites: SiteScopeFilter): { siteId?: { in: string[] } } {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/**
 * Row to view, with the superseding correction folded into `supersededById` and
 * `supersededAt` (ORD-051).
 */
function toReportView(row: ReportRow): DiagnosticReportView {
  return {
    id: row.id,
    serviceOrderId: row.serviceOrderId,
    status: row.status,
    performedById: row.performedById,
    conclusion: row.conclusion,
    issuedAt: row.issuedAt,
    supersedesId: row.supersedesId,
    supersededById: row.supersededBy?.id ?? null,
    // M1: when the correction was RECORDED in the clinic — the one instant
    // that cuts the notices of this report (ORD-062), and what the screen shows.
    supersededRecordedAt: row.supersededBy?.createdAt ?? null,
    // The correction's own issue instant, falling back to when the row landed:
    // «corregido el …» is a date a person reads, and a null there would print
    // as a blank beside a number somebody may already have acted on.
    supersededAt: row.supersededBy
      ? (row.supersededBy.issuedAt ?? row.supersededBy.createdAt)
      : null,
    results: row.results.map(toObservationView),
  };
}

/**
 * Row to view; the stored flag is passed through as written, never recomputed
 * (ORD-035).
 */
function toObservationView(row: ResultRow): ObservationView {
  return {
    // `observation_result.id` is a `bigint` — the one clinical table with
    // genuinely high row counts. It leaves as a string so no client has to
    // guess whether its JSON parser kept every digit.
    id: row.id.toString(),
    orderItemId: row.orderItemId,
    analyteConceptId: row.analyteConceptId,
    analyteDisplay: row.analyteDisplay,
    valueNumeric: toNumber(row.valueNumeric),
    valueText: row.valueText,
    valueCode: row.valueCode,
    unit: row.unit,
    referenceLow: toNumber(row.referenceLow),
    referenceHigh: toNumber(row.referenceHigh),
    referenceText: row.referenceText,
    abnormalFlag: row.abnormalFlag,
    observedAt: row.observedAt,
    notices: row.notices.map(toNoticeView),
  };
}

/** Row to view, the giver's name joined for a human reader (ORD-062). */
function toNoticeView(row: NoticeRow): CriticalNoticeView {
  return {
    id: row.id,
    resultId: row.observationResultId.toString(),
    recipientKind: row.recipientKind,
    recipientName: row.recipientName,
    channel: row.channel,
    notifiedAt: row.notifiedAt,
    notifiedBy: {
      id: row.notifiedBy.id,
      name: `${row.notifiedBy.firstName} ${row.notifiedBy.lastName}`,
    },
    note: row.note,
    outcome: row.outcome,
    readBackConfirmed: row.readBackConfirmed,
    afterHours: row.afterHours,
    selfNotice: row.selfNotice,
  };
}

/**
 * Row to worklist entry: the result id as a string, the site and chart taken
 * from the order it belongs to.
 */
function toWorklistEntry(row: WorklistRow): FlaggedResultEntry {
  return {
    resultId: row.id.toString(),
    reportId: row.reportId,
    orderId: row.report.serviceOrderId,
    siteId: row.report.serviceOrder.siteId,
    patientId: row.report.serviceOrder.encounter.patientId,
    analyteDisplay: row.analyteDisplay,
    valueNumeric: toNumber(row.valueNumeric),
    valueCode: row.valueCode,
    unit: row.unit,
    abnormalFlag: row.abnormalFlag,
    observedAt: row.observedAt,
    orderedBy: {
      id: row.report.serviceOrder.orderedBy.id,
      name: `${row.report.serviceOrder.orderedBy.user.firstName} ${row.report.serviceOrder.orderedBy.user.lastName}`,
    },
  };
}

/** See the note on `toRange` in the catalogue adapter: bounds, never money. */
function toNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * ORD-043. `observation_result.id` as the database holds it.
 *
 * `undefined` FOR ANYTHING THAT IS NOT A WHOLE NUMBER, and never a throw from
 * `BigInt()`: the id arrives from a URL, so «no es un número» and «no existe»
 * are the same situation to whoever asked, and a `SyntaxError` escaping from an
 * adapter would surface as a 500 on a well-formed refusal.
 */
function toResultId(value: string): bigint | undefined {
  if (!/^\d{1,19}$/.test(value)) return undefined;
  return BigInt(value);
}
