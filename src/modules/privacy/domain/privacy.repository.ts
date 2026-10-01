import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type { DataSubjectRight } from './legal-due-date';

/** Who acts, so the trail can say so. */
export interface Requester {
  userId: string;
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
  | { status: 'active' }
  | { status: 'missing' }
  | { status: 'merged'; survivingMrn: string };

// --- PD1, PD2 ------------------------------------------------------------------

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

export interface ConsentRepository {
  chartOf(patientId: string): Promise<ChartLookup>;
  currentText(): Promise<ConsentTextView | null>;
  texts(): Promise<ConsentTextView[]>;
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

// --- PD3, PD4 ------------------------------------------------------------------

export interface DataRequestAnswer {
  outcome: DataRequestOutcome;
  response: string;
  answeredAt: Date;
  answeredBy: StaffName;
}

export interface DataRequestView {
  id: string;
  patientId: string;
  patient: { mrn: string; fullName: string };
  right: DataSubjectRight;
  requestedBy: DataSubjectParty;
  description: string;
  receivedAt: Date;
  dueOn: ClinicalDate;
  registeredAt: Date;
  registeredBy: StaffName;
  answer: DataRequestAnswer | null;
}

export interface NewDataRequest {
  patientId: string;
  right: DataSubjectRight;
  requestedBy: DataSubjectParty;
  description: string;
  receivedAt: Date;
  dueOn: ClinicalDate;
}

export type AnswerResult =
  | { status: 'answered'; request: DataRequestView }
  | { status: 'missing' }
  | { status: 'already-answered' };

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
  omitted: readonly ExportOmission[];
}

export interface ExportOmission {
  section: string;
  reason: string;
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
  /** PD-033, PD-037, PD-038. Answer and trail row in one transaction. */
  answer(
    requestId: string,
    answer: { outcome: DataRequestOutcome; response: string },
    requester: Requester,
  ): Promise<AnswerResult>;
  find(requestId: string): Promise<DataRequestView | null>;
  /** PD-036. */
  requestsOf(patientId: string): Promise<DataRequestView[]>;
  /** PD-035. Unanswered, earliest due first. */
  open(): Promise<DataRequestView[]>;
  /**
   * PD-040, PD-041, PD-043. Reads the chart and its absorbed ones and writes
   * the `EXPORT` trail row in the same transaction: if the row cannot be
   * written, the transaction fails and nothing is returned.
   */
  exportChart(
    patientId: string,
    omitted: readonly ExportOmission[],
    requester: Requester,
    now: Date,
  ): Promise<DataExportDocument>;
}

export const DATA_SUBJECT_REQUEST_REPOSITORY = Symbol(
  'DataSubjectRequestRepository',
);
