/**
 * What administering the clinic's parametrisation needs from storage, stated
 * without naming a database.
 *
 * WHAT IS DELIBERATELY ABSENT: any "does this duplicate exist?" query. The
 * uniqueness of codes and names (SP-006, SP-026) and the at-most-one-primary
 * rule (SP-005) are functional and partial unique indexes; a check-first
 * method would be an invitation to read, decide and lose the race the index
 * exists to close. The adapter lets PostgreSQL arbitrate and translates the
 * refusal into the domain errors of this module.
 */

/** A specialty as the administration screen lists it (SP-001, SP-007). */
export interface SpecialtyView {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/** A service type with its base duration (SP-020). */
export interface ServiceTypeView {
  id: string;
  specialtyId: string;
  name: string;
  durationMinutes: number;
  active: boolean;
}

/** One specialty a practitioner holds, with the flag SP-005 is about. */
export interface PractitionerSpecialtyView {
  specialtyId: string;
  code: string;
  name: string;
  active: boolean;
  isPrimary: boolean;
}

/** One row of the replacement set for a practitioner (SP-005). */
export interface SpecialtyAssignment {
  specialtyId: string;
  isPrimary: boolean;
}

/**
 * One service type reachable by a practitioner, with the two upper levels of
 * the SP-023 hierarchy side by side so the caller can resolve them.
 */
export interface PractitionerDurationRow {
  serviceTypeId: string;
  serviceTypeName: string;
  specialtyId: string;
  specialtyName: string;
  baseMinutes: number;
  /** The practitioner's own exception, or `null` when none is set (SP-022). */
  exceptionMinutes: number | null;
}

export interface SpecialtiesRepository {
  /** SP-007: `includeInactive` decides whether deactivated rows travel. */
  listSpecialties(includeInactive: boolean): Promise<readonly SpecialtyView[]>;

  findSpecialty(id: string): Promise<SpecialtyView | null>;

  findSpecialtiesByIds(
    ids: readonly string[],
  ): Promise<readonly SpecialtyView[]>;

  /** SP-002. Throws `SpecialtyDuplicateError` when the base refuses (SP-006). */
  createSpecialty(input: {
    code: string;
    name: string;
  }): Promise<SpecialtyView>;

  /**
   * Rename or (de)activate. `null` when the row does not exist — the service
   * owns the refusal, so a missing row is an answer here, not an error.
   */
  updateSpecialty(
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<SpecialtyView | null>;

  /**
   * Hard delete (SP-003). `false` when the row does not exist; throws
   * `SpecialtyInUseError` when a FK RESTRICT refuses.
   */
  deleteSpecialty(id: string): Promise<boolean>;

  listServiceTypes(
    specialtyId: string,
    includeInactive: boolean,
  ): Promise<readonly ServiceTypeView[]>;

  findServiceType(id: string): Promise<ServiceTypeView | null>;

  /** SP-020. Throws `ServiceTypeDuplicateError` on a repeated name (SP-026). */
  createServiceType(input: {
    specialtyId: string;
    name: string;
    durationMinutes: number;
  }): Promise<ServiceTypeView>;

  /**
   * SP-024 lives in what this does NOT do: it touches exactly one
   * `service_type` row and nothing else — no appointment is read or written,
   * so a duration change can only rule forwards.
   */
  updateServiceType(
    id: string,
    patch: { name?: string; durationMinutes?: number; active?: boolean },
  ): Promise<ServiceTypeView | null>;

  /** SP-025. Throws `ServiceTypeInUseError` when a FK RESTRICT refuses. */
  deleteServiceType(id: string): Promise<boolean>;

  practitionerExists(id: string): Promise<boolean>;

  listPractitionerSpecialties(
    practitionerId: string,
  ): Promise<readonly PractitionerSpecialtyView[]>;

  /**
   * Replace-set semantics (SP-005): the rows given are the whole assignment,
   * in one transaction — delete what is not named, keep or insert the rest.
   * The partial unique index has the final word on "at most one primary".
   */
  replacePractitionerSpecialties(
    practitionerId: string,
    items: readonly SpecialtyAssignment[],
  ): Promise<void>;

  /** The service types a practitioner's specialties offer, with exceptions. */
  listPractitionerDurations(
    practitionerId: string,
  ): Promise<readonly PractitionerDurationRow[]>;

  /** SP-022. Insert or update, the same statement: the pair is the identity. */
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
}

export const SPECIALTIES_REPOSITORY = Symbol('SpecialtiesRepository');
