import { NotFoundError } from './domain-error';

/**
 * «The master row you referenced does not exist», for the two rows that TWO
 * modules must be able to refuse.
 *
 * WHY IN `shared` AND NOT IN `specialties`, since 13-08-2026. `specialties`
 * owns the specialty and the service type, and until today it also owned the
 * endpoints that assign them to a practitioner. ST-008 and ST-009 moved those
 * endpoints to `staff`, which now has to answer «that specialty does not
 * exist» with the SAME code — `code` is a public contract and changing the
 * emitter must not change the string.
 *
 * The alternative was for `staff` to import the class from `specialties`,
 * which `dependency-cruiser`'s `sin-imports-entre-modulos` refuses outright:
 * it is a build error, not a preference. This is the path `INVALID_RUC`
 * already took for exactly the same reason — two modules validating the same
 * thing for different purposes — and the one `clinic-time` took before it.
 *
 * NOT MOVED HERE: the duplicates and the «in use» conflicts. Those are raised
 * by the adapter of the module that owns the table, from a constraint only
 * that module writes, and no second module can produce them.
 */

/** The specialty does not exist. Never says whether it once did. */
export class SpecialtyNotFoundError extends NotFoundError {
  readonly code = 'SPECIALTY_NOT_FOUND';
  override readonly userTitle =
    'La especialidad indicada no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Specialty not found');
  }
}

/** The service type does not exist. */
export class ServiceTypeNotFoundError extends NotFoundError {
  readonly code = 'SERVICE_TYPE_NOT_FOUND';
  override readonly userTitle =
    'El tipo de atención indicado no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Service type not found');
  }
}
