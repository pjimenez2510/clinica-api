import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong administering the clinical profile of the staff, in
 * business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`
 * (NotFoundError is 404, ConflictError 409, ValidationError and
 * BusinessRuleViolation 422). The codes are fixed by the SPEC's error table.
 *
 * THREE OF THESE ARRIVED FROM `specialties` ON 13-08-2026, when this module
 * settled the debt that SPEC declared: `PRACTITIONER_NOT_FOUND`,
 * `PRIMARY_SPECIALTY_REQUIRED` and `SPECIALTY_INACTIVE` are the same strings
 * they always were. A `code` is a public contract; changing the emitter must
 * not change what a client branches on.
 *
 * `SCHEDULE_RULE_OVERLAP` IS NOT HERE, and that is the point of ST-042: the
 * guarantee lives in the base as `schedule_rule_no_overlap`, and its meaning
 * is registered in `staff.constraints.ts` like every other constraint-borne
 * code. A class here would suggest the service can decide it, and it cannot —
 * two administrators editing the same schedule both read "no overlap".
 */

/**
 * The practitioner does not exist. A 404 and not a foreign-key 422: the
 * identifier names the resource in the URL, so a wrong one is a missing
 * resource, not bad data.
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
 * ST-010. A practitioner with appointments, encounters or signed documents is
 * NOT deleted — the offer to deactivate instead is the other half of the
 * requirement and travels in the sentence the user reads. The guarantee is the
 * FK `ON DELETE RESTRICT` towards `practitioner`, so this is raised from the
 * adapter when PostgreSQL says no.
 */
export class PractitionerInUseError extends ConflictError {
  readonly code = 'PRACTITIONER_IN_USE';
  override readonly userTitle =
    'El profesional tiene historial y no puede borrarse. Desactívelo para que deje de ofrecerse sin perder lo ya registrado';

  constructor() {
    super('Practitioner has history and cannot be deleted');
  }
}

/**
 * ST-004. The ACESS registration expired before the clinical date, so nothing
 * may be signed with it — notes, prescriptions, certificates (REQ-041).
 *
 * D-009, RESOLVED: this blocks SIGNING and never BOOKING. The expiry date
 * travels in the message because the requirement says to name it, and because
 * "renew it" without a date is advice nobody can act on. It is not personal
 * health data and it is the professional's own; it is safe to say out loud.
 */
export class AcessExpiredError extends BusinessRuleViolation {
  readonly code = 'ACESS_EXPIRED';
  override readonly userTitle: string;

  constructor(expiredOn: string) {
    super('ACESS registration expired', { expiredOn }, [
      {
        field: 'acessExpiresOn',
        code: 'ACESS_EXPIRED',
        message: `El registro ACESS caducó el ${expiredOn}`,
      },
    ]);
    this.userTitle = `El registro ACESS del profesional caducó el ${expiredOn}. Renuévelo antes de firmar`;
  }
}

/**
 * ST-002. There is no ACESS registration, or no expiry date for it, so the
 * practitioner is not qualified to sign either.
 *
 * A DIFFERENT CODE FROM `ACESS_EXPIRED` ON PURPOSE: the two demand opposite
 * actions — type the registration in versus renew it at the ACESS — and one
 * code for both would force the client to read Spanish prose to tell which.
 */
export class AcessMissingError extends BusinessRuleViolation {
  readonly code = 'ACESS_MISSING';
  override readonly userTitle =
    'El profesional no tiene registro ACESS con fecha de caducidad. Regístrelo antes de firmar';

  constructor() {
    super('ACESS registration or expiry date missing');
  }
}

/**
 * ST-007. A schedule rule — or a booking — in a site where the practitioner
 * does not attend. 422 and not 403: the data sent is incoherent, and answering
 * "access denied" would say something about the site to somebody who is not
 * being denied anything.
 */
export class PractitionerNotInSiteError extends ValidationError {
  readonly code = 'PRACTITIONER_NOT_IN_SITE';
  override readonly userTitle =
    'El profesional no atiende en esa sede. Asígnele la sede antes de darle horario allí';

  constructor() {
    super('Practitioner does not attend at that site', {}, [
      {
        field: 'siteId',
        code: 'PRACTITIONER_NOT_IN_SITE',
        message: 'El profesional no tiene asignada esa sede',
      },
    ]);
  }
}

/**
 * ST-006. A practitioner marked as not schedulable takes no appointments, so
 * a NEW schedule rule for them would describe availability that must never be
 * offered. The existing rules are left alone: a pathologist who stops taking
 * appointments keeps whatever history explains last month's agenda.
 */
export class PractitionerNotSchedulableError extends BusinessRuleViolation {
  readonly code = 'PRACTITIONER_NOT_SCHEDULABLE';
  override readonly userTitle =
    'El profesional no toma citas. Márquelo como agendable antes de darle horario';

  constructor() {
    super('Practitioner is not schedulable');
  }
}

/**
 * ST-045, ST-041. The rule as proposed cannot be turned into slots: the hours
 * are inverted, the turn does not fit in the span, the weekday is not a
 * weekday, or the validity is empty.
 *
 * EVERY ONE OF THESE IS ALSO A `CHECK` IN THE BASE, which is where the
 * guarantee lives. This class exists so the answer names the FIELD instead of
 * the constraint: «violates check constraint schedule_rule_slot_fits» is true
 * and useless to the person filling in the form.
 */
export class InvalidScheduleRuleError extends ValidationError {
  readonly code = 'INVALID_SCHEDULE_RULE';
  override readonly userTitle = 'Revise el horario: hay datos que no encajan';

  constructor(problems: readonly { field: string; message: string }[]) {
    super(
      `Schedule rule is not derivable into slots: ${problems.map((problem) => problem.field).join(', ')}`,
      {},
      problems.map((problem) => ({
        field: problem.field,
        code: 'INVALID_SCHEDULE_RULE',
        message: problem.message,
      })),
    );
  }
}

/** The schedule rule does not exist. */
export class ScheduleRuleNotFoundError extends NotFoundError {
  readonly code = 'SCHEDULE_RULE_NOT_FOUND';
  override readonly userTitle =
    'La regla de horario indicada no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Schedule rule not found');
  }
}

/**
 * ST-008. A practitioner holds one or more specialties, EXACTLY ONE of them
 * primary. The base guarantees "at most one" with the partial unique index
 * `practitioner_specialty_one_primary`; "at least one" cannot be a CHECK — it
 * counts sibling rows — so the service enforces it on the whole replacement
 * set.
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
 * SP-004, enforced here since ST-008 absorbed the assignment. A deactivated
 * specialty is not offered for NEW assignments; the ones a practitioner
 * already holds are kept intact, which is why the service only refuses
 * identifiers that were not previously assigned — deactivation must not
 * amputate existing references.
 */
export class InactiveSpecialtyAssignmentError extends BusinessRuleViolation {
  readonly code = 'SPECIALTY_INACTIVE';
  override readonly userTitle =
    'La especialidad está desactivada y no admite nuevas asignaciones. Reactívela si debe volver a ofrecerse';

  constructor() {
    super('Deactivated specialty refused for a new assignment');
  }
}
