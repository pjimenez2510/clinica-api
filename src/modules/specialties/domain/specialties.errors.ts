import { ConflictError } from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong when administering the clinic's parametrisation, in
 * business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`
 * (NotFoundError is 404, ConflictError 409, ValidationError and
 * BusinessRuleViolation 422). The codes for duplicates and "in use" are fixed
 * by the SPEC's error table (SP-003, SP-006, SP-025, SP-026); the guarantees
 * behind them are PostgreSQL's — functional unique indexes and FK RESTRICT —
 * and the infrastructure adapter translates the constraint that fired into
 * one of these classes, which is why they are defined HERE and only thrown
 * THERE (the constitution's rule: infrastructure throws domain errors, it
 * does not define them).
 *
 * WHAT LEFT THIS FILE ON 13-08-2026, when `staff` settled the declared debt:
 *   - `SPECIALTY_NOT_FOUND` and `SERVICE_TYPE_NOT_FOUND` moved to
 *     `shared/domain/errors/master-data.errors.ts`. Both modules must answer
 *     them and no module may import another.
 *   - `PRACTITIONER_NOT_FOUND`, `PRIMARY_SPECIALTY_REQUIRED` and
 *     `SPECIALTY_INACTIVE` moved to `modules/staff/domain/staff.errors.ts`.
 *     They are raised only where a practitioner is administered, and that is
 *     `staff` now. The strings did not change: a code is a public contract and
 *     changing the emitter must not change it.
 */

/**
 * SP-006. Two specialties may not share a code or a name, compared without
 * case or accents — «Pediatría» and «PEDIATRIA» are the same specialty typed
 * twice. The guarantee lives in the base as two functional unique indexes
 * (`specialty_code_unique`, `specialty_name_unique`); which field collided is
 * known from the constraint that fired, and the field error points at it so
 * the form highlights the right box.
 */
export class SpecialtyDuplicateError extends ConflictError {
  readonly code = 'SPECIALTY_DUPLICATE';
  override readonly userTitle =
    'Ya existe una especialidad con ese código o nombre. Revise el catálogo antes de crear otra';

  constructor(field: 'code' | 'name') {
    // No rejected value in the message: it reaches logs and screenshots, and
    // the person who typed it is looking at it already.
    super(`Specialty ${field} already exists (case/accent-insensitive)`, {}, [
      {
        field,
        code: 'SPECIALTY_DUPLICATE',
        message:
          field === 'code'
            ? 'Ese código ya pertenece a otra especialidad'
            : 'Ese nombre ya pertenece a otra especialidad (la comparación ignora mayúsculas y acentos)',
      },
    ]);
  }
}

/**
 * SP-003. Deleting a specialty referenced by a practitioner, a service type
 * or an appointment is refused; the offer to deactivate instead is the other
 * half of the requirement, and it travels in the user-facing sentence. The
 * guarantee is the FK `ON DELETE RESTRICT`, so this is raised from the
 * adapter when PostgreSQL says no.
 */
export class SpecialtyInUseError extends ConflictError {
  readonly code = 'SPECIALTY_IN_USE';
  override readonly userTitle =
    'La especialidad está en uso y no puede borrarse. Puede desactivarla para que no se ofrezca más';

  constructor() {
    super('Specialty is referenced and cannot be deleted');
  }
}

/**
 * SP-026. Two service types may not share a name inside one specialty; the
 * guarantee is the functional unique index
 * `service_type_name_unique_per_specialty`.
 */
export class ServiceTypeDuplicateError extends ConflictError {
  readonly code = 'SERVICE_TYPE_DUPLICATE';
  override readonly userTitle =
    'Ya existe un tipo de atención con ese nombre en la especialidad. Revise la lista antes de crear otro';

  constructor() {
    super('Service type name already exists within the specialty', {}, [
      {
        field: 'name',
        code: 'SERVICE_TYPE_DUPLICATE',
        message:
          'Ese nombre ya pertenece a otro tipo de atención de la especialidad',
      },
    ]);
  }
}

/**
 * SP-025. Deleting a service type referenced by an appointment is refused,
 * offering deactivation. Today the only incoming references CASCADE by design
 * (duration exceptions die with their type), so the path is armed for the day
 * `agenda_entry` points here (C4) — the adapter already translates the FK
 * refusal, and this class is the code the spec fixes for it.
 */
export class ServiceTypeInUseError extends ConflictError {
  readonly code = 'SERVICE_TYPE_IN_USE';
  override readonly userTitle =
    'El tipo de atención está en uso y no puede borrarse. Puede desactivarlo para que no se ofrezca más';

  constructor() {
    super('Service type is referenced and cannot be deleted');
  }
}
