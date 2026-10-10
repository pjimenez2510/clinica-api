import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { RecordReadScope } from '../../../shared/domain/clinical-record-key';

import type { DataRequestParty } from './data-request-party';
import type { DataSubjectRight } from './legal-due-date';

/** Who acts, so the trail can say so. */
export interface Requester {
  userId: string;
  /**
   * D-203 §1. The caller's `record:read` scope: the key to answer a copy of
   * the clinical record. Absent is none.
   */
  recordScope?: RecordReadScope;
  ip?: string;
  userAgent?: string;
}

/** Somebody on the staff, as a screen names them. Never their cedula. */
export interface StaffName {
  id: string;
  fullName: string;
}

export const CONSENT_MEDIA = ['SIGNED_PAPER', 'ON_SCREEN'] as const;
export type ConsentMedium = (typeof CONSENT_MEDIA)[number];

/** PD-010. Who grants a consent. Who presents a request is wider (PD-052). */
export const DATA_SUBJECT_PARTIES = ['HOLDER', 'REPRESENTATIVE'] as const;
export type DataSubjectParty = (typeof DATA_SUBJECT_PARTIES)[number];

export const DATA_REQUEST_OUTCOMES = [
  'GRANTED',
  'PARTIALLY_GRANTED',
  'DENIED',
] as const;
export type DataRequestOutcome = (typeof DATA_REQUEST_OUTCOMES)[number];

/**
 * What a chart id resolves to before anything is written about it (PD-015).
 * A merged chart names its survivor so the screen can open the right one.
 */
export type ChartLookup =
  /** PD-052. `deceased`: the chart records the patient's death. */
  | { status: 'active'; deceased: boolean }
  | { status: 'missing' }
  | { status: 'merged'; survivingMrn: string };

// --- D1, D2 ------------------------------------------------------------------

export interface ConsentTextView {
  id: string;
  version: number;
  body: string;
  publishedAt: Date;
  publishedBy: StaffName;
}

export interface PatientConsentView {
  id: string;
  /** The chart the row was written against: an absorbed one after a merge. */
  patientId: string;
  textVersion: ConsentTextView;
  medium: ConsentMedium;
  grantedBy: DataSubjectParty;
  recordedAt: Date;
  recordedBy: StaffName;
  /** PD-044. The consent this one corrects, if it is a correction. */
  supersedesId: string | null;
  /** PD-044. Another consent corrects this one: it no longer stands. */
  isSuperseded: boolean;
  /**
   * PD-044. Who TOOK the consent from the person and when: on an original,
   * its own `recordedAt`/`recordedBy`; on a correction, the FIRST consent of
   * the chain's. A correction fixes how it was written down, not who was at
   * the desk that day.
   */
  takenAt: Date;
  takenBy: StaffName;
}

export interface NewConsent {
  patientId: string;
  textVersionId: string;
  medium: ConsentMedium;
  grantedBy: DataSubjectParty;
}

/**
 * The result of recording a consent. `outdated` is PD-012: the version sent is
 * not the current one, checked inside the same transaction as the INSERT.
 */
export type RecordConsentResult =
  | { status: 'recorded'; consent: PatientConsentView }
  | { status: 'outdated'; currentVersion: number }
  | { status: 'unknown-version' };

/**
 * PD-044. A consent recorded with the wrong medium or grantor, corrected: the
 * chart in the URL (its scope reaches the absorbed charts, PA-055) and what
 * the correction says. The text and the patient are the original's.
 */
export interface ConsentCorrection {
  patientId: string;
  consentId: string;
  medium: ConsentMedium;
  grantedBy: DataSubjectParty;
}

export type CorrectConsentResult =
  | { status: 'corrected'; consent: PatientConsentView }
  | { status: 'missing' }
  | { status: 'already-corrected' };

export interface ConsentRepository {
  chartOf(patientId: string): Promise<ChartLookup>;
  currentText(): Promise<ConsentTextView | null>;
  texts(): Promise<ConsentTextView[]>;
  /**
   * PD-045. How many charts have a standing consent (not superseded) on the
   * current version: the ones a new publication leaves on an older text.
   */
  currentVersionConsents(): Promise<number>;
  /**
   * PD-044, PD-017. The correction and its trail row in one transaction,
   * under the original's row lock: of two corrections, the second finds it
   * already corrected.
   */
  correct(
    correction: ConsentCorrection,
    requester: Requester,
  ): Promise<CorrectConsentResult>;
  /**
   * PD-002, PD-005, PD-006. The next version and its trail row, in one
   * transaction. Throws `ConsentTextVersionConflictError` on the race.
   */
  publish(body: string, requester: Requester): Promise<ConsentTextView>;
  /** PD-010..PD-014, PD-017. Consent and trail row in one transaction. */
  record(
    consent: NewConsent,
    requester: Requester,
  ): Promise<RecordConsentResult>;
  /** PD-016. The chart and the charts merged into it, newest first. */
  consentsOf(patientId: string): Promise<PatientConsentView[]>;
}

export const CONSENT_REPOSITORY = Symbol('ConsentRepository');

// --- D3, D4 ------------------------------------------------------------------

export interface DataRequestAnswer {
  outcome: DataRequestOutcome;
  response: string;
  answeredAt: Date;
  answeredBy: StaffName;
  /** PD-047. Whether this answer rectifies an earlier one. */
  isCorrection: boolean;
}

export interface DataRequestView {
  id: string;
  patientId: string;
  patient: { mrn: string; fullName: string };
  right: DataSubjectRight;
  requestedBy: DataRequestParty;
  /** PD-052. Who presents it, when it is not the holder. */
  requesterName: string | null;
  requesterDocument: string | null;
  /** PD-053. It asks for the copy of the clinical record. */
  clinicalRecordCopy: boolean;
  documentsChecked: boolean;
  description: string;
  receivedAt: Date;
  /** PD-054. The instant it is due. */
  dueAt: Date;
  /** PD-054. The clinical date of the last day on time. */
  dueOn: ClinicalDate;
  registeredAt: Date;
  registeredBy: StaffName;
  /** PD-047. The answer that stands: the last rectification, or the original. */
  answer: DataRequestAnswer | null;
  /** PD-047. The answers a rectification replaced, newest first. */
  previousAnswers: DataRequestAnswer[];
  /** PD-046. Who last edited or answered it, and when. */
  changedBy: StaffName | null;
  changedAt: Date | null;
}

export interface NewDataRequest {
  patientId: string;
  right: DataSubjectRight;
  requestedBy: DataRequestParty;
  requesterName: string | null;
  requesterDocument: string | null;
  clinicalRecordCopy: boolean;
  documentsChecked: boolean;
  description: string;
  /**
   * When it arrived and when it was registered, both on the APPLICATION's
   * clock: the 48 hours of a copy run from `receivedAt`, and a `now()` of the
   * base would put the receipt a moment after the deadline was computed.
   */
  receivedAt: Date;
  registeredAt: Date;
  /** PD-054. */
  dueAt: Date;
}

export type AnswerResult =
  | { status: 'answered'; request: DataRequestView }
  | { status: 'missing' }
  | { status: 'already-answered' };

/** PD-046. What an edit changes; absent is «lo que ya había». */
export interface DataRequestChanges {
  right?: DataSubjectRight;
  description?: string;
  receivedAt?: Date;
}

export type EditRequestResult =
  | { status: 'edited'; request: DataRequestView }
  | { status: 'missing' }
  | { status: 'already-answered' };

export type CorrectAnswerResult =
  | { status: 'corrected'; request: DataRequestView }
  | { status: 'missing' }
  | { status: 'not-answered' };

/**
 * PD-048. One saved version of a row of the data subject's, as the export
 * hands it over: which table, which row, which version, the row as it was,
 * and who replaced it and when.
 */
export interface ExportedVersion {
  table: string;
  resourceId: string;
  version: number;
  changedAt: string;
  changedBy: StaffName;
  data: unknown;
}

/**
 * PD-040. The document handed to the data subject. Its shape is a published
 * format (`format`), so a field added later is a new version of it, not a
 * silent change.
 */
export interface DataExportDocument {
  format: 'clinica.privacy.export';
  formatVersion: 1;
  generatedAt: string;
  patient: Readonly<Record<string, unknown>>;
  identifiers: readonly Readonly<Record<string, unknown>>[];
  consents: readonly Readonly<Record<string, unknown>>[];
  requests: readonly Readonly<Record<string, unknown>>[];
  /** PD-048 (D-131.1). The saved versions of the subject's rows. */
  versions: readonly ExportedVersion[];
  omitted: readonly ExportOmission[];
}

export interface ExportOmission {
  section: string;
  reason: string;
}

/** PD-049, PD-056. What the proposed answer is written from. */
export interface ProposalFacts {
  right: DataSubjectRight;
  requestedBy: DataRequestParty;
  requesterName: string | null;
  clinicalRecordCopy: boolean;
}

export interface DataSubjectRequestRepository {
  chartOf(patientId: string): Promise<ChartLookup>;
  /** Holidays of the WHOLE clinic in the range, as `YYYY-MM-DD`. */
  clinicWideHolidays(
    from: ClinicalDate,
    to: ClinicalDate,
  ): Promise<Set<string>>;
  /** PD-030..PD-032, PD-037. Request and trail row in one transaction. */
  register(
    request: NewDataRequest,
    requester: Requester,
  ): Promise<DataRequestView>;
  /** PD-033, PD-037, PD-038. Answer, stamp and trail row in one transaction. */
  answer(
    requestId: string,
    answer: { outcome: DataRequestOutcome; response: string },
    requester: Requester,
    now: Date,
  ): Promise<AnswerResult>;
  /**
   * PD-046. The edit, under the row's lock and with a new stamp, so the row it
   * replaces goes to `record_version`; and its trail row. An answered request
   * is not edited. When the right or the receipt moves, the due date is
   * recomputed HERE, from the values that result under the lock (PD-032):
   * computed by the caller before the lock, a concurrent edit of the other
   * field would leave a due date the law does not say.
   */
  edit(
    requestId: string,
    changes: DataRequestChanges,
    requester: Requester,
    now: Date,
  ): Promise<EditRequestResult>;
  /**
   * PD-047. A rectified answer, linked to the one that stands, under the
   * request's lock; and its trail row. The original is never touched.
   */
  correctAnswer(
    requestId: string,
    answer: { outcome: DataRequestOutcome; response: string },
    requester: Requester,
    now: Date,
  ): Promise<CorrectAnswerResult>;
  find(requestId: string): Promise<DataRequestView | null>;
  /**
   * PD-049, PD-055, PD-056. Only what the proposal needs: the right, who
   * presents it and their name, and whether it asks for the copy — nothing
   * of the chart nor of what was asked.
   */
  proposalFactsOf(requestId: string): Promise<ProposalFacts | null>;
  /**
   * D-203 §1. Whether the request asks for the copy of the record, and the
   * sites where the person had a signed attention: what the key is checked
   * against before answering it. `null` when the request does not exist.
   */
  copyKeyOf(
    requestId: string,
  ): Promise<{ clinicalRecordCopy: boolean; patientSites: string[] } | null>;
  /** PD-036. */
  requestsOf(patientId: string): Promise<DataRequestView[]>;
  /**
   * PD-035, PD-051, PD-054. Unanswered, earliest due first, one page at a
   * time; `dueBy` keeps only those due at or before that instant (overdue).
   */
  open(
    filter: { right?: DataSubjectRight; dueBy?: Date },
    page: { page: number; pageSize: number },
  ): Promise<{ items: DataRequestView[]; total: number }>;
  /**
   * PD-040, PD-041, PD-043. Reads the chart and its absorbed ones and writes
   * the `EXPORT` trail row in the same transaction: if the row cannot be
   * written, the transaction fails and nothing is returned.
   */
  exportChart(
    requestId: string,
    patientId: string,
    omitted: readonly ExportOmission[],
    requester: Requester,
    now: Date,
  ): Promise<DataExportDocument>;
}

export const DATA_SUBJECT_REQUEST_REPOSITORY = Symbol(
  'DataSubjectRequestRepository',
);
