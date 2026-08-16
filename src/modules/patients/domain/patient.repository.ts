import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  PriorityGroup,
  PriorityGroupOrigin,
  RecordedPriorityGroup,
} from './priority-groups';

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
  /**
   * PA-041. The priority the agenda orders by — `1` prioritised, `2` ordinary
   * — ALREADY CALCULATED, and never the reason.
   *
   * It travels with `patient:read` on purpose: the waiting list needs the
   * ORDER to work, and the reason is health data behind its own audited door
   * (PA-040, AG-073). A listing that carried the reason «porque la pantalla ya
   * lo tiene» would hand the social diagnosis of half the clinic to anybody
   * who can open a waiting list (PA-042, SC-010).
   */
  priority: number;
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

/**
 * Por qué columna se ordena.
 *
 * UNA LISTA CERRADA, no el nombre de columna que llegue. La ordenación acaba
 * concatenada en SQL, así que aceptar texto libre es una inyección esperando
 * a ocurrir; y además obliga a decidir explícitamente qué es ordenable, que es
 * una decisión de producto y no un detalle de la tabla.
 */
export type PatientSortField = 'name' | 'mrn' | 'birthDate';
export type SortDirection = 'asc' | 'desc';

export interface PatientSearchCriteria {
  sortBy: PatientSortField;
  sortDirection: SortDirection;
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

/**
 * One recorded assessment, as the application reads it back (PA-033, PA-038,
 * PA-039).
 *
 * The period is two CALENDAR DATES and not two instants: whether a pregnancy
 * still counts is a question about a day, and an instant would make the answer
 * depend on the hour it was asked.
 */
export interface PriorityGroupRecord {
  id: string;
  group: PriorityGroup;
  startsOn: ClinicalDate;
  endsOn: ClinicalDate | null;
  origin: PriorityGroupOrigin;
  evidenceDocument: string | null;
  /** PA-039. Who recorded it and when. */
  recordedById: string;
  recordedAt: Date;
  closedById: string | null;
  closedAt: Date | null;
}

export interface NewPriorityGroup {
  patientId: string;
  group: PriorityGroup;
  startsOn: ClinicalDate;
  endsOn: ClinicalDate | null;
  origin: PriorityGroupOrigin;
  evidenceDocument: string | null;
  recordedById: string;
}

/** The two columns the ORDER depends on, and nothing that says why. */
export interface PatientPriorityInput {
  birthDate: ClinicalDate;
  recorded: readonly RecordedPriorityGroup[];
}

export interface PatientRepository {
  search(criteria: PatientSearchCriteria): Promise<PatientPage>;
  findById(id: string): Promise<PatientDetail | null>;
  /**
   * Whether the chart exists at all, without opening it.
   *
   * SEPARATE FROM `findById` because opening a chart is the ACCOUNTABLE act
   * that writes an audit row (PA-022). Recording a priority group needs to
   * know the patient exists and nothing else; reusing `findById` would put a
   * «somebody opened this chart» row in the LOPDP trail for an act that opened
   * nothing.
   */
  exists(id: string): Promise<boolean>;
  /**
   * Every recorded assessment of one patient, in force or not.
   *
   * NOT FILTERED BY DATE HERE. Whether a period counts is a domain decision
   * (`isPeriodInForce`), and pushing it into SQL would put the rule in two
   * places — the one that has to be corrected the day «hasta el 15» stops
   * including the 15th. Closed rows come back too: they are the answer to
   * «¿por qué esta persona tuvo prioridad en marzo?» (PA-037).
   */
  listPriorityGroups(
    patientId: string,
  ): Promise<readonly PriorityGroupRecord[]>;
  addPriorityGroup(record: NewPriorityGroup): Promise<PriorityGroupRecord>;
  /**
   * Sets the end date of a record. NEVER deletes it (PA-037).
   *
   * Returns `null` when the record does not exist or belongs to another
   * patient, so the caller answers the same thing in both cases.
   */
  closePriorityGroup(input: {
    patientId: string;
    recordId: string;
    endsOn: ClinicalDate;
    closedById: string;
  }): Promise<PriorityGroupRecord | null>;
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
