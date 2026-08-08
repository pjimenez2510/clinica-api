/**
 * What the application needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this, the Prisma adapter implements it.
 * `dependency-cruiser` enforces the direction, and the reason is not purity —
 * it is that the search below is going to be rewritten (trigram today,
 * possibly a dedicated index later) and that rewrite must not reach a single
 * line of business logic.
 */

/** Sex as recorded. Never inferred, never defaulted. */
export type PatientSex = 'MALE' | 'FEMALE' | 'INTERSEX' | 'UNKNOWN';

export type IdentifierType =
  'CEDULA' | 'PASSPORT' | 'REFUGEE_CARD' | 'FOREIGN_ID' | 'PROVISIONAL';

export interface PatientIdentifier {
  type: IdentifierType;
  /** ISO 3166-1 alpha-3. Two passports may share a number across countries. */
  issuingCountry: string;
  value: string;
}

/**
 * A patient as a list shows them.
 *
 * Deliberately NOT the whole record. A search result appears on screen for
 * every name typed, and shipping the full chart to draw a row would put
 * clinical data in memory nobody asked to see.
 */
export interface PatientSummary {
  id: string;
  mrn: string;
  familyName: string;
  secondFamilyName: string | null;
  givenName: string;
  secondGivenName: string | null;
  sex: PatientSex;
  birthDate: Date;
  birthDateEstimated: boolean;
  deceasedAt: Date | null;
  /** The identifier a receptionist would quote. `null` for provisional records. */
  primaryIdentifier: PatientIdentifier | null;
}

export interface PatientDetail extends PatientSummary {
  phone: string | null;
  email: string | null;
  bloodType: string | null;
  residenceAddressLine: string | null;
  isProvisional: boolean;
  identifiers: readonly PatientIdentifier[];
  /** Set once a duplicate is resolved. The record stays, it does not vanish. */
  mergedIntoMrn: string | null;
  createdAt: Date;
}

export interface PatientSearchCriteria {
  /** Free text: name fragments, or an identifier typed in full. */
  query?: string;
  page: number;
  pageSize: number;
  /** Merged records are hidden unless explicitly asked for. */
  includeMerged: boolean;
}

export interface PatientPage {
  items: readonly PatientSummary[];
  total: number;
}

export interface NewPatient {
  familyName: string;
  secondFamilyName?: string;
  givenName: string;
  secondGivenName?: string;
  sex: PatientSex;
  birthDate: Date;
  birthDateEstimated: boolean;
  phone?: string;
  email?: string;
  residenceAddressLine?: string;
  bloodType?: string;
  identifier?: PatientIdentifier;
}

export interface PatientRepository {
  search(criteria: PatientSearchCriteria): Promise<PatientPage>;
  findById(id: string): Promise<PatientDetail | null>;
  /** Used to refuse a duplicate before the database has to. */
  findByIdentifier(
    identifier: PatientIdentifier,
  ): Promise<PatientSummary | null>;
  /**
   * The MRN is NOT a parameter: the caller cannot know it and must not choose
   * it. It is issued from a sequence inside the same transaction as the row.
   */
  create(patient: NewPatient): Promise<PatientDetail>;
}

/** Injection token. The application never names the adapter. */
export const PATIENT_REPOSITORY = Symbol('PatientRepository');
