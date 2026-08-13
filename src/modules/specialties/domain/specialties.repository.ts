/**
 * What administering the clinic's parametrisation needs from storage, stated
 * without naming a database.
 *
 * WHAT IS DELIBERATELY ABSENT: any "does this duplicate exist?" query. The
 * uniqueness of codes and names (SP-006, SP-026) is enforced by functional
 * unique indexes; a check-first method would be an invitation to read, decide
 * and lose the race the index exists to close. The adapter lets PostgreSQL
 * arbitrate and translates the refusal into the domain errors of this module.
 *
 * ABSENT SINCE 13-08-2026: everything about a PRACTITIONER. The assignment of
 * specialties and the per-practitioner duration exceptions moved to `staff`
 * as ST-008 and ST-009, settling the debt this SPEC declared the day before.
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

export interface SpecialtiesRepository {
  /** SP-007: `includeInactive` decides whether deactivated rows travel. */
  listSpecialties(includeInactive: boolean): Promise<readonly SpecialtyView[]>;

  findSpecialty(id: string): Promise<SpecialtyView | null>;

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
}

export const SPECIALTIES_REPOSITORY = Symbol('SpecialtiesRepository');
