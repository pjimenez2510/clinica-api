import { NotFoundError } from './domain-error';

/**
 * «The master row you referenced does not exist», for the two rows that TWO
 * modules must be able to refuse.
 *
 * WHY IN `shared` AND NOT IN `specialties`, since 13-08-2026. `specialties`
 * owns the specialty (and owned the service type until ADR-013), and until then it also owned the
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

/**
 * SP-028, ST-009 (ADR-013). The service named as a consultation is not an
 * ACTIVE service of kind CONSULTATION — absent, retired, or an exam or a
 * procedure. Replaces `SERVICE_TYPE_NOT_FOUND`, which left with the table.
 *
 * WHY THE APPLICATION ANSWERS IT AND NOT A FOREIGN KEY: `agenda_entry_service_fk`
 * points at `service`, every kind of it. That the row is a consultation, and
 * an active one, is a rule over the referenced row a FK cannot state.
 */
export class ConsultationNotFoundError extends NotFoundError {
  readonly code = 'CONSULTATION_NOT_FOUND';
  override readonly userTitle =
    'La consulta elegida no existe o ya no se ofrece. Actualice la lista e intente de nuevo';

  constructor() {
    super('Consultation service not found', {}, [
      {
        field: 'serviceId',
        code: 'CONSULTATION_NOT_FOUND',
        message: 'Elija una consulta activa de la especialidad',
      },
    ]);
  }
}
