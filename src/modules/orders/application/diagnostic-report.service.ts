import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { LiveEventBus } from '../../../shared/events/live-event-bus';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  DIAGNOSTIC_REPORT_REPOSITORY,
  type CriticalNoticeChannel,
  type CriticalNoticeOutcome,
  type CriticalNoticeRecipient,
  type CriticalNoticeVersionView,
  type CriticalNoticeView,
  type CorrectionWorklistEntry,
  type CriticalWorklistEntry,
  type DiagnosticReportRepository,
  type DiagnosticReportView,
  type ExpectedAnalytes,
  type OrderPatient,
  type ReportedResult,
  type SafetyPolicy,
  type UnmatchedWorklistEntry,
  chainKey,
} from '../domain/diagnostic-report.repository';
import {
  EXAM_CATALOGUE_REPOSITORY,
  type ExamCatalogueRepository,
  type ExamDefinitionView,
} from '../domain/exam-catalogue.repository';
import {
  SERVICE_ORDER_REPOSITORY,
  type ServiceOrderRepository,
  type ServiceOrderView,
} from '../domain/service-order.repository';
import {
  CriticalNoticeNoAnswerStaysError,
  CriticalNoticeNotFoundError,
  CriticalNoticeOfAnotherUserError,
  CriticalNoticeTimeInvalidError,
  CriticalReadBackRequiredError,
  OrderItemNotMatchableError,
  OrderNotFoundError,
  ReportAlreadyCorrectedError,
  ReportCorrectionIncompleteError,
  ReportIssuedInFutureError,
  ReportNotCorrectableError,
  ReportNotFoundError,
  ResultAlreadyMatchedError,
  ResultAnalyteUnknownError,
  ResultFlagIsDerivedError,
  ResultNotCriticalError,
  ResultNotFoundError,
  ResultSupersededError,
} from '../domain/orders.errors';
import {
  isCorrectable,
  isLineComplete,
  supersedingStatus,
} from '../domain/service-order';
import { resolveResult } from '../domain/result-value';
import {
  isSelfNotice,
  samePersonName,
  selfNoticedByOrderer,
  type WorklistNotice,
} from '../domain/notice-recipient';
import { notifiedCorrections } from '../domain/notified-correction';
import type { AnalyteDefinition } from '../domain/analyte';
import {
  appliedCriticalLimits,
  type CriticalLimits,
} from '../domain/abnormal-flag';
import {
  criticalNoticeTarget,
  criticalWait,
  unmatchedWait,
} from '../domain/safety-deadline';
import type { DiagnosticReportStatus } from '../domain/service-order';
import type { Requester } from './service-order.service';

/**
 * ORD-046, ORD-065. What a site with no parameter row would have: sixty
 * minutes for a critical value (D-111 §1) and the ordering practitioner with
 * 24 hours for an unmatched one (D-050 §4).
 * `trg_site_parameter_defaults` makes that row exist; this is the same
 * decision written once more, not a second policy.
 */
const DEFAULT_POLICY: SafetyPolicy = {
  criticalNoticeWithinMinutes: 60,
  criticalEscalationRole: null,
  unmatchedResultOwnerRole: null,
  unmatchedResultDeadlineHours: 24,
};

/**
 * Its own resource type in the trail, and not `'encounter'`.
 *
 * «¿Quién abrió la atención?» and «¿quién leyó el resultado?» are two
 * questions. A laboratory result is what an employer, an insurer or a
 * neighbour would want, so recording it as `'encounter'` would leave an
 * investigation filtering by hand over rows that mean two different things —
 * the argument PA-040 made for the priority groups and `encounter` made again
 * for block K.
 */
const REPORT_RESOURCE_TYPE = 'diagnostic_report';

/** ORD-030 to ORD-042. One transcribed determination, as it arrives. */
export interface SubmittedResult {
  analyteDefinitionId: string;
  valueNumeric?: number | null;
  valueCode?: string | null;
  valueText?: string | null;
  /**
   * ORD-035. ⚠️ ACCEPTED ONLY TO BE REFUSED. The field exists in this shape so
   * a client that sends it gets `RESULT_FLAG_IS_DERIVED` instead of having it
   * silently dropped — which would leave whoever typed it believing their mark
   * is the one on the record, on the datum that decides whether somebody
   * phones the patient tonight.
   */
  abnormalFlag?: string | null;
}

/** ORD-030. What registering a report needs to be told. */
export interface RegisterReportRequest {
  orderId: string;
  /**
   * ORD-030. ⚠️ IT IS `null` TODAY, AND THAT IS HONEST RATHER THAN MISSING.
   * `diagnostic_report.performed_by_id` is a foreign key to `practitioner` —
   * OUR practitioners — and D-A-012 says the realistic case is an EXTERNAL
   * laboratory: `exam_definition.performed_externally` defaults to `true`.
   * Putting the transcriber there would claim a professional of this clinic
   * performed the analysis, which is a false attribution on a clinical
   * document. Who performed it is the laboratory, and there is no column for
   * it — noted on ORD-070.
   */
  performedById: string | null;
  conclusion?: string;
  issuedAt: Date;
  results: readonly SubmittedResult[];
}

/**
 * ORD-043. What pairing an orphan result needs to be told.
 *
 * ⚠️ NO `orderId`. The order is the one the result's own report belongs to, read
 * from the row and never taken from the request — the same rule ORD-001 applies
 * to `orderedById`. An order id in the request is a result somebody can file
 * against another person's order.
 */
export interface MatchResultRequest {
  resultId: string;
  orderItemId: string;
}

/**
 * ORD-062. What recording the notice of a critical value needs to be told.
 *
 * ⚠️ NO `notifiedById`. Who gave the notice is the session's account, read by
 * the caller and never taken from the request — the rule ORD-001 applies to
 * `orderedById`. A field there is a notice somebody can put in a colleague's
 * name.
 */
export interface RecordNoticeRequest {
  resultId: string;
  /** ORD-067. `NO_ANSWER` records the attempt and leaves the value queued. */
  outcome: CriticalNoticeOutcome;
  /** ORD-066. Required — and `true` — on a notice actually given. */
  readBack?: boolean;
  recipientKind: CriticalNoticeRecipient;
  recipientName: string;
  channel: CriticalNoticeChannel;
  /** When the call happened; the clock's «now» when absent. */
  notifiedAt?: Date;
  note?: string;
  /**
   * ORD-148, D-116 e. Who made the call, when it was not the account that
   * records it; absent when it was.
   */
  callerName?: string | null;
}

/**
 * ORD-120. Editing a notice: the whole notice as it should read, the same
 * shape as recording it. Without `notifiedAt` the call keeps its instant.
 */
export interface EditNoticeRequest extends RecordNoticeRequest {
  noticeId: string;
  /**
   * The version the edit was made over: the `editedAt` the client read, or
   * `null` if it read a notice nobody had edited. A mismatch is
   * `CRITICAL_NOTICE_EDITED_CONCURRENTLY`.
   */
  expectedEditedAt: Date | null;
}

/** ORD-120. One notice, through the result it belongs to. */
export interface NoticeRequest {
  resultId: string;
  noticeId: string;
}

/** ORD-050. A correction is a report with a report behind it. */
export interface CorrectReportRequest {
  reportId: string;
  performedById: string | null;
  conclusion?: string;
  issuedAt: Date;
  results: readonly SubmittedResult[];
}

/**
 * The result: what comes back, and the two ways it can be lost.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, AND THE REASON IS NOT THE LINE COUNT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-008 §2 splits on three limits and this crosses two. The report has a
 * lifecycle the order does not have — issued, superseded, NEVER edited — and
 * everything here is a question about ANALYTES, RANGES AND FLAGS rather than
 * about what somebody asked for. The day the catalogue of analytes is
 * republished, this file moves and `ServiceOrderService` does not.
 *
 * ⚠️ WHAT THIS SERVICE DOES NOT DO, AND EACH ABSENCE IS A REQUIREMENT:
 *
 *  - IT DOES NOT OVERWRITE A VALUE, EVER (ORD-050). There is no update path in
 *    this file, in its port or on its routes. A correction is a NEW report
 *    that supersedes the old one, and the old one stays readable saying from
 *    when it stopped being true. A value that changes in silence is a safety
 *    incident, not an edit: somebody may have changed a treatment on it.
 *  - IT DOES NOT TRUST THE LABORATORY'S FLAG (ORD-035). It refuses one that is
 *    sent and computes its own from the `CRITICAL` and `REFERENCE` rows of the
 *    catalogue. Many laboratories send only «alto/bajo» and some send nothing;
 *    the safety net of A.M. 00002393 art. 39 cannot depend on the sender.
 *  - IT DOES NOT DISCARD A RESULT NOBODY ASKED FOR (ORD-040). It stores it
 *    with no line and puts it in a worklist a person has to resolve. Guessing
 *    the match is how a stranger's result is filed in a chart — and `match`
 *    below is the person doing it by hand, never this file doing it by rule.
 *  - IT DOES NOT CREATE A PATIENT (ORD-080). Nothing here writes to `patient`,
 *    and the absence is the requirement.
 */
@Injectable()
export class DiagnosticReportService {
  constructor(
    @Inject(DIAGNOSTIC_REPORT_REPOSITORY)
    private readonly reports: DiagnosticReportRepository,
    @Inject(SERVICE_ORDER_REPOSITORY)
    private readonly orders: ServiceOrderRepository,
    @Inject(EXAM_CATALOGUE_REPOSITORY)
    private readonly exams: ExamCatalogueRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
    /** ORD-164. Where «the critical queue of this site changed» is said. */
    private readonly liveEvents: LiveEventBus,
  ) {
    this.logger.setContext(DiagnosticReportService.name);
  }

  /** ORD-030 to ORD-042. Registers what came back against an order. */
  async register(
    request: RegisterReportRequest,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DiagnosticReportView> {
    // ORD-030. The laboratory's issue date is what a critical value's
    // deadline runs from; a future one would hide it as «dentro del plazo».
    if (request.issuedAt > now) throw new ReportIssuedInFutureError();
    const prepared = await this.prepare(request.orderId, request.results, requester); // prettier-ignore

    const report = await this.reports.register(
      {
        serviceOrderId: request.orderId,
        status: prepared.status,
        performedById: request.performedById,
        conclusion: request.conclusion,
        issuedAt: request.issuedAt,
        results: prepared.results,
        sites: requester.sites,
      },
      prepared.expected,
    );

    await this.recordAndLog(report, prepared.patient.siteId, requester, 'REPORT_REGISTERED'); // prettier-ignore
    return report;
  }

  /**
   * ORD-050 to ORD-054. Corrects a report by REPLACING it, never by editing it.
   *
   * The three refusals are in the order that makes the message useful: it does
   * not exist, it already has a correction, or it is not the kind of report
   * that gets corrected.
   */
  async correct(
    request: CorrectReportRequest,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DiagnosticReportView> {
    if (request.issuedAt > now) throw new ReportIssuedInFutureError();
    const previous = await this.reports.byId({
      reportId: request.reportId,
      sites: requester.sites,
    });
    if (!previous) throw new ReportNotFoundError();
    /**
     * ORD-052. Checked here so the refusal is a sentence; the `UNIQUE` on
     * `supersedes_id` is what arbitrates two correctors who both read «libre»
     * in the same millisecond. Database as the rule, application as the
     * explanation — the same division of labour as everywhere else here.
     */
    if (previous.supersededById !== null) throw new ReportAlreadyCorrectedError(); // prettier-ignore
    if (!isCorrectable(previous.status)) {
      throw new ReportNotCorrectableError(previous.status);
    }

    // ORD-114, ORD-122, D-130.1. Each value is compared with the critical
    // bounds the corrected version applied to it, not with today's.
    const prepared = await this.prepare(previous.serviceOrderId, request.results, requester, appliedCriticalLimits(previous.results), linesOf(previous)); // prettier-ignore

    /**
     * ORD-055 (tercera revisión clínica, grave). Superseding a report retracts
     * ALL its values. A value the correction does not bring would vanish from
     * the order — a critical one from the worklist — though the laboratory
     * never retracted it. What did not change is written again, unchanged.
     */
    const brought = new Set(prepared.results.map((result) => result.analyteDisplay)); // prettier-ignore
    const missing = previous.results
      .map((result) => result.analyteDisplay)
      .filter((display) => !brought.has(display));
    if (missing.length > 0) throw new ReportCorrectionIncompleteError(missing);

    const { results } = prepared;

    const report = await this.reports.register(
      {
        serviceOrderId: previous.serviceOrderId,
        /**
         * ORD-050. `CORRECTED` AND NOT `FINAL`, even when every determination
         * is in: the status is how a screen knows to print «corregido el …»
         * beside a number somebody may already have acted on. ORD-119: a
         * PARTIAL only completed, with nothing it said changed —values,
         * units, flags as stored, conclusion—, is `FINAL`; and a version
         * still incomplete stays `PARTIAL`.
         */
        status: supersedingStatus(
          previous,
          { conclusion: request.conclusion, results },
          prepared.status,
        ),
        performedById: request.performedById,
        conclusion: request.conclusion,
        issuedAt: request.issuedAt,
        supersedesId: previous.id,
        results,
        sites: requester.sites,
      },
      prepared.expected,
    );

    await this.recordAndLog(report, prepared.patient.siteId, requester, 'REPORT_CORRECTED'); // prettier-ignore
    return report;
  }

  /**
   * ORD-149 (D-116 f). The determinations a correction of this report admits:
   * those of the live lines' exams, by their frozen code and active or not,
   * and every one the report carried, by its frozen name and active or not.
   */
  async correctionAnalytes(
    reportId: string,
    requester: Requester,
  ): Promise<CorrectionAnalyte[]> {
    const previous = await this.reports.byId({ reportId, sites: requester.sites }); // prettier-ignore
    if (!previous) throw new ReportNotFoundError();
    const order = await this.orders.byId({
      orderId: previous.serviceOrderId,
      sites: requester.sites,
    });
    if (!order) throw new OrderNotFoundError();

    const live = order.items.filter((item) => item.status !== 'CANCELLED');
    const exams = await this.exams.byCodes(live.map((item) => item.testCode));
    const examByCode = new Map(exams.map((exam) => [exam.code, exam]));
    const offered: CorrectionAnalyte[] = [];
    const named = new Set<string>();
    for (const item of live) {
      const exam = examByCode.get(item.testCode);
      for (const entry of exam?.analytes ?? []) {
        if (named.has(entry.analyte.name)) continue;
        named.add(entry.analyte.name);
        offered.push({
          analyte: entry.analyte,
          position: entry.position,
          isReflex: entry.isReflex,
          examName: exam?.name ?? item.testDisplay,
        });
      }
    }
    const missing = previous.results.filter(
      (result) => !named.has(result.analyteDisplay),
    );
    const homonyms = await this.exams.analytesByNames(
      missing.map((result) => result.analyteDisplay),
    );
    for (const result of missing) {
      if (named.has(result.analyteDisplay)) continue;
      /**
       * Of two definitions with that name, the one with the unit the value
       * was written in (revisión clínica): another unit would write the
       * corrected number —and compare it with the inherited thresholds— in a
       * unit nobody measured. Active first, then the last changed.
       */
      const analyte = homonyms.find(
        (each) =>
          each.name === result.analyteDisplay && each.unit === result.unit,
      );
      // A name no analyte carries any more cannot be written again: the
      // correction will say which one is missing (ORD-055).
      if (!analyte) continue;
      named.add(result.analyteDisplay);
      offered.push({
        analyte,
        // After the exams' own: the screen lists them in this order.
        position: offered.length + 1,
        isReflex: false,
        examName: null,
      });
    }
    return offered;
  }

  /**
   * ORD-051, ORD-091. The reports of one order, corrections included.
   *
   * AUDITED, unlike the two worklists (ORD-092), and the difference is what
   * travels: a worklist carries what was asked for, this carries what the
   * person's blood said.
   */
  async ofOrder(
    orderId: string,
    requester: Requester,
  ): Promise<DiagnosticReportView[]> {
    const reports = withCorrections(
      await this.reports.ofOrder(orderId, requester.sites),
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: REPORT_RESOURCE_TYPE,
      resourceId: orderId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return reports;
  }

  /**
   * ORD-040, ORD-041. Results that answer no ordered line.
   *
   * NOT AUDITED PER ENTRY (ORD-092), and affordable because what travels is
   * thin — no diagnosis, no reason for the visit.
   */
  async unmatched(
    requester: Requester,
    limit: number,
    now: Date,
  ): Promise<UnmatchedWorklistEntry[]> {
    const entries = await this.reports.unmatched({ sites: requester.sites, limit }); // prettier-ignore
    const policies = await this.reports.safetyPolicies(entries.map((e) => e.siteId)); // prettier-ignore

    /**
     * ORD-046, D-050 §4. Who answers for it, and by when: the site's role if
     * it names one, the practitioner who placed the order if not — «una cola
     * que es de todos no es de nadie».
     */
    return entries.map((entry) => {
      const policy = policies.get(entry.siteId) ?? DEFAULT_POLICY;
      const role = policy.unmatchedResultOwnerRole;
      return {
        ...entry,
        ...unmatchedWait(entry.observedAt, now, policy.unmatchedResultDeadlineHours), // prettier-ignore
        owner: role
          ? { kind: 'ROLE' as const, name: role.name }
          : { kind: 'ORDERING_PRACTITIONER' as const, name: entry.orderedBy.name }, // prettier-ignore
      };
    });
  }

  /**
   * ORD-041, ORD-043. Takes one result OFF the unmatched queue by pairing it
   * with a line of its own order.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A PERSON DECIDES IT. NOTHING HERE GUESSES, AND NOTHING CREATES A PATIENT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ORD-041 still holds in full: no automatic matching, and the queue shows a
   * result until somebody resolves it. What this adds is the RESOLUTION, which
   * the requirement assumed and which did not exist — «hasta que una persona
   * los resuelva» with no way for a person to resolve anything. A queue that
   * only grows stops being read, and a safety net nobody reads is a list.
   *
   * ⚠️ AND THE PAIRING IS CONFINED TO THE ORDER THE RESULT ARRIVED ON. The line
   * belongs to the report's own `service_order` or the pairing is refused: an
   * observation of order A pointing at a line of order B would close a line
   * with somebody else's blood, and nothing in the schema forbids it (⚠️
   * **Falta esquema**, ORD-043). It is refused inside the write's transaction,
   * which is where a guarantee that the database does not make has to live.
   *
   * ⚠️ WHAT THIS DOES **NOT** DO, AND THE ABSENCE IS THE REQUIREMENT:
   *
   *  - IT DOES NOT DISCARD A RESULT (⚠️ **Falta esquema**, ORD-041, ORD-043).
   *    The result that belongs to nobody's order — somebody else's report, a
   *    specimen relabelled at the laboratory — cannot be resolved at all today:
   *    `observation_result` has no column saying «una persona miró esto y no es
   *    de aquí», so the row would have to be either deleted or left on the
   *    queue for ever. Deleting is not an option in this system, and inventing
   *    a «resolved» flag with nowhere to store WHO decided and WHY would be the
   *    same defect the prescription discard exists to avoid. So it stays on the
   *    queue and the gap is written down instead of simulated.
   *  - IT DOES NOT CREATE A PATIENT (ORD-080). It never has and it must not
   *    start here: a result whose identity cannot be resolved goes to the
   *    manual queue, because creating a chart from an incoming result is the
   *    main cause of duplicate records in the systems that do it the other way
   *    round.
   *  - IT DOES NOT UNDO A PAIRING (⚠️ **Falta esquema**, ORD-043). Same reason:
   *    undoing one is an act that needs an author and a motive, and there is
   *    nowhere to keep either.
   */
  async match(
    request: MatchResultRequest,
    requester: Requester,
  ): Promise<DiagnosticReportView> {
    const result = await this.reports.resultById({
      resultId: request.resultId,
      sites: requester.sites,
    });
    if (!result) throw new ResultNotFoundError();
    // ORD-043. Refused here so the sentence is about the queue the caller is
    // working; the conditional update is what arbitrates the race.
    if (result.orderItemId !== null) throw new ResultAlreadyMatchedError();
    // A value the laboratory retracted closes no line.
    if (result.superseded) throw new ResultSupersededError();

    const order = await this.orders.byId({
      orderId: result.orderId,
      sites: requester.sites,
    });
    if (!order) throw new OrderNotFoundError();

    const line = order.items.find((item) => item.id === request.orderItemId);
    if (!line || line.status === 'CANCELLED') {
      throw new OrderItemNotMatchableError();
    }

    /**
     * ORD-039. What that line promises, resolved from the catalogue HERE and
     * never inside the adapter — the same division `register` keeps, so the
     * thresholds and the completeness rule live in one place each.
     */
    const exams = await this.exams.byCodes([line.testCode]);
    const expected: ExpectedAnalytes = {
      orderItemId: line.id,
      analytes: (exams[0]?.analytes ?? []).map((entry) => ({
        analyteDisplay: entry.analyte.name,
        isReflex: entry.isReflex,
      })),
    };

    const report = await this.reports.match(
      {
        resultId: result.resultId,
        orderId: result.orderId,
        orderItemId: line.id,
        sites: requester.sites,
      },
      expected,
    );

    /**
     * ORD-091. `UPDATE` and not `CREATE`: no report was written, a row that
     * already existed now answers a line. The resource is the REPORT, because
     * that is what a reader of the trail can open.
     */
    await this.audit.record({
      userId: requester.userId,
      resourceType: REPORT_RESOURCE_TYPE,
      resourceId: report.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // ORD-024. The site and the fact, never the analyte and never the value.
    this.logger.info(
      { site_id: order.siteId, action: 'RESULT_MATCHED' },
      'orphan result paired with an ordered line',
    );
    this.announceCriticalQueue(order.siteId);

    return report;
  }

  /**
   * ORD-060, ORD-061, ORD-065. The values that have to reach a human today,
   * with how long each has waited, whether it is late against the site's
   * mandatory deadline and whom it goes to (D-111, D-113 a).
   */
  async critical(
    requester: Requester,
    now: Date,
  ): Promise<CriticalWorklistEntry[]> {
    // ORD-060. Never cut: a value off the screen is a value nobody notifies.
    const entries = await this.reports.critical({ sites: requester.sites });
    const siteIds = entries.map((e) => e.siteId);
    const policies = await this.reports.safetyPolicies(siteIds);
    // ORD-068. One instant for the whole listing, as for the deadlines.
    const inHours = await this.reports.sitesInHours(siteIds, now);
    // ORD-065, ORD-067. The correction chain behind each value.
    const chains = await this.reports.criticalChains(entries.map((e) => e.reportId)); // prettier-ignore

    return entries.map((entry) => {
      const policy = policies.get(entry.siteId) ?? DEFAULT_POLICY;
      const chain = chains.get(chainKey(entry.reportId, entry.analyteDisplay));
      // The deadline runs from the chain's FIRST CRITICAL version after the
      // last one notified (ORD-065, ORD-145): a correction still critical of a
      // value nobody was told about is the same pending notice; of one
      // somebody was told about, a new one.
      const firstObservedAt = chain?.firstObservedAt ?? entry.observedAt;
      const wait = criticalWait(firstObservedAt, now, policy.criticalNoticeWithinMinutes); // prettier-ignore
      const role = policy.criticalEscalationRole;
      const afterHours = !inHours.has(entry.siteId);
      const due = criticalNoticeTarget({
        overdue: wait.overdue,
        afterHours,
        hasOnCallRole: role !== null,
        orderingUnanswered: (chain?.orderingUnanswered ?? 0) > 0,
        // ORD-146, D-116 a. The practitioner who asked already knows.
        dueToPatient: chain?.selfNoticed ?? false,
      });
      return {
        ...entry,
        firstObservedAt,
        noAnswerAttempts: chain?.noAnswerAttempts ?? 0,
        previouslyNotified: chain?.previouslyNotified ?? false,
        selfNoticed: chain?.selfNoticed ?? false,
        waitingMinutes: wait.waitingMinutes,
        noticeDueAt: wait.dueAt,
        overdue: wait.overdue,
        escalateTo: role ? { roleId: role.id, name: role.name } : null,
        afterHours,
        noticeTarget: due.target,
        escalationMissing: due.escalationMissing,
      };
    });
  }

  /**
   * ORD-143 (D-115). The corrections of values somebody was told about that
   * still wait for the notice of the correction, oldest first, ALL of them —
   * each with the site's critical deadline and escalation (ORD-154, D-156.2)
   * and, when the patient was told, the patient as its target (ORD-153).
   *
   * NOT AUDITED PER ENTRY (ORD-092), like the two other worklists: what
   * travels is the determination and the value, no name and no diagnosis.
   * The rule is `notifiedCorrections`, over each candidate order's reports —
   * the same function the reading of the order and the notice ask.
   */
  async corrections(
    requester: Requester,
    now: Date,
  ): Promise<CorrectionWorklistEntry[]> {
    const orders = await this.reports.notifiedCorrectionOrders(requester.sites); // prettier-ignore
    // One read for every candidate order, grouped here (revisión: no N+1).
    const all = await this.reports.ofOrders(orders.map((o) => o.orderId), requester.sites); // prettier-ignore
    // ORD-154 (D-156.2). The critical deadline and escalation of each site,
    // judged against ONE instant for the whole listing.
    const siteIds = orders.map((order) => order.siteId);
    const policies = await this.reports.safetyPolicies(siteIds);
    const inHours = await this.reports.sitesInHours(siteIds, now);
    const entries: CorrectionWorklistEntry[] = [];
    for (const order of orders) {
      const reports = all.filter((report) => report.serviceOrderId === order.orderId); // prettier-ignore
      const found = notifiedCorrections(reports);
      const policy = policies.get(order.siteId) ?? DEFAULT_POLICY;
      const role = policy.criticalEscalationRole;
      const afterHours = !inHours.has(order.siteId);
      for (const report of reports) {
        for (const result of report.results) {
          const correction = found.get(result.id);
          if (!correction?.standing || !correction.due) continue;
          // ORD-154. The calls about the corrected value nobody answered.
          const unanswered = result.notices.filter((n) => n.outcome === 'NO_ANSWER'); // prettier-ignore
          // The wait runs from the moment the correction was recorded: that
          // is when the told value stopped being true.
          const wait = criticalWait(correction.correctedAt, now, policy.criticalNoticeWithinMinutes); // prettier-ignore
          const due = criticalNoticeTarget({
            overdue: wait.overdue,
            afterHours,
            hasOnCallRole: role !== null,
            orderingUnanswered: unanswered.some((n) => n.recipientKind === 'ORDERING_PRACTITIONER'), // prettier-ignore
            // ORD-153 (D-156.1): told to the patient, it is theirs to hear;
            // ORD-146: so it is once the practitioner who asked noted the
            // correction themselves — they already know.
            dueToPatient:
              correction.patientRequired ||
              selfNoticedByOrderer(result.notices.map(asWorklistNotice), order.orderedByUserId), // prettier-ignore
          });
          entries.push({
            resultId: result.id,
            reportId: report.id,
            orderId: order.orderId,
            siteId: order.siteId,
            patientId: order.patientId,
            analyteDisplay: result.analyteDisplay,
            valueNumeric: result.valueNumeric,
            valueCode: result.valueCode,
            valueText: result.valueText,
            unit: result.unit,
            abnormalFlag: result.abnormalFlag,
            told: correction.told,
            earlierNotices: correction.earlierNotices,
            correctedAt: correction.correctedAt,
            orderedBy: order.orderedBy,
            patientRequired: correction.patientRequired,
            noAnswerAttempts: unanswered.length,
            waitingMinutes: wait.waitingMinutes,
            noticeDueAt: wait.dueAt,
            overdue: wait.overdue,
            escalateTo: role ? { roleId: role.id, name: role.name } : null,
            afterHours,
            noticeTarget: due.target,
            escalationMissing: due.escalationMissing,
          });
        }
      }
    }
    // ORD-143. What has waited longest first; never cut.
    return entries.sort(
      (a, b) =>
        a.correctedAt.getTime() - b.correctedAt.getTime() ||
        a.resultId.localeCompare(b.resultId),
    );
  }

  /**
   * ORD-062. Records that somebody was told of a critical value — which takes
   * it off the critical worklist.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * THE CALL IS A CLINICAL ACT, AND THIS IS ITS RECORD
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A.M. 00002393 art. 39 obliges telling «de manera urgente al médico
   * tratante y/o al usuario», and D-050 §2 decided the call is recorded as a
   * clinical act. Without the record nobody can show it happened, which is
   * exactly what is asked when something goes wrong. It is never deleted
   * (ORD-064); a notice written wrongly is edited in place, and the database
   * keeps the version it replaces (ORD-120, `editNotice`).
   *
   * ⚠️ THE INSTANT IS DECLARED AND BOUNDED. The 03:00 call is written down at
   * 08:00 and the record has to say 03:00; but it cannot be later than now nor
   * earlier than the result it announces.
   *
   * What the policy still leaves open — read-back, unanswered attempts — is
   * D-111, and is not invented here.
   */
  async notify(
    request: RecordNoticeRequest,
    requester: Requester,
    now: Date,
  ): Promise<CriticalNoticeView> {
    const result = await this.reports.resultById({
      resultId: request.resultId,
      sites: requester.sites,
    });
    if (!result) throw new ResultNotFoundError();
    await this.assertNotifiable(result, requester);
    // ORD-066, D-111 §4. A notice given carries the read-back; an attempt has
    // nobody who could have repeated anything.
    const given = request.outcome === 'NOTIFIED';
    if (given && request.readBack !== true) {
      throw new CriticalReadBackRequiredError();
    }

    const notifiedAt = request.notifiedAt ?? now;
    if (notifiedAt > now || notifiedAt < result.observedAt) {
      throw new CriticalNoticeTimeInvalidError();
    }
    /**
     * ORD-062. A value the laboratory retracted is not phoned in — but the
     * call made while it was still the standing value gets its record: the
     * act happened, and art. 39 asks for its proof. Judged again, under a
     * lock, where the row lands.
     */
    if (result.supersededAt && notifiedAt >= result.supersededAt) {
      throw new ResultSupersededError();
    }
    /**
     * ORD-062, ORD-147 (D-113 b, D-116 d). A notice to oneself is recorded as
     * it happened — and does not close the worklist: the patient at home
     * still knows nothing. Judged on the name of the account that records it.
     */
    const selfNotice = isSelfNotice({
      recipientKind: request.recipientKind,
      recipientName: request.recipientName,
      recorder: {
        userId: requester.userId,
        name: (await this.reports.accountName(requester.userId)) ?? '',
      },
      orderedByUserId: result.orderedByUserId,
      callerName: callerOf(request),
    });

    // ORD-068. Out of hours at the moment of the CALL, not of the typing.
    const inHours = await this.reports.sitesInHours([result.siteId], notifiedAt); // prettier-ignore

    // ORD-062, ORD-091. The trail row is written inside the same transaction.
    const notice = await this.reports.recordNotice({
      resultId: result.resultId,
      recipientKind: request.recipientKind,
      recipientName: request.recipientName,
      channel: request.channel,
      notifiedById: requester.userId,
      notifiedAt,
      note: request.note ?? null,
      outcome: request.outcome,
      readBackConfirmed: given ? true : null,
      afterHours: !inHours.has(result.siteId),
      selfNotice,
      // ORD-146. A recipient with the ordering practitioner's name.
      namesOrderingPractitioner: samePersonName(request.recipientName, result.orderedByName), // prettier-ignore
      callerName: callerOf(request),
      sites: requester.sites,
      trail: { ip: requester.ip, userAgent: requester.userAgent },
    });

    // ORD-024. The site and the fact: never the value, never who was called.
    this.logger.info(
      { action: 'CRITICAL_NOTICE_RECORDED', channel: notice.channel },
      'critical value notice recorded',
    );
    this.announceCriticalQueue(result.siteId);

    return notice;
  }

  /**
   * ORD-120. Edits the notice of a critical value IN PLACE (D-127).
   *
   * The same rules as recording it, judged on what it will say: a notice
   * given carries the read-back (ORD-066), the instant is bounded by the
   * result and the clock and may not land after a correction (ORD-062), and
   * whether it is a notice to oneself is judged on who GAVE it — the only one
   * who may edit it (D-133.1). An unanswered attempt does not become a notice
   * given by editing. Out of hours is judged again on the instant of the call.
   *
   * OPTIMISTIC: the edit names the version it was made over
   * (`expectedEditedAt`), and the adapter compares it under the row lock.
   *
   * The earlier version is kept by the database (`record_version`), with the
   * editor and the instant as its stamp; nothing here can skip it.
   */
  async editNotice(
    request: EditNoticeRequest,
    requester: Requester,
    now: Date,
  ): Promise<CriticalNoticeView> {
    const result = await this.reports.resultById({
      resultId: request.resultId,
      sites: requester.sites,
    });
    if (!result) throw new ResultNotFoundError();
    const current = await this.reports.noticeOf({
      resultId: result.resultId,
      noticeId: request.noticeId,
      sites: requester.sites,
    });
    if (!current) throw new CriticalNoticeNotFoundError();

    // D-133.1. The record says who made the call: only that person edits it.
    if (current.notifiedBy.id !== requester.userId) {
      throw new CriticalNoticeOfAnotherUserError();
    }
    // D-133.1. An unanswered attempt stays one; the answered call is a new
    // notice. The adapter judges the version under the lock, so this reading
    // cannot be stale by the time the row is written.
    const given = request.outcome === 'NOTIFIED';
    if (current.outcome === 'NO_ANSWER' && given) {
      throw new CriticalNoticeNoAnswerStaysError();
    }

    // ORD-066. Editing does not lift the read-back.
    if (given && request.readBack !== true) {
      throw new CriticalReadBackRequiredError();
    }

    const notifiedAt = request.notifiedAt ?? current.notifiedAt;
    if (notifiedAt > now || notifiedAt < result.observedAt) {
      throw new CriticalNoticeTimeInvalidError();
    }
    if (result.supersededAt && notifiedAt >= result.supersededAt) {
      throw new ResultSupersededError();
    }
    // ORD-062, ORD-147. Who gave the notice, not who edits it.
    const selfNotice = isSelfNotice({
      recipientKind: request.recipientKind,
      recipientName: request.recipientName,
      recorder: {
        userId: current.notifiedBy.id,
        name: current.notifiedBy.name,
      },
      orderedByUserId: result.orderedByUserId,
      callerName: callerOf(request),
    });
    // ORD-068. Out of hours at the moment of the CALL.
    const inHours = await this.reports.sitesInHours([result.siteId], notifiedAt); // prettier-ignore

    const notice = await this.reports.editNotice({
      resultId: result.resultId,
      noticeId: current.id,
      recipientKind: request.recipientKind,
      recipientName: request.recipientName,
      channel: request.channel,
      notifiedAt,
      note: request.note ?? null,
      outcome: request.outcome,
      readBackConfirmed: given ? true : null,
      afterHours: !inHours.has(result.siteId),
      selfNotice,
      namesOrderingPractitioner: samePersonName(request.recipientName, result.orderedByName), // prettier-ignore
      callerName: callerOf(request),
      editedById: requester.userId,
      editedAt: now,
      expectedEditedAt: request.expectedEditedAt,
      sites: requester.sites,
      trail: { ip: requester.ip, userAgent: requester.userAgent },
    });

    // ORD-024. The fact: never the value, never who was called.
    this.logger.info(
      { action: 'CRITICAL_NOTICE_EDITED', channel: notice.channel },
      'critical value notice edited',
    );
    this.announceCriticalQueue(result.siteId);

    return notice;
  }

  /**
   * ORD-120. The versions of a notice that edits replaced, newest first.
   *
   * AUDITED: an earlier version still says who was told of whose value.
   */
  async noticeVersions(
    request: NoticeRequest,
    requester: Requester,
  ): Promise<CriticalNoticeVersionView[]> {
    const query = { ...request, sites: requester.sites };
    const result = await this.reports.resultById(query);
    if (!result) throw new ResultNotFoundError();
    const current = await this.reports.noticeOf(query);
    if (!current) throw new CriticalNoticeNotFoundError();

    const versions = await this.reports.noticeVersions(query);

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'critical_result_notice',
      resourceId: current.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return versions;
  }

  /**
   * ORD-062, ORD-144. A notice is recorded of a critical value, or of the
   * value that corrects one somebody was told about (D-115). Anything else is
   * `RESULT_NOT_CRITICAL`.
   */
  private async assertNotifiable(
    result: { resultId: string; orderId: string; abnormalFlag: string | null },
    requester: Requester,
  ): Promise<void> {
    if (
      result.abnormalFlag === 'CRITICAL_LOW' ||
      result.abnormalFlag === 'CRITICAL_HIGH'
    ) {
      return;
    }
    const reports = await this.reports.ofOrder(result.orderId, requester.sites);
    if (!notifiedCorrections(reports).has(result.resultId)) {
      throw new ResultNotCriticalError();
    }
  }

  /**
   * ORD-031 to ORD-042. Everything a report needs before a row is written:
   * the patient it classifies against, the analytes it names, which line each
   * one answers, and whether the order is finished.
   *
   * ONE PLACE FOR BOTH ENTRY POINTS, because a correction that classified
   * differently from the original would be the worst possible outcome of a
   * file whose whole purpose is that a value never changes meaning quietly
   * (ORD-054).
   */
  private async prepare(
    orderId: string,
    submitted: readonly SubmittedResult[],
    requester: Requester,
    /** ORD-114, ORD-122. A correction's inherited critical bounds, by name. */
    applied?: ReadonlyMap<string, CriticalLimits>,
    /** ORD-149. A correction's lines, by name, for what the exam no longer names. */
    inheritedLines?: ReadonlyMap<string, string>,
  ): Promise<{
    status: DiagnosticReportStatus;
    results: ReportedResult[];
    expected: ExpectedAnalytes[];
    patient: OrderPatient;
  }> {
    /**
     * ORD-035. Refused BEFORE anything is read: a request that carries a flag
     * is wrong regardless of what the order says, and answering it with
     * `ORDER_NOT_FOUND` because the id happened to be stale would send the
     * caller chasing the wrong problem.
     */
    if (submitted.some((result) => result.abnormalFlag != null)) {
      throw new ResultFlagIsDerivedError();
    }

    const order = await this.orders.byId({ orderId, sites: requester.sites });
    if (!order) throw new OrderNotFoundError();

    const patient = await this.reports.patientOfOrder(orderId, requester.sites);
    if (!patient) throw new OrderNotFoundError();

    /**
     * ORD-042. Same count comparison as ORD-003, and for the same reason:
     * accepting nineteen of twenty determinations produces a report that LOOKS
     * complete and is not.
     */
    const wanted = [...new Set(submitted.map((r) => r.analyteDefinitionId))];
    const analytes = await this.exams.analytesByIds(wanted);
    if (analytes.length !== wanted.length)
      throw new ResultAnalyteUnknownError();
    const byId = new Map(analytes.map((analyte) => [analyte.id, analyte]));

    /**
     * ORD-124. A cancelled line answers nothing: no value hangs under it and
     * nothing is expected of it. The refusal of an order with no live line is
     * the repository's, under the lock that makes it true at the write.
     */
    const live = {
      ...order,
      items: order.items.filter((item) => item.status !== 'CANCELLED'),
    };
    const exams = await this.exams.byCodes(live.items.map((i) => i.testCode));
    const lineOfAnalyte = matchAnalytesToLines(live, exams);
    const liveLines = new Set(live.items.map((item) => item.id));

    const results: ReportedResult[] = submitted.map((result) => {
      const analyte = byId.get(result.analyteDefinitionId);
      // Unreachable: the count comparison above already refused the whole
      // report. Kept as a type narrowing rather than a `!`, which would hide a
      // future change to that comparison behind an assertion nobody reads.
      if (!analyte) throw new ResultAnalyteUnknownError();

      return {
        ...resolveResult(analyte, result, patient, applied?.get(analyte.name)),
        // ORD-040. `null` when the order asked for nothing that yields this
        // analyte: stored, never discarded, never matched automatically.
        // ORD-149: a corrected value the exam no longer names keeps the live
        // line its earlier version answered.
        orderItemId:
          lineOfAnalyte.get(analyte.id) ??
          liveLine(inheritedLines?.get(analyte.name), liveLines),
      };
    });

    const expected = expectedAnalytesOf(live, exams);
    return {
      status: statusOf(live, expected, results),
      results,
      expected,
      patient,
    };
  }

  /**
   * ORD-091. The accountable act, recorded with the row that EXISTS — after
   * the write, so a refused insert leaves no entry claiming somebody filed a
   * result.
   *
   * `before`/`after` deliberately absent:
   * `access_audit_payload_only_for_declared_resources` refuses a payload
   * outside `'configuration'`, and a laboratory value landing in an
   * append-only table that is never purged could not afterwards be corrected
   * or removed.
   */
  private async recordAndLog(
    report: DiagnosticReportView,
    siteId: string,
    requester: Requester,
    action: 'REPORT_REGISTERED' | 'REPORT_CORRECTED',
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: REPORT_RESOURCE_TYPE,
      resourceId: report.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    /**
     * ORD-024. THE SITE AND THE FACT, NEVER THE VALUE. A potassium in a log
     * line is a clinical fact about an identifiable person in a file nobody
     * treats as clinical — and nothing is interpolated, because the logger
     * prunes by allowlist and a template string walks past it.
     */
    this.logger.info(
      { site_id: siteId, action, result_count: report.results.length },
      'diagnostic report written',
    );
    this.announceCriticalQueue(siteId);
  }

  /**
   * ORD-164. Tells the open screens of this site that its critical queue may
   * have changed — AFTER the write committed, which is why every caller does
   * it last. It may say so when nothing critical moved; it never carries what
   * moved (AU-055), and `publish` never throws (AU-058).
   */
  private announceCriticalQueue(siteId: string): void {
    this.liveEvents.publish({ kind: 'critical-results', siteId });
  }
}

/**
 * ORD-040. Which ordered line each analyte answers.
 *
 * THE JOIN IS THROUGH THE FROZEN CODE, and it has to be: the line stores
 * `test_code` — the identity of the orderable at the moment it was asked for —
 * and that is the only link back to the definition. A line whose exam was
 * retired since still matches, which is the point of freezing it.
 *
 * FIRST MATCH WINS when two lines of one order yield the same analyte — a
 * creatinine that appears in two panels. The alternative would be storing the
 * same reading twice, and one reading is one fact.
 */
function matchAnalytesToLines(
  order: ServiceOrderView,
  exams: readonly ExamDefinitionView[],
): Map<string, string> {
  const examByCode = new Map(exams.map((exam) => [exam.code, exam]));
  const lineOfAnalyte = new Map<string, string>();

  for (const item of order.items) {
    for (const entry of examByCode.get(item.testCode)?.analytes ?? []) {
      if (!lineOfAnalyte.has(entry.analyte.id)) {
        lineOfAnalyte.set(entry.analyte.id, item.id);
      }
    }
  }
  return lineOfAnalyte;
}

/** ORD-039. What each line of the order still promises. */
function expectedAnalytesOf(
  order: ServiceOrderView,
  exams: readonly ExamDefinitionView[],
): ExpectedAnalytes[] {
  const examByCode = new Map(exams.map((exam) => [exam.code, exam]));

  return order.items.map((item) => ({
    orderItemId: item.id,
    analytes: (examByCode.get(item.testCode)?.analytes ?? []).map((entry) => ({
      analyteDisplay: entry.analyte.name,
      isReflex: entry.isReflex,
    })),
  }));
}

/**
 * ORD-030, ORD-039. `FINAL` when nothing the order asked for is still missing,
 * `PARTIAL` otherwise.
 *
 * ⚠️ DERIVED AND NOT TYPED. A status somebody selects is a status that can
 * contradict the rows sitting next to it — and «FINAL» on a report missing
 * three determinations is exactly how a line leaves the worklist without
 * anybody having seen a value. Same argument as `careModality` in `encounter`.
 */
function statusOf(
  order: ServiceOrderView,
  expected: readonly ExpectedAnalytes[],
  results: readonly ReportedResult[],
): DiagnosticReportStatus {
  const reported = new Set(results.map((result) => result.analyteDisplay));
  const stillOpen = order.items.filter((item) => item.completedAt === null);

  const everyLineIn = stillOpen.every((item) => {
    const promise = expected.find((e) => e.orderItemId === item.id);
    return promise ? isLineComplete(promise.analytes, reported) : false;
  });

  // An order with nothing pending left is already answered; a further report
  // on it is an addition, and calling it PARTIAL would put a finished order
  // back on a list nobody needs to work.
  return stillOpen.length === 0 || everyLineIn ? 'FINAL' : 'PARTIAL';
}

/** ORD-149. One determination a correction admits, with the exam it is of. */
export interface CorrectionAnalyte {
  analyte: AnalyteDefinition;
  position: number;
  isReflex: boolean;
  /** `null` for one the order's exams no longer name. */
  examName: string | null;
}

/** ORD-149. The line each determination of a report answered, by name. */
function linesOf(report: DiagnosticReportView): Map<string, string> {
  const lines = new Map<string, string>();
  for (const result of report.results) {
    if (result.orderItemId !== null) lines.set(result.analyteDisplay, result.orderItemId); // prettier-ignore
  }
  return lines;
}

/** ORD-124, ORD-149. An inherited line, only while it is still live. */
function liveLine(
  line: string | undefined,
  live: ReadonlySet<string>,
): string | null {
  return line !== undefined && live.has(line) ? line : null;
}

/** ORD-146. A recorded notice as the worklist rule reads it. */
function asWorklistNotice(notice: CriticalNoticeView): WorklistNotice {
  return {
    outcome: notice.outcome,
    selfNotice: notice.selfNotice,
    recipientKind: notice.recipientKind,
    namesOrderingPractitioner: notice.namesOrderingPractitioner,
    notifiedById: notice.notifiedBy.id,
    notifiedAt: notice.notifiedAt,
  };
}

/** ORD-148. The caller's name, or `null` when it was who records it. */
function callerOf(request: { callerName?: string | null }): string | null {
  return request.callerName?.trim() || null;
}

/**
 * ORD-143. The reports of one order, each standing value marked with the
 * correction of a notified value it is, if any.
 */
function withCorrections(
  reports: DiagnosticReportView[],
): DiagnosticReportView[] {
  const found = notifiedCorrections(reports);
  if (found.size === 0) return reports;
  return reports.map((report) => ({
    ...report,
    results: report.results.map((result) => {
      const correction = found.get(result.id);
      return correction?.standing ? { ...result, correction } : result;
    }),
  }));
}
