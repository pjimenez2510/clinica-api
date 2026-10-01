import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  DIAGNOSTIC_REPORT_REPOSITORY,
  type CriticalNoticeChannel,
  type CriticalNoticeRecipient,
  type CriticalNoticeView,
  type DiagnosticReportRepository,
  type DiagnosticReportView,
  type ExpectedAnalytes,
  type FlaggedResultEntry,
  type OrderPatient,
  type ReportedResult,
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
  CriticalNoticeTimeInvalidError,
  OrderItemNotMatchableError,
  OrderNotFoundError,
  ReportAlreadyCorrectedError,
  ReportNotCorrectableError,
  ReportNotFoundError,
  ResultAlreadyMatchedError,
  ResultAnalyteUnknownError,
  ResultFlagIsDerivedError,
  ResultNotCriticalError,
  ResultNotFoundError,
} from '../domain/orders.errors';
import { isCorrectable, isLineComplete } from '../domain/service-order';
import { resolveResult } from '../domain/result-value';
import type { DiagnosticReportStatus } from '../domain/service-order';
import type { Requester } from './service-order.service';

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
  recipientKind: CriticalNoticeRecipient;
  recipientName: string;
  channel: CriticalNoticeChannel;
  /** When the call happened; the clock's «now» when absent. */
  notifiedAt?: Date;
  note?: string;
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
  ) {
    this.logger.setContext(DiagnosticReportService.name);
  }

  /** ORD-030 to ORD-042. Registers what came back against an order. */
  async register(
    request: RegisterReportRequest,
    requester: Requester,
  ): Promise<DiagnosticReportView> {
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
  ): Promise<DiagnosticReportView> {
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

    const prepared = await this.prepare(previous.serviceOrderId, request.results, requester); // prettier-ignore

    const report = await this.reports.register(
      {
        serviceOrderId: previous.serviceOrderId,
        /**
         * ORD-050. `CORRECTED` AND NOT `FINAL`, even when every determination
         * is in: the status is how a screen knows to print «corregido el …»
         * beside a number somebody may already have acted on.
         */
        status: 'CORRECTED',
        performedById: request.performedById,
        conclusion: request.conclusion,
        issuedAt: request.issuedAt,
        supersedesId: previous.id,
        results: prepared.results,
        sites: requester.sites,
      },
      prepared.expected,
    );

    await this.recordAndLog(report, prepared.patient.siteId, requester, 'REPORT_CORRECTED'); // prettier-ignore
    return report;
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
    const reports = await this.reports.ofOrder(orderId, requester.sites);

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
  unmatched(
    requester: Requester,
    limit: number,
  ): Promise<FlaggedResultEntry[]> {
    return this.reports.unmatched({ sites: requester.sites, limit });
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

    return report;
  }

  /** ORD-060, ORD-061. The values that have to reach a human today. */
  critical(requester: Requester, limit: number): Promise<FlaggedResultEntry[]> {
    return this.reports.critical({ sites: requester.sites, limit });
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
   * exactly what is asked when something goes wrong. It is never rewritten
   * (ORD-064): a notice written wrongly is answered by writing another.
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
    if (
      result.abnormalFlag !== 'CRITICAL_LOW' &&
      result.abnormalFlag !== 'CRITICAL_HIGH'
    ) {
      throw new ResultNotCriticalError();
    }

    const notifiedAt = request.notifiedAt ?? now;
    if (notifiedAt > now || notifiedAt < result.observedAt) {
      throw new CriticalNoticeTimeInvalidError();
    }

    const notice = await this.reports.recordNotice({
      resultId: result.resultId,
      recipientKind: request.recipientKind,
      recipientName: request.recipientName,
      channel: request.channel,
      notifiedById: requester.userId,
      notifiedAt,
      note: request.note ?? null,
      sites: requester.sites,
    });

    // ORD-062, ORD-091. After the write, so a refused insert leaves no entry
    // claiming somebody was told.
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'critical_result_notice',
      resourceId: notice.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // ORD-024. The site and the fact: never the value, never who was called.
    this.logger.info(
      { action: 'CRITICAL_NOTICE_RECORDED', channel: notice.channel },
      'critical value notice recorded',
    );

    return notice;
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

    const exams = await this.exams.byCodes(order.items.map((i) => i.testCode));
    const lineOfAnalyte = matchAnalytesToLines(order, exams);

    const results: ReportedResult[] = submitted.map((result) => {
      const analyte = byId.get(result.analyteDefinitionId);
      // Unreachable: the count comparison above already refused the whole
      // report. Kept as a type narrowing rather than a `!`, which would hide a
      // future change to that comparison behind an assertion nobody reads.
      if (!analyte) throw new ResultAnalyteUnknownError();

      return {
        ...resolveResult(analyte, result, patient),
        // ORD-040. `null` when the order asked for nothing that yields this
        // analyte: stored, never discarded, never matched automatically.
        orderItemId: lineOfAnalyte.get(analyte.id) ?? null,
      };
    });

    const expected = expectedAnalytesOf(order, exams);
    return {
      status: statusOf(order, expected, results),
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
