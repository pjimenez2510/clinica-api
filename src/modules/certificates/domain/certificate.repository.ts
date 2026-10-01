/**
 * What the medical certificate needs from storage, stated without naming a
 * database.
 *
 * A PORT: the application depends on this and the Prisma adapter implements
 * it. `dependency-cruiser` enforces the direction.
 *
 * The attention, the patient, the practitioner and the site are read through
 * THIS port and this module's own adapter, never by importing `encounter`,
 * `patients`, `staff` or `organization`: no module imports another.
 */

import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  CertificateType,
  ContingencyType,
  EncounterStatus,
  MaternityDates,
  PatientWork,
  IssuableCertificateType,
  RestPeriod,
} from './certificate';
import type { Form117Source } from '../../../shared/domain/form-117/form-117';

/**
 * The caller's site scope, as `Principal.sitesFor` states it: every site, or
 * an explicit list. Declared here and not imported from another module.
 */
export type SiteScopeFilter = 'all' | readonly string[];

/** CER-010. One certificate, by id, within the caller's scope. */
export interface CertificateQuery {
  certificateId: string;
  sites: SiteScopeFilter;
}

/** CER-001, CER-010. The certificates of one attention, within the scope. */
export interface EncounterCertificatesQuery {
  encounterId: string;
  sites: SiteScopeFilter;
}

/** CER-004. Who the caller is, clinically. */
export interface CertifierIdentity {
  practitionerId: string;
  /** CER-032. The code of the PRIMARY specialty, or `null` without one. */
  primarySpecialtyCode: string | null;
}

/**
 * CER-003, CER-008. What the issue has to judge, read INSIDE the transaction
 * that writes: the attention could be closed, or its diagnosis removed,
 * between a read and an insert.
 */
export interface IssueSnapshot {
  encounterStatus: EncounterStatus;
  /** CER-008. How many diagnoses the attention has. */
  diagnosisCount: number;
  /** CER-030. When the attention started; its clinical date is Ecuador's. */
  encounterStartedAt: Date;
  /** CER-036. The canton of the site's parish; `null` without a parish. */
  cityOfIssue: string | null;
  /** CER-038. Read from the chart of the attention, inside the issue. */
  patientWork: PatientWork;
}

/** CER-001. What the issue writes once the policy has accepted it. */
export interface CertificatePlan {
  type: IssuableCertificateType;
  rest: RestPeriod | null;
  includeDiagnosis: boolean;
  /** CER-034. `null` on attendance. */
  contingencyType: ContingencyType | null;
  /** CER-035. Present exactly with `MATERNITY`. */
  maternity: MaternityDates | null;
  /** CER-030. Present exactly when the rest starts before the attention. */
  backdatingReason: string | null;
  /** CER-004. The practitioner of the session, never an id of the request. */
  issuedById: string;
  issuedAt: Date;
  verificationCode: string;
}

/**
 * A certificate as this module serves it on the write path.
 *
 * ⚠️ NO PATIENT NAME AND NO DIAGNOSIS: those travel only in the form 117
 * (`Form117Source`), read through one audited route.
 */
export interface CertificateView {
  id: string;
  encounterId: string;
  patientId: string;
  /** CER-004. The practitioner who issued it. */
  issuedById: string;
  type: CertificateType;
  /** CER-009. Consecutive per site, assigned by the database at insert. */
  number: number;
  /** Random, for a third party to verify it. Not the number. */
  verificationCode: string;
  issuedAt: Date;
  /** CER-006. Calendar dates in Ecuador; `null` on an attendance certificate. */
  restFrom: ClinicalDate | null;
  restTo: ClinicalDate | null;
  /** CER-007. Answered explicitly by the doctor on every certificate. */
  includeDiagnosis: boolean;
  /** CER-034. `null` on attendance. */
  contingencyType: ContingencyType | null;
  /** CER-035. Present exactly with `MATERNITY`. */
  maternity: MaternityDates | null;
  /** CER-030. Why the rest starts before the attention, or `null`. */
  backdatingReason: string | null;
  /** CER-011. Who, when and why — the three together or none. */
  revokedAt: Date | null;
  revokedById: string | null;
  revocationReason: string | null;
}

/** CER-011. What annulling writes: the three together, never fewer. */
export interface RevocationPlan {
  revokedAt: Date;
  /** The ACCOUNT that annulled it: `revoked_by_id` targets `app_user`. */
  revokedById: string;
  reason: string;
}

/** The port the certificate service depends on. */
export interface CertificateRepository {
  /** CER-004. The caller's active clinical profile, or `null`. */
  findCertifierByUser(userId: string): Promise<CertifierIdentity | null>;

  /** CER-002, CER-010. Whether the attention exists within the scope. */
  encounterExists(query: EncounterCertificatesQuery): Promise<boolean>;

  /**
   * CER-001 to CER-009. One issue, one transaction.
   *
   * The adapter reads the attention within the scope — refusing with
   * `CERTIFICATE_ENCOUNTER_NOT_FOUND` when it is not there — hands the
   * snapshot to `decide`, and inserts what it returns with the patient OF
   * THAT ATTENTION. The number and the site are the trigger's.
   */
  issue(
    query: EncounterCertificatesQuery,
    decide: (snapshot: IssueSnapshot) => CertificatePlan,
  ): Promise<CertificateView>;

  /** CER-010. The certificates of one attention, newest first. */
  listOfEncounter(
    query: EncounterCertificatesQuery,
  ): Promise<CertificateView[]>;

  /**
   * CER-011, CER-012. Annuls the certificate. NOTHING IS DELETED.
   *
   * Conditional on `revoked_at IS NULL`: of two people annulling at once one
   * wins and the other is refused with `CERTIFICATE_ALREADY_REVOKED`.
   * Refuses with `CERTIFICATE_NOT_FOUND` outside the scope.
   */
  revoke(
    query: CertificateQuery,
    plan: RevocationPlan,
  ): Promise<CertificateView>;

  /**
   * CER-010, CER-020 to CER-029. Everything form 117 prints about one
   * certificate within the caller's scope, or `null`. ONE STATEMENT, so the
   * answers describe the same instant.
   */
  form117SourceOf(query: CertificateQuery): Promise<Form117Source | null>;
}

/** Injection token. The application never names the adapter. */
export const CERTIFICATE_REPOSITORY = Symbol('CertificateRepository');
