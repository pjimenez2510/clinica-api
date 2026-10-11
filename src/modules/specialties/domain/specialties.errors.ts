import { ConflictError } from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong when administering the clinic's parametrisation, in
 * business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`
 * (NotFoundError is 404, ConflictError 409, ValidationError and
 * BusinessRuleViolation 422). The codes for duplicates and "in use" are fixed
 * by the SPEC's error table (SP-003, SP-006); the guarantees
 * behind them are PostgreSQL's — functional unique indexes and FK RESTRICT —
 * and the infrastructure adapter translates the constraint that fired into
 * one of these classes, which is why they are defined HERE and only thrown
 * THERE (the constitution's rule: infrastructure throws domain errors, it
 * does not define them).
 *
 * WHAT LEFT ON 11-10-2026 (ADR-013): `SERVICE_TYPE_DUPLICATE`,
 * `SERVICE_TYPE_IN_USE` and `CONSULTATION_BILLING_UNAVAILABLE`, with the
 * `service_type` table. A consultation is a `service` now, administered in
 * «Servicios» (`billing`), which answers its duplicates (BI-278) and its
 * «in use» (BI-288).
 *
 * WHAT LEFT THIS FILE ON 13-08-2026, when `staff` settled the declared debt:
 *   - `SPECIALTY_NOT_FOUND` moved to
 *     `shared/domain/errors/master-data.errors.ts`. Both modules must answer
 *     it and no module may import another.
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
 * (`specialty_code_unique`, `specialty_name_unique`), and which one fired is
 * what the constructor receives.
 *
 * BOTH POINT AT `name`, SINCE SP-009. There is no code box in the form any
 * more: the code is derived from the name, so a field error aimed at `code`
 * would highlight nothing and «Ese código ya existe» would be an answer about
 * something the person never saw (ADR-005 §5). What changes with the index is
 * the SENTENCE, because the two situations are genuinely different: the name
 * index means the same name, and the code index means a DIFFERENT name that
 * derives to the same identifier — saying "that name already exists" there
 * would be false, and the user would retype the same thing.
 */
export class SpecialtyDuplicateError extends ConflictError {
  readonly code = 'SPECIALTY_DUPLICATE';
  override readonly userTitle: string;

  constructor(collision: 'code' | 'name') {
    // No rejected value in the message: it reaches logs and screenshots, and
    // the person who typed it is looking at it already.
    super(
      `Specialty ${collision} already exists (case/accent-insensitive)`,
      {},
      [
        {
          field: 'name',
          code: 'SPECIALTY_DUPLICATE',
          message:
            collision === 'name'
              ? 'Ese nombre ya pertenece a otra especialidad (la comparación ignora mayúsculas y acentos)'
              : 'Ese nombre se confunde con el de otra especialidad ya registrada. Escriba un nombre que empiece de otra manera',
        },
      ],
    );

    this.userTitle =
      collision === 'name'
        ? 'Ya existe una especialidad con ese nombre. Revise el catálogo antes de crear otra'
        : 'Ya existe una especialidad que el sistema no podría distinguir de ésta. Revise el catálogo y elija un nombre distinto';
  }
}

/**
 * SP-003. Deleting a specialty referenced by a practitioner, a consultation
 * service or a note template is refused; the offer to deactivate instead is the other
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
