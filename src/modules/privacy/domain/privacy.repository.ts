import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { RecordReadScope } from '../../../shared/domain/clinical-record-key';

import type {
  DataRequestParty,
  DataRequestRelationship,
} from './data-request-party';
import type {
  AuthorizationChannel,
  AuthorizationPurpose,
  ChartContact,
} from './patient-authorization';
import type { DataSubjectRight } from './legal-due-date';

/** Who acts, so the trail can say so. */
export interface Requester {
  userId: string;
  /**
   * D-203 §1. The caller's `record:read` scope: the key to answer a copy of
   * the clinical record. Absent is none.
   */
  recordScope?: RecordReadScope;
  /**
   * PD-061 (D-203 §5). The caller's `record:protected` scope: the key to give
   * the review of a copy. Absent is none.
   */
  protectedScope?: RecordReadScope;
  ip?: string;
  userAgent?: string;
}

/** Somebody on the staff, as a screen names them. Never their cedula. */
export interface StaffName {
  id: string;
  fullName: string;
}

export const DATA_REQUEST_OUTCOMES = [
  'GRANTED',
  'PARTIALLY_GRANTED',
  'DENIED',
] as const;
export type DataRequestOutcome = (typeof DATA_REQUEST_OUTCOMES)[number];

/**
 * What a chart id resolves to before anything is written about it (PD-075).
 * A merged chart names its survivor so the screen can open the right one.
 */
export type ChartLookup =
  /** PD-052. `deceased`: the chart records the patient's death. */
  | { status: 'active'; deceased: boolean }
  | { status: 'missing' }
  | { status: 'merged'; survivingMrn: string };

// --- D1, D8 ------------------------------------------------------------------

/** PD-001. A published version of the privacy notice. */
export interface PrivacyNoticeView {
  id: string;
  version: number;
  body: string;
  publishedAt: Date;
  publishedBy: StaffName;
}

export interface PrivacyNoticeRepository {
  /** PD-001. Newest first; empty while nothing is published. */
  versions(): Promise<PrivacyNoticeView[]>;
  /**
   * PD-002, PD-005, PD-006. The next version and its trail row, in one
   * transaction. Throws `PrivacyNoticeVersionConflictError` on the race.
   */
  publish(body: string, requester: Requester): Promise<PrivacyNoticeView>;
}

export const PRIVACY_NOTICE_REPOSITORY = Symbol('PrivacyNoticeRepository');

/** PD-068. An optional authorization as the chart shows it. */
export interface PatientAuthorizationView {
  id: string;
  /** The chart the row was written against: an absorbed one after a merge. */
  patientId: string;
  purpose: AuthorizationPurpose;
  channel: AuthorizationChannel | null;
  recordedAt: Date;
  recordedBy: StaffName;
  /** PD-072. `null` while it stands. */
  revokedAt: Date | null;
  revokedBy: StaffName | null;
}

export interface NewAuthorization {
  patientId: string;
  purpose: AuthorizationPurpose;
  channel: AuthorizationChannel | null;
}

export type GrantAuthorizationResult =
  | { status: 'granted'; authorization: PatientAuthorizationView }
  | { status: 'already-granted' };

export type RevokeAuthorizationResult =
  | { status: 'revoked'; authorization: PatientAuthorizationView }
  | { status: 'missing' }
  | { status: 'already-revoked' };

export interface AuthorizationRepository {
  chartOf(patientId: string): Promise<ChartLookup>;
  /** PD-070. Of the chart itself, never of an absorbed one. */
  contactOf(patientId: string): Promise<ChartContact>;
  /**
   * PD-068, PD-071, PD-074. The authorization and its trail row in one
   * transaction; `already-granted` when the base refuses a second standing
   * one (`patient_authorization_one_standing`).
   */
  grant(
    authorization: NewAuthorization,
    requester: Requester,
    now: Date,
  ): Promise<GrantAuthorizationResult>;
  /**
   * PD-072, PD-074. The revocation and its trail row in one transaction, of
   * an authorization of the chart or of its absorbed ones.
   */
  revoke(
    patientId: string,
    authorizationId: string,
    requester: Requester,
    now: Date,
  ): Promise<RevokeAuthorizationResult>;
  /** PD-073. The chart and the charts merged into it, newest first. */
  authorizationsOf(patientId: string): Promise<PatientAuthorizationView[]>;
}

export type { ChartContact };

export const AUTHORIZATION_REPOSITORY = Symbol('AuthorizationRepository');

// --- D3, D4 ------------------------------------------------------------------

export interface DataRequestAnswer {
  outcome: DataRequestOutcome;
  response: string;
  answeredAt: Date;
  answeredBy: StaffName;
  /** PD-047. Whether this answer rectifies an earlier one. */
  isCorrection: boolean;
  /** PD-059. The period a copy answered «Atendida en parte» hands over. */
  copyPeriod: CopyPeriod | null;
}

/**
 * PD-059 (D-203 §2). What an authorisation of the copy hands over: the whole
 * record («Atendida»), or the attentions of a period («Atendida en parte»).
 */
export interface CopyPeriod {
  from: ClinicalDate;
  to: ClinicalDate;
}

/** PD-061. A professional's review of a copy. */
export interface CopyReviewView {
  reviewedAt: Date;
  reviewedBy: StaffName;
  /** D-203 §6. The violence screening goes in the copy. */
  includesScreening: boolean;
}

/** PD-059. An answer as it is given: the outcome, the text, the period. */
export interface GivenAnswer {
  outcome: DataRequestOutcome;
  response: string;
  copyPeriod: CopyPeriod | null;
  /**
   * DOC-122. What an authorised copy carries, frozen now and saved with the
   * answer. Opaque here: `documents` composes it and reads it back.
   */
  snapshot?: unknown;
  /**
   * PD-062. The copy is not the holder's and hands the record over: the
   * repository refuses it, under the request's lock, without a review that
   * stands.
   */
  guardReview?: boolean;
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
  /** PD-063. The relative's relationship with the deceased patient. */
  requesterRelationship: DataRequestRelationship | null;
  /** PD-053. It asks for the copy of the clinical record. */
  clinicalRecordCopy: boolean;
  documentsChecked: boolean;
  description: string;
  receivedAt: Date;
  /** PD-061. The professional's latest review, on a copy that has one. */
  review: CopyReviewView | null;
  /**
   * PD-062. Granting this copy waits for the review: it is not the holder's
   * and the record holds something sensitive, with no review that stands.
   * Shown only to whoever holds a key to the record (the service).
   */
  reviewRequired: boolean;
  /**
   * D-203 §1, §12. The sites where the person had a signed attention, on a
   * copy: what the key is checked against. Internal — not part of a response.
   */
  copySites: readonly string[];
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
  requesterRelationship: DataRequestRelationship | null;
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
  | { status: 'already-answered' }
  | { status: 'review-required' };

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
  | { status: 'not-answered' }
  | { status: 'review-required' };

export type ReviewCopyResult =
  | { status: 'reviewed'; request: DataRequestView }
  | { status: 'missing' }
  | { status: 'already-reviewed' }
  | { status: 'already-authorised' };

/**
 * D-203 §1, §5, §12. What a copy request is checked against before it is
 * authorised or reviewed: who presents it, the sites where the person had a
 * signed attention, whether the record holds something sensitive, and
 * whether a professional already reviewed it.
 */
export interface CopyFacts {
  clinicalRecordCopy: boolean;
  requestedBy: DataRequestParty;
  patientSites: string[];
  sensitive: boolean;
  /** PD-061. A review stands: the latest, after the last sensitive datum. */
  reviewed: boolean;
  /**
   * PD-061 (revisión). Where whoever reviews must hold `record:protected`:
   * the sites with something sensitive or with a screening answered.
   */
  reviewSites: string[];
}

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
  /** PD-066. v2 adds `deliveries`; v3 `authorizations` for `consents` (D-221). */
  formatVersion: 3;
  generatedAt: string;
  patient: Readonly<Record<string, unknown>>;
  identifiers: readonly Readonly<Record<string, unknown>>[];
  authorizations: readonly Readonly<Record<string, unknown>>[];
  requests: readonly Readonly<Record<string, unknown>>[];
  /**
   * PD-066 (D-203 §9). Every copy of the record that was authorised: to whom,
   * of what class, when, what and why (LOPDP arts. 12.10 and 13).
   */
  deliveries: readonly Readonly<Record<string, unknown>>[];
  /**
   * PD-076 (D-176 §3b). The current board note of each of the subject's
   * appointments that has one: what was said about them, not who said it.
   */
  boardNotes: readonly Readonly<Record<string, unknown>>[];
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
  /** D-203 §6. The professional's review includes the screening. */
  includesScreening: boolean;
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
    answer: GivenAnswer,
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
    answer: GivenAnswer,
    requester: Requester,
    now: Date,
  ): Promise<CorrectAnswerResult>;
  /**
   * PD-061. The review and its trail row, under the request's lock: once, and
   * never after the standing answer authorised the copy.
   */
  reviewCopy(
    requestId: string,
    review: { includesScreening: boolean },
    requester: Requester,
    now: Date,
  ): Promise<ReviewCopyResult>;
  /** PD-061. The copies of a chart (and its absorbed ones) not authorised. */
  pendingCopiesOf(patientId: string): Promise<DataRequestView[]>;
  find(requestId: string): Promise<DataRequestView | null>;
  /**
   * PD-049, PD-055, PD-056. Only what the proposal needs: the right, who
   * presents it and their name, and whether it asks for the copy — nothing
   * of the chart nor of what was asked.
   */
  proposalFactsOf(requestId: string): Promise<ProposalFacts | null>;
  /**
   * D-203 §1, §5. What the key and the review are checked against before a
   * copy is authorised (`CopyFacts`). `null` when the request does not exist.
   */
  copyFactsOf(requestId: string): Promise<CopyFacts | null>;
  /**
   * PD-067. What the export of this request leaves out of the clinical
   * versions for a caller with this `record:read` scope: the same line the
   * file carries in `omitted`, so the proposal (PD-049) says it too.
   */
  clinicalOmissionOf(
    requestId: string,
    scope: RecordReadScope,
  ): Promise<ExportOmission | null>;
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
