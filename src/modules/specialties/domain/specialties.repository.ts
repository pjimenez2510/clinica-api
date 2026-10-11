/**
 * What administering the clinic's specialties needs from storage, stated
 * without naming a database.
 *
 * WHAT IS DELIBERATELY ABSENT: any "does this duplicate exist?" query. The
 * uniqueness of codes and names (SP-006) is enforced by functional unique
 * indexes; a check-first method would be an invitation to read, decide and
 * lose the race the index exists to close. The adapter lets PostgreSQL
 * arbitrate and translates the refusal into the domain errors of this module.
 *
 * ABSENT SINCE 13-08-2026: everything about a PRACTITIONER. The assignment of
 * specialties and the per-practitioner duration exceptions moved to `staff`
 * as ST-008 and ST-009.
 *
 * ABSENT SINCE 11-10-2026 (ADR-013): the service types and their base
 * durations. A consultation is a `service` of kind CONSULTATION with its
 * specialty, duration and visit (BI-279), administered in «Servicios»; this
 * module keeps the specialty itself.
 */

/** A specialty as the administration screen lists it (SP-001, SP-007). */
export interface SpecialtyView {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/**
 * The clinic's specialties. Duplicates and references are arbitrated by the
 * database, never checked first; see the header.
 */
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
   * Renaming touches the specialty alone: since ADR-013 no service is named
   * after it by the system.
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
}

export const SPECIALTIES_REPOSITORY = Symbol('SpecialtiesRepository');
