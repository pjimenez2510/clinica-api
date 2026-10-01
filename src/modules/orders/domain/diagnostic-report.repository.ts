import type { AbnormalFlag, PatientProfile } from './analyte';
import type { DiagnosticReportStatus } from './service-order';
import type { ResolvedResult } from './result-value';
import type {
  CriticalNoticeTarget,
  CriticalWait,
  UnmatchedWait,
} from './safety-deadline';
import type { SiteScopeFilter } from './service-order.repository';

/**
 * What the RESULT needs from storage.
 *
 * A SECOND PORT, and the reason is not the line count. ADR-008 §2 splits on
 * three limits and this crosses two of them: the report has a lifecycle the
 * order does not have — it is issued, it is superseded, it is never edited —
 * and it answers a different KIND of question altogether, one about analytes,
 * ranges and flags rather than about what somebody asked for. The day the
 * catalogue of analytes is republished, this file moves and the order's port
 * does not.
 */

/** ORD-030, ORD-051. One report as this module serves it. */
export interface DiagnosticReportView {
  id: string;
  serviceOrderId: string;
  status: DiagnosticReportStatus;
  performedById: string | null;
  conclusion: string | null;
  issuedAt: Date | null;
  /** ORD-050. The report this one corrects, or `null`. */
  supersedesId: string | null;
  /**
   * ORD-051. The correction that replaced THIS one, and when it landed.
   *
   * ⚠️ THE SUPERSEDED REPORT STAYS READABLE AND SAYS SO. A value that changes
   * in silence is a safety incident, not an edit: the clinician who acted on
   * the old number has to be able to see the old number, and the record has to
   * be able to say from when it stopped being true.
   */
  supersededById: string | null;
  supersededAt: Date | null;
  results: readonly ObservationView[];
}

/** ORD-031 to ORD-038. One determination, in the four columns of form 010B. */
export interface ObservationView {
  id: string;
  /** `null` for a value nobody asked for (ORD-040). */
  orderItemId: string | null;
  analyteConceptId: string | null;
  /** `DETERMINACIÓN`. */
  analyteDisplay: string;
  /** `RESULTADO`, in whichever of the three columns the analyte declares. */
  valueNumeric: number | null;
  valueText: string | null;
  valueCode: string | null;
  /** `UNIDAD DE MEDIDA`. */
  unit: string | null;
  /** `VALOR DE REFERENCIA`. */
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  /** ORD-038. `null` means «nothing to compare against», never «normal». */
  abnormalFlag: AbnormalFlag | null;
  observedAt: Date;
  /** ORD-062. The notices given of this value, oldest first. */
  notices: readonly CriticalNoticeView[];
}

/** ORD-062. Who received the notice of a critical value. */
export const CRITICAL_NOTICE_RECIPIENTS = [
  'ORDERING_PRACTITIONER',
  'OTHER_PRACTITIONER',
  'PATIENT',
  'REPRESENTATIVE',
] as const;
export type CriticalNoticeRecipient =
  (typeof CRITICAL_NOTICE_RECIPIENTS)[number];

/** ORD-062. By what means it was given. */
export const CRITICAL_NOTICE_CHANNELS = [
  'PHONE',
  'IN_PERSON',
  'VIDEO_CALL',
] as const;
export type CriticalNoticeChannel = (typeof CRITICAL_NOTICE_CHANNELS)[number];

/**
 * ORD-067, D-111 §5. Whether somebody was actually told. An unanswered call is
 * recorded too — and does not take the value off the worklist.
 */
export const CRITICAL_NOTICE_OUTCOMES = ['NOTIFIED', 'NO_ANSWER'] as const;
export type CriticalNoticeOutcome = (typeof CRITICAL_NOTICE_OUTCOMES)[number];

/**
 * ORD-062, ORD-064. The notice of a critical value, as it was written — and it
 * is never written again: `critical_result_notice` is append-only.
 */
export interface CriticalNoticeView {
  id: string;
  resultId: string;
  recipientKind: CriticalNoticeRecipient;
  recipientName: string;
  channel: CriticalNoticeChannel;
  /** When the call happened, which may precede when it was written down. */
  notifiedAt: Date;
  /** The account that gave it, with the name a reader recognises. */
  notifiedBy: { id: string; name: string };
  note: string | null;
  /** ORD-067. `NO_ANSWER` is an attempt, not a notice. */
  outcome: CriticalNoticeOutcome;
  /** ORD-066. `true` on a notice, `null` on an attempt. */
  readBackConfirmed: boolean | null;
  /** ORD-068. Given outside the site's hours. */
  afterHours: boolean;
}

/** ORD-062. What recording a notice writes. */
export interface NewCriticalNotice {
  resultId: string;
  recipientKind: CriticalNoticeRecipient;
  recipientName: string;
  channel: CriticalNoticeChannel;
  notifiedById: string;
  notifiedAt: Date;
  note: string | null;
  outcome: CriticalNoticeOutcome;
  readBackConfirmed: boolean | null;
  afterHours: boolean;
  sites: SiteScopeFilter;
  /**
   * ORD-062, ORD-091. The trail row is written IN THE SAME TRANSACTION as the
   * notice: a notice that landed without its row — or a retry after a failed
   * row — would be a second, indelible notice.
   */
  trail: { ip?: string; userAgent?: string };
}

/**
 * ORD-030 to ORD-042. What registering a report needs to be told.
 *
 * ⚠️ `results` ARE ALREADY RESOLVED. The unit, the reference range and the flag
 * were computed by the domain from the catalogue and the patient's frozen
 * profile before this port was reached, so the adapter WRITES them and never
 * DECIDES them. That is what keeps the safety net of A.M. 00002393 art. 39 in
 * one place: an adapter that could compute a flag is a second place where the
 * thresholds live.
 */
export interface NewReport {
  serviceOrderId: string;
  status: DiagnosticReportStatus;
  performedById: string | null;
  conclusion?: string;
  issuedAt: Date;
  /** ORD-050. Present only on a correction. */
  supersedesId?: string;
  results: readonly ReportedResult[];
  sites: SiteScopeFilter;
}

/**
 * ORD-040. One resolved reading, plus which ordered line it answers.
 *
 * `orderItemId` is `null` when nothing on the order matches — a panel the
 * laboratory widened, or somebody else's report. It is STORED that way and
 * shown in the unmatched worklist; it is never discarded, and it is never
 * matched automatically.
 */
export interface ReportedResult extends ResolvedResult {
  orderItemId: string | null;
}

/** ORD-051. One report, by id, within the caller's scope. */
export interface ReportQuery {
  reportId: string;
  sites: SiteScopeFilter;
}

/**
 * ORD-039. What the adapter needs to decide whether a line is finished: the
 * analytes the exam promises, keyed by the line that asked for it.
 */
export interface ExpectedAnalytes {
  orderItemId: string;
  /** Keyed by the frozen display — see the schema gap on `isLineComplete`. */
  analytes: readonly { analyteDisplay: string; isReflex: boolean }[];
}

/** ORD-040, ORD-060. One entry of a safety worklist. */
export interface FlaggedResultEntry {
  resultId: string;
  reportId: string;
  orderId: string;
  siteId: string;
  patientId: string;
  analyteDisplay: string;
  valueNumeric: number | null;
  valueCode: string | null;
  unit: string | null;
  abnormalFlag: AbnormalFlag | null;
  observedAt: Date;
  /**
   * ORD-046. The practitioner who placed the order: by default, the owner of
   * an unmatched result (D-050 §4).
   */
  orderedBy: { id: string; name: string };
}

/**
 * ORD-046, ORD-063, ORD-065. A site's policy for the two safety worklists, as
 * `site_parameter` holds it, with the role names a reader recognises.
 */
export interface SafetyPolicy {
  /** `null`: the clinic has set no deadline (D-111). */
  criticalNoticeWithinMinutes: number | null;
  criticalEscalationRole: { id: string; name: string } | null;
  /** `null`: the practitioner who placed the order (D-050 §4). */
  unmatchedResultOwnerRole: { id: string; name: string } | null;
  unmatchedResultDeadlineHours: number;
}

/** ORD-060, ORD-065. A critical value with how long it has waited. */
/** ORD-067. A critical row as the adapter reads it: with its unanswered calls. */
export interface CriticalQueueRow extends FlaggedResultEntry {
  noAnswerAttempts: number;
}

export interface CriticalWorklistEntry extends CriticalQueueRow {
  waitingMinutes: CriticalWait['waitingMinutes'];
  noticeDueAt: CriticalWait['dueAt'];
  overdue: CriticalWait['overdue'];
  /** The site's on-call role, when it names one. */
  escalateTo: { roleId: string; name: string } | null;
  /** ORD-068. The site is out of hours now. */
  afterHours: boolean;
  /** ORD-065, ORD-068. Whom the notice is due to now. */
  noticeTarget: CriticalNoticeTarget;
  /** ORD-065. The escalation is due and the site named nobody. */
  escalationMissing: boolean;
}

/** ORD-040, ORD-046. An unmatched result with who answers for it, and by when. */
export interface UnmatchedWorklistEntry
  extends FlaggedResultEntry, UnmatchedWait {
  owner: { kind: 'ORDERING_PRACTITIONER' | 'ROLE'; name: string };
}

/** ORD-040, ORD-060. What a safety worklist is asked for. */
export interface SafetyWorklistQuery {
  sites: SiteScopeFilter;
  limit: number;
}

/** ORD-043. One result of the unmatched queue, by id, within the scope. */
export interface ResultQuery {
  /**
   * `observation_result.id` as a STRING. The column is a `bigint` — the one
   * clinical table with genuinely high row counts — and it travels as a string
   * for the same reason `ObservationView.id` does: so no client has to guess
   * whether its JSON parser kept every digit.
   */
  resultId: string;
  sites: SiteScopeFilter;
}

/**
 * ORD-043. What the pairing needs to know about the result before it writes.
 *
 * ⚠️ NO VALUE AND NO PATIENT. Deciding whether a line may be paired needs the
 * order it arrived on and whether it is still orphaned, and nothing else — the
 * potassium reading itself would only be a clinical datum travelling through a
 * code path that has no reason to carry it.
 */
export interface MatchableResult {
  resultId: string;
  reportId: string;
  /** The order the REPORT belongs to, which is the only order it may answer. */
  orderId: string;
  /** ORD-040. `null` is exactly what puts it on the unmatched queue. */
  orderItemId: string | null;
  /** ORD-062. Only a critical value takes a notice. */
  abnormalFlag: AbnormalFlag | null;
  /** ORD-062. A notice cannot precede the result it announces. */
  observedAt: Date;
  /** ORD-068. Whose hours decide whether a notice is after hours. */
  siteId: string;
  /** ORD-043, ORD-062. A retracted value is neither paired nor notified. */
  superseded: boolean;
}

/**
 * ORD-043. Pairing one orphan result with a line OF ITS OWN ORDER.
 *
 * ⚠️ `orderId` TRAVELS EVEN THOUGH THE RESULT ALREADY KNOWS IT, and it is not
 * redundancy: it is what lets the adapter make the write itself conditional on
 * the report still belonging to that order, inside the transaction. Without it
 * the same statement would trust a read taken a moment earlier — the shape this
 * module refuses everywhere else.
 */
export interface MatchResultCommand {
  resultId: string;
  orderId: string;
  orderItemId: string;
  sites: SiteScopeFilter;
}

/**
 * ORD-036. The patient of an order, as the ranges need them.
 *
 * TWO FACTS AND NO MORE: no name, no document, no birth date. The age is the
 * one `trg_encounter_freeze_age` wrote on the attention and never recomputed,
 * so a report read in two years is still classified with the age the patient
 * HAD.
 */
export interface OrderPatient extends PatientProfile {
  patientId: string;
  siteId: string;
}

/**
 * The port for reports, their results and the two safety worklists. There is no
 * method that updates a stored value: a correction is a new report (ORD-050).
 */
export interface DiagnosticReportRepository {
  /**
   * ORD-030 to ORD-042. Writes one report, its observations, and closes the
   * lines whose determinations are now all in.
   *
   * ONE TRANSACTION, and it has to be: the report, its rows and the
   * `completed_at` that takes a line out of the worklist are one fact. A
   * report that landed while its line stayed pending is a chase-up call to a
   * laboratory that already answered.
   */
  register(
    report: NewReport,
    expected: readonly ExpectedAnalytes[],
  ): Promise<DiagnosticReportView>;

  /** ORD-051. One report with its determinations, within the caller's scope. */
  byId(query: ReportQuery): Promise<DiagnosticReportView | undefined>;

  /** ORD-051. The reports of one order, newest first, corrections included. */
  ofOrder(
    orderId: string,
    sites: SiteScopeFilter,
  ): Promise<DiagnosticReportView[]>;

  /**
   * ORD-036. Who the order is for, and how old they were that day.
   *
   * ⚠️ READ FROM THE ATTENTION AND NOT FROM THE CHART. `encounter.age_days` is
   * frozen; `patient.birth_date` is not, and deriving the age at transcription
   * time would classify a two-year-old result against today's ranges.
   */
  patientOfOrder(
    orderId: string,
    sites: SiteScopeFilter,
  ): Promise<OrderPatient | undefined>;

  /**
   * ORD-040, ORD-041. Results that answer no ordered line.
   *
   * ⚠️ THEY ARE NEVER MATCHED AUTOMATICALLY AND NEVER DISCARDED. A value that
   * arrived unasked is usually a panel the laboratory widened and sometimes
   * somebody else's report, and a system that guesses between those two is a
   * system that files a stranger's result in a chart.
   */
  unmatched(query: SafetyWorklistQuery): Promise<FlaggedResultEntry[]>;

  /** ORD-043. One result of that queue, within the caller's scope. */
  resultById(query: ResultQuery): Promise<MatchableResult | undefined>;

  /**
   * ORD-043. Points an orphan result at a line of its own order, and closes
   * the line if that completes it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A PERSON DECIDES IT, AND THIS IS WHERE THE DECISION LANDS
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ORD-041 forbids matching automatically and it still does: nothing guesses
   * here. What this adds is the way OUT of the queue, which ORD-041 assumed —
   * «hasta que una persona los resuelva» — and which did not exist. A queue
   * that only grows stops being read, and a safety net nobody reads is a list.
   *
   * ONE TRANSACTION, and it has to be: the pointer and the `completed_at` that
   * takes the line out of the pending worklist are one fact. `expected` is what
   * the line's exam promises, resolved from the catalogue by the caller, so
   * this adapter never decides completeness — the same division `register`
   * keeps.
   *
   * ⚠️ THE UPDATE IS CONDITIONAL ON THE RESULT STILL BEING UNMATCHED. Two
   * people working the queue is the ordinary case, and the loser has to be
   * refused rather than allowed to re-point a row somebody already resolved.
   */
  match(
    command: MatchResultCommand,
    expected: ExpectedAnalytes,
  ): Promise<DiagnosticReportView>;

  /**
   * ORD-060, ORD-061. Results whose computed flag is one of the two critical
   * ones, newest first.
   *
   * ⚠️ BUILT ON OUR OWN THRESHOLDS AND NOT ON WHAT THE LABORATORY SENT. Many
   * send only «alto/bajo», some send nothing, and the ones that phone do it to
   * whoever answers. The `CRITICAL` rows of `analyte_reference_range` are the
   * net.
   */
  critical(query: SafetyWorklistQuery): Promise<CriticalQueueRow[]>;

  /**
   * ORD-062. Writes the notice of a critical value.
   *
   * The scope is judged again where the row lands, as `match` does: between
   * the service's read and this write a grant can be revoked. Whether the
   * value is critical and the instant plausible is the service's judgement;
   * this adapter only refuses what is out of scope.
   */
  recordNotice(notice: NewCriticalNotice): Promise<CriticalNoticeView>;

  /**
   * ORD-046, ORD-063, ORD-065. The worklist policy of each site named. A site
   * without a row — which `trg_site_parameter_defaults` makes impossible —
   * is simply absent, and the caller applies the decided defaults.
   */
  safetyPolicies(
    siteIds: readonly string[],
  ): Promise<ReadonlyMap<string, SafetyPolicy>>;

  /**
   * ORD-068. Which of these sites are IN HOURS at that instant: some active
   * schedule rule of the site, valid that day, covers that weekday and time in
   * `America/Guayaquil`, and the day is not a holiday the site keeps.
   */
  sitesInHours(
    siteIds: readonly string[],
    at: Date,
  ): Promise<ReadonlySet<string>>;
}

/** Injection token. The application never names the adapter. */
export const DIAGNOSTIC_REPORT_REPOSITORY = Symbol(
  'DiagnosticReportRepository',
);
