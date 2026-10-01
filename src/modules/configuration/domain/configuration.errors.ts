import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type DomainFieldError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong administering holidays and the operating parameters of a
 * site, in business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`
 * (NotFoundError is 404, ConflictError 409, ValidationError 422). The codes of
 * `HOLIDAY_DUPLICATE` and `PARAM_OUT_OF_RANGE` are fixed by the SPEC's error
 * table; the other two are this delivery's, and they are in the SPEC's table
 * too — a code that reaches a client and is not written down is not a
 * contract.
 *
 * THE DUPLICATE IS THROWN FROM THE ADAPTER AND DEFINED HERE. Its guarantee is
 * `holiday_date_scope_unique`, a `UNIQUE NULLS NOT DISTINCT` index, so only
 * PostgreSQL can arbitrate it; the constitution's rule is that infrastructure
 * throws domain errors and does not define them.
 *
 * WHAT IS DELIBERATELY NOT HERE: a `SITE_NOT_FOUND`. That code already belongs
 * to `organization`, which owns the site, and two classes answering the same
 * code is two situations a client cannot tell apart — the error catalogue's
 * own test refuses it. What this module can honestly say is that the site has
 * no parameter row, which is `SITE_PARAMETERS_NOT_FOUND`.
 */

/**
 * CF-061. Two holidays on the same date with the same scope. The scope is
 * part of the identity: «1 de enero» for all sites and «1 de enero» for the
 * Quito site are different rows, and neither may exist twice.
 */
export class HolidayDuplicateError extends ConflictError {
  readonly code = 'HOLIDAY_DUPLICATE';
  override readonly userTitle =
    'Ya existe un feriado en esa fecha con ese mismo alcance. Revise la lista del año antes de crear otro';

  constructor() {
    // No date in the message: it reaches logs and screenshots, and the client
    // already knows which date it sent.
    super('A holiday already exists for that date and scope', {}, [
      {
        field: 'date',
        code: 'HOLIDAY_DUPLICATE',
        message: 'Ya hay un feriado registrado en esa fecha con ese alcance',
      },
    ]);
  }
}

/** The holiday does not exist. Never says whether it once did. */
export class HolidayNotFoundError extends NotFoundError {
  readonly code = 'HOLIDAY_NOT_FOUND';
  override readonly userTitle =
    'El feriado indicado no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Holiday not found');
  }
}

/**
 * The site has no parameter row.
 *
 * In practice this means the site does not exist: `trg_site_parameter_defaults`
 * writes the row of D-001 the moment a site is inserted, whoever inserts it
 * (CF-062). Saying «no tiene parámetros» rather than «no existe la sede» is
 * also the honest answer — this module does not own the site and cannot
 * responsibly claim it is absent.
 */
export class SiteParametersNotFoundError extends NotFoundError {
  readonly code = 'SITE_PARAMETERS_NOT_FOUND';
  override readonly userTitle =
    'La sede indicada no tiene parámetros de operación. Compruebe que la sede existe y actualice la lista';

  constructor() {
    super('No parameter row for that site');
  }
}

/**
 * CF-065. A parameter arrived outside its declared range.
 *
 * IT NAMES THE RANGE, which is the requirement and not a nicety: «fuera de
 * rango» sends whoever is configuring the clinic to read the source code, and
 * the range is the one thing that tells them what to type instead.
 *
 * 422 and not 400: the value is a well-formed integer that the clinic's rules
 * refuse, which is a different fix from a malformed body.
 */
export class ParameterOutOfRangeError extends ValidationError {
  readonly code = 'PARAM_OUT_OF_RANGE';
  override readonly userTitle =
    'Alguno de los parámetros está fuera del rango permitido. Corríjalo y guarde de nuevo';

  constructor(fieldErrors: readonly DomainFieldError[]) {
    super('One or more parameters are out of range', {}, fieldErrors);
  }
}

/**
 * ORD-046, ORD-065 (revisión clínica de F-07). The role named to answer for a
 * results worklist cannot work it: it lacks `record:read` to see the queue or
 * `result:write` to record the notice or pair the value.
 *
 * A queue whose owner cannot open it has no owner — «una cola que es de todos
 * no es de nadie», and one that is of somebody who cannot see it is worse,
 * because it looks owned.
 */
export class RoleCannotWorkResultsError extends ValidationError {
  readonly code = 'ROLE_CANNOT_WORK_RESULTS';
  override readonly userTitle =
    'Ese rol no puede trabajar las colas de resultados: necesita ver la historia clínica y registrar resultados. Elija otro o concédale esos permisos';

  constructor(field: string, missing: readonly string[]) {
    super(
      `Role lacks ${missing.join(', ')} to work the results worklists`,
      {},
      [
        {
          field,
          code: 'ROLE_CANNOT_WORK_RESULTS',
          message:
            'Elija un rol que vea la historia clínica y registre resultados',
        },
      ],
    );
  }
}
