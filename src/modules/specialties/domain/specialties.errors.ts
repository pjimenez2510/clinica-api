import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

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

/**
 * The practitioner whose specialties or durations are being administered does
 * not exist. A 404 and not a foreign-key 422: the identifier names the
 * resource in the URL, so a wrong one is a missing resource, not bad data.
 */
export class PractitionerNotFoundError extends NotFoundError {
  readonly code = 'PRACTITIONER_NOT_FOUND';
  override readonly userTitle =
    'El profesional indicado no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Practitioner not found');
  }
}

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

/**
 * SP-005. A practitioner holds one or more specialties, EXACTLY ONE of them
 * primary. The base guarantees "at most one" with the partial unique index
 * `practitioner_specialty_one_primary`; "at least one" cannot be a CHECK —
 * it counts sibling rows — so the service enforces it here, on the whole
 * replacement set.
 */
export class PrimarySpecialtyRequiredError extends ValidationError {
  readonly code = 'PRIMARY_SPECIALTY_REQUIRED';
  override readonly userTitle =
    'Marque exactamente una especialidad como principal';

  constructor(primaryCount: number) {
    super(
      `Assignment must mark exactly one primary specialty, got ${primaryCount}`,
      { primaryCount },
      [
        {
          field: 'items',
          code: 'PRIMARY_SPECIALTY_REQUIRED',
          message:
            primaryCount === 0
              ? 'Ninguna especialidad está marcada como principal'
              : 'Hay más de una especialidad marcada como principal',
        },
      ],
    );
  }
}

/**
 * SP-004. A deactivated specialty is not offered for NEW assignments; the
 * ones a practitioner already holds are kept intact, which is why the service
 * only refuses identifiers that were not previously assigned.
 */
export class InactiveSpecialtyAssignmentError extends BusinessRuleViolation {
  readonly code = 'SPECIALTY_INACTIVE';
  override readonly userTitle =
    'La especialidad está desactivada y no admite nuevas asignaciones. Reactívela si debe volver a ofrecerse';

  constructor() {
    super('Deactivated specialty refused for a new assignment');
  }
}
