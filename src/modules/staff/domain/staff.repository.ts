import type { ClinicalDate } from '../../../shared/domain/clinic-time';

/**
 * What administering the clinical profile of the staff needs from storage,
 * stated without naming a database.
 *
 * WHAT IS DELIBERATELY ABSENT: any "would this rule overlap?" query. ST-042 is
 * an EXCLUDE constraint, and a check-first method would be an invitation to
 * read, decide and lose the race the constraint exists to close. Absent too:
 * any "does this practitioner have history?" count before a delete — the FK
 * `RESTRICT` answers that, and a count would be stale before it returned.
 *
 * CEDULA AND ACESS ARE READ THROUGH `app_user`, NEVER COPIED. ST-001 and
 * ST-002 are satisfied by the relation: the account is where they live, the
 * unique index on `app_user.cedula` is the guarantee, and duplicating either
 * column onto `practitioner` would create two answers to one question.
 */

/** A practitioner as the administration screen and the agenda read them. */
export interface PractitionerView {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** ST-001. Lives on `app_user`, unique across the whole system. */
  cedula: string | null;
  /** ST-002. */
  acessRegistration: string | null;
  acessExpiresOn: ClinicalDate | null;
  /** ST-003: what RDACAA demands on every attention (REQ-021). */
  mspCode: string | null;
  /** ST-006. */
  schedulable: boolean;
  /** ST-010: deactivated, never deleted. */
  active: boolean;
  /** ST-008: the primary specialty, which is what the agenda lists. */
  primarySpecialty: { id: string; code: string; name: string } | null;
  /** ST-007. */
  siteIds: readonly string[];
}

/** One specialty a practitioner holds, with the flag ST-008 is about. */
export interface PractitionerSpecialtyView {
  specialtyId: string;
  code: string;
  name: string;
  active: boolean;
  isPrimary: boolean;
}

/** One row of the replacement set for a practitioner (ST-008). */
export interface SpecialtyAssignment {
  specialtyId: string;
  isPrimary: boolean;
}

/** A specialty as this module needs to judge it: does it exist, is it active. */
export interface SpecialtyReference {
  id: string;
  active: boolean;
}

/**
 * One service type reachable by a practitioner, with the two upper levels of
 * the D-010 hierarchy side by side so the caller can resolve them (ST-009).
 */
export interface PractitionerDurationRow {
  serviceTypeId: string;
  serviceTypeName: string;
  specialtyId: string;
  specialtyName: string;
  baseMinutes: number;
  /** The practitioner's own exception, or `null` when none is set. */
  exceptionMinutes: number | null;
}

/** A site a practitioner attends at (ST-007). */
export interface PractitionerSiteView {
  siteId: string;
  name: string;
  active: boolean;
}

/** ST-005: whose habilitación is about to run out. */
export interface AcessExpiryRow {
  practitionerId: string;
  firstName: string;
  lastName: string;
  acessRegistration: string;
  acessExpiresOn: ClinicalDate;
}

// The port described at the top of this file.
export interface StaffRepository {
  /** ST-010: deactivated rows travel only when explicitly asked for. */
  listPractitioners(
    includeInactive: boolean,
  ): Promise<readonly PractitionerView[]>;

  findPractitioner(id: string): Promise<PractitionerView | null>;

  /**
   * ST-001..ST-003, ST-006. The account must already exist: `auth` owns it,
   * and this module never creates one — a clinical profile is attached to an
   * account, and a receptionist has an account with no profile at all.
   *
   * Neither "does the account exist" nor "does it already have a profile" is
   * checked first: the FK and the unique index on `practitioner.user_id`
   * answer both, and `staff.constraints.ts` turns their names into
   * `USER_NOT_FOUND` and `PRACTITIONER_DUPLICATE`.
   */
  createPractitioner(input: {
    userId: string;
    mspCode: string | null;
    schedulable: boolean;
  }): Promise<PractitionerView>;

  /**
   * Patches the profile AND the habilitación that lives on the account, in one
   * transaction. `null` when the practitioner does not exist — the service
   * owns the refusal, so a missing row is an answer here, not an error.
   */
  updatePractitioner(
    id: string,
    patch: {
      mspCode?: string | null;
      schedulable?: boolean;
      active?: boolean;
      cedula?: string | null;
      acessRegistration?: string | null;
      acessExpiresOn?: ClinicalDate | null;
    },
  ): Promise<PractitionerView | null>;

  /**
   * ST-010. `false` when the row does not exist; throws
   * `PractitionerInUseError` when a FK RESTRICT refuses because there is
   * history. Deactivation is the answer offered in that case.
   */
  deletePractitioner(id: string): Promise<boolean>;

  /** ST-005. Everyone whose ACESS runs out on or before `through`. */
  listAcessExpiringThrough(
    through: ClinicalDate,
  ): Promise<readonly AcessExpiryRow[]>;

  listPractitionerSpecialties(
    practitionerId: string,
  ): Promise<readonly PractitionerSpecialtyView[]>;

  findSpecialtiesByIds(
    ids: readonly string[],
  ): Promise<readonly SpecialtyReference[]>;

  /**
   * Replace-set semantics (ST-008): the rows given are the whole assignment,
   * in one transaction. The partial unique index
   * `practitioner_specialty_one_primary` has the final word on "at most one".
   */
  replacePractitionerSpecialties(
    practitionerId: string,
    items: readonly SpecialtyAssignment[],
  ): Promise<void>;

  /** ST-009. The service types a practitioner's specialties offer. */
  listPractitionerDurations(
    practitionerId: string,
  ): Promise<readonly PractitionerDurationRow[]>;

  serviceTypeExists(id: string): Promise<boolean>;

  /** ST-009. Insert or update, one statement: the pair is the identity. */
  upsertDurationException(
    practitionerId: string,
    serviceTypeId: string,
    durationMinutes: number,
  ): Promise<void>;

  /** `false` when there was nothing to remove. */
  deleteDurationException(
    practitionerId: string,
    serviceTypeId: string,
  ): Promise<boolean>;

  /** ST-007. */
  listPractitionerSites(
    practitionerId: string,
  ): Promise<readonly PractitionerSiteView[]>;

  /** ST-007, replace-set in one transaction. */
  replacePractitionerSites(
    practitionerId: string,
    siteIds: readonly string[],
  ): Promise<void>;

  /**
   * D-021, SP-022. What each site dices its day into, so a per-practitioner
   * duration exception can be refused when it does not tile the grid.
   *
   * EVERY SITE AND NOT THE PRACTITIONER'S, and the difference is not academic:
   * the exception hangs off a `service_type`, which has no site, and a doctor
   * can be added to another site tomorrow without anybody revisiting their
   * exceptions. Validating against the sites they happen to work at today
   * would let that later assignment strand the exception silently. Which
   * single number the list reduces to is `clinicSlotAtom`.
   */
  siteSlotAtoms(): Promise<readonly number[]>;
}

export const STAFF_REPOSITORY = Symbol('StaffRepository');
