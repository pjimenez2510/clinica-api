import type { ClinicalDate } from '../../../shared/domain/clinic-time';

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

/** A service type with its base duration (SP-020) and what it charges (SP-030). */
export interface ServiceTypeView {
  id: string;
  specialtyId: string;
  name: string;
  durationMinutes: number;
  active: boolean;
  /** SP-031. Its first service, the one born with it; `null` if it has none. */
  billableServiceId: string | null;
  /** SP-030. That service's self-pay price in force today, decimal text. */
  price: string | null;
}

/**
 * Specialties and their service types with their base durations (SP-020).
 * Duplicates and references are arbitrated by the database, never checked
 * first; see the header.
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
   * SP-030: a new name renames the first service of each of its types.
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

  /** SP-029. One service type, active or not; `null` when there is none. */
  findServiceType(id: string): Promise<ServiceTypeView | null>;

  /**
   * SP-020, SP-030. The type AND its service —in an active CONSULTATION
   * category, at the health rate (SRI `0`), named «especialidad · tipo»— and,
   * with `price`, its self-pay price from `today`: one transaction. Throws
   * `ServiceTypeDuplicateError` on a repeated name (SP-026) and
   * `ConsultationBillingUnavailableError` when there is no category or rate.
   */
  createServiceType(input: {
    specialtyId: string;
    name: string;
    durationMinutes: number;
    price: string | null;
    today: ClinicalDate;
  }): Promise<ServiceTypeView>;

  /**
   * SP-024 lives in what this does NOT do: no appointment is read or written,
   * so a duration change can only rule forwards. SP-030: a new name renames
   * the type's first service too, in the same transaction; a type that has
   * no service (one created before D-179) is given its own, without price.
   */
  updateServiceType(
    id: string,
    patch: { name?: string; durationMinutes?: number; active?: boolean },
    today: ClinicalDate,
  ): Promise<ServiceTypeView | null>;

  /**
   * SP-025. Throws `ServiceTypeInUseError` when a FK RESTRICT refuses. SP-030:
   * the services no other type charges are deactivated, not deleted — a price
   * or a charge may name them.
   */
  deleteServiceType(id: string): Promise<boolean>;

  /**
   * D-021, SP-021. What each site dices its day into, so a base duration can
   * be refused when it does not tile the grid.
   *
   * IT READS `site_parameter`, WHICH IS `configuration`'s TABLE, and that is
   * what a port is for: `sin-imports-entre-modulos` forbids importing their
   * code, not reading rows through an adapter of our own. `agenda` already
   * reads `service_type` and `practitioner_schedule_rule` this way.
   *
   * EVERY SITE AND NOT ONE, because a service type has no site: it belongs to
   * the clinic and can therefore be given anywhere. Which single number the
   * list reduces to is `clinicSlotAtom` in `shared/domain`, where the reasoning
   * for choosing that rule over the alternatives is written down.
   */
  siteSlotAtoms(): Promise<readonly number[]>;
}

export const SPECIALTIES_REPOSITORY = Symbol('SpecialtiesRepository');
