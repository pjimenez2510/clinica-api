import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type DomainFieldError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong when a medical certificate is issued, read or annulled, in
 * business terms.
 *
 * No HTTP here: the CATEGORY decides the status in `problem-details.filter.ts`.
 *
 * ⚠️ NOT ONE OF THESE RECEIVES A PATIENT DATUM (CER-014). No name, no document,
 * no CIE-10 code reaches a constructor, so none can reach a log line or a
 * support screenshot. They speak of FIELDS and of STATES.
 *
 * ⚠️ AND NONE REUSES A CODE OF `encounter` OR `prescription`. No module imports
 * another (CLAUDE.md §3), and `error-catalogue.spec.ts` fails when two classes
 * declare one code: a client branches on the code, so two situations answering
 * one code are two things it cannot tell apart.
 */

/**
 * CER-002. The attention does not exist, or is of a site outside the caller's
 * scope. ONE ANSWER FOR BOTH: telling them apart would confirm attentions of
 * other sites to whoever guesses identifiers.
 */
export class CertificateEncounterNotFoundError extends NotFoundError {
  readonly code = 'CERTIFICATE_ENCOUNTER_NOT_FOUND';
  override readonly userTitle =
    'No hay una atención con ese identificador en las sedes a las que usted tiene acceso. Abra la atención antes de emitir el certificado';

  constructor() {
    super('Encounter not found within the caller site scope');
  }
}

/**
 * CER-003. The attention no longer admits new clinical content —
 * `COMPLETED`, `DISCONTINUED` or `ENTERED_IN_ERROR`. 409: nothing sent is
 * wrong, the state of the act refuses it.
 */
export class CertificateEncounterNotOpenError extends ConflictError {
  readonly code = 'CERTIFICATE_ENCOUNTER_NOT_OPEN';
  override readonly userTitle =
    'Esa atención ya terminó y no admite certificados nuevos. Emítalo desde una atención abierta';

  constructor(status: string) {
    // The state only: no patient, no date reaches a log.
    super(`Encounter is ${status} and admits no new certificate`, { status });
  }
}

/**
 * CER-004. The caller has an account but no active clinical profile.
 * `medical_certificate.issued_by_id` targets `practitioner`, not `app_user`: a
 * certificate has a clinical author, and the instructivo says the 117 is
 * filled in by «profesionales médicos especialistas, generales».
 */
export class CertifierProfileRequiredError extends ForbiddenError {
  readonly code = 'CERTIFIER_PROFILE_REQUIRED';
  override readonly userTitle =
    'Su cuenta no tiene ficha profesional activa, y un certificado médico lo emite un profesional. Pida que se la creen';

  constructor() {
    super('Caller has no active practitioner profile');
  }
}

/**
 * CER-005. `FITNESS` and `DISABILITY_SUPPORT` are in the enum since the
 * clinical core, and neither is a form 117: disability is form 116 and a
 * process of the MSP. Printing them over a 117 would issue an official document
 * that does not exist.
 */
export class CertificateTypeNotSupportedError extends ValidationError {
  readonly code = 'CERTIFICATE_TYPE_NOT_SUPPORTED';
  override readonly userTitle =
    'Desde la atención sólo se emite el certificado médico de asistencia o de reposo';
  override readonly fieldErrors: readonly DomainFieldError[] = [
    {
      field: 'type',
      code: 'CERTIFICATE_TYPE_NOT_SUPPORTED',
      message: 'Elija asistencia o reposo',
    },
  ];

  constructor() {
    super('Only ATTENDANCE and MEDICAL_REST certificates are issued');
  }
}

/** CER-006, CER-007, CER-034, CER-035. What is wrong with one field of the rest. */
export type RestPeriodProblem =
  'MISSING' | 'ENDS_BEFORE_START' | 'NOT_ALLOWED' | 'MUST_BE_INCLUDED';

/**
 * CER-006, CER-007, CER-034, CER-035. The fields that describe a rest: the
 * period, the diagnosis it always carries, the contingency, and the three
 * dates of a maternity.
 */
export type RestPeriodField =
  | 'restFrom'
  | 'restTo'
  | 'includeDiagnosis'
  | 'contingencyType'
  | 'maternityAdmissionOn'
  | 'birthOn'
  | 'maternityDischargeOn';

/** What the box is called, inside a sentence. */
const FIELD_LABEL: Readonly<Record<RestPeriodField, string>> = {
  restFrom: 'la fecha de inicio del reposo',
  restTo: 'la fecha de fin del reposo',
  includeDiagnosis: 'el diagnóstico',
  contingencyType: 'el tipo de contingencia',
  maternityAdmissionOn: 'la fecha de ingreso',
  birthOn: 'la fecha del parto',
  maternityDischargeOn: 'la fecha de alta',
};

/** The sentence for one field and one problem. */
function restMessage(
  field: RestPeriodField,
  problem: RestPeriodProblem,
): string {
  switch (problem) {
    case 'MISSING':
      return field === 'contingencyType'
        ? 'Indique el tipo de contingencia del reposo'
        : `Indique ${FIELD_LABEL[field]}`;
    case 'ENDS_BEFORE_START':
      return field === 'restFrom'
        ? 'El reposo no puede empezar después de terminar'
        : 'El reposo no puede terminar antes de empezar';
    case 'MUST_BE_INCLUDED':
      return 'Un certificado de reposo lleva siempre el diagnóstico: el IESS no lo valida sin él';
    case 'NOT_ALLOWED':
      return field === 'maternityAdmissionOn' ||
        field === 'birthOn' ||
        field === 'maternityDischargeOn'
        ? 'Las fechas de ingreso, parto y alta sólo van con la contingencia de maternidad'
        : 'Un certificado de asistencia no lleva datos de reposo';
  }
}

/**
 * CER-006. The rest period is missing, inverted, or present where it does not
 * belong. Named field by field, because «las fechas no son válidas» sends the
 * doctor round the whole form. `medical_certificate_rest_range` says the same
 * a second time in the database.
 */
export class CertificateRestPeriodInvalidError extends ValidationError {
  readonly code = 'CERTIFICATE_REST_PERIOD_INVALID';
  override readonly userTitle =
    'El período de reposo no es válido. Corrija las fechas señaladas';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(
    problems: readonly { field: RestPeriodField; problem: RestPeriodProblem }[],
  ) {
    super(
      `Rest period is invalid: ${problems
        .map(({ field, problem }) => `${field} ${problem}`)
        .join(', ')}`,
    );
    this.fieldErrors = problems.map(({ field, problem }) => ({
      field,
      code: 'CERTIFICATE_REST_PERIOD_INVALID',
      message: restMessage(field, problem),
    }));
  }
}

/**
 * CER-008. The doctor asked for the diagnosis on the certificate and the
 * attention has none. The diagnosis is not typed into the certificate: it is
 * read from `encounter_diagnosis`, like the prescription's (PR-026).
 */
export class CertificateDiagnosisRequiredError extends ValidationError {
  readonly code = 'CERTIFICATE_DIAGNOSIS_REQUIRED';
  override readonly userTitle =
    'Pidió incluir el diagnóstico y la atención no tiene ninguno. Registre el diagnóstico en la atención, o emita el certificado sin él';
  override readonly fieldErrors: readonly DomainFieldError[] = [
    {
      field: 'includeDiagnosis',
      code: 'CERTIFICATE_DIAGNOSIS_REQUIRED',
      message: 'La atención no tiene diagnóstico registrado',
    },
  ];

  constructor() {
    super('Diagnosis requested on a certificate whose encounter has none');
  }
}

/**
 * CER-010. The certificate does not exist, or is of a site outside the
 * caller's scope. One answer for both, for the reason of
 * `CertificateEncounterNotFoundError`.
 */
export class CertificateNotFoundError extends NotFoundError {
  readonly code = 'CERTIFICATE_NOT_FOUND';
  override readonly userTitle =
    'Ese certificado no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Certificate not found within the caller site scope');
  }
}

/**
 * CER-012. Annulling twice would rewrite who annulled it and why, which is
 * the register CER-011 exists to keep. 409: a colleague got there first.
 */
export class CertificateAlreadyRevokedError extends ConflictError {
  readonly code = 'CERTIFICATE_ALREADY_REVOKED';
  override readonly userTitle =
    'Ese certificado ya está anulado. Actualice la pantalla para ver quién lo anuló y por qué';

  constructor() {
    super('Certificate is already revoked');
  }
}

/**
 * CER-030. The rest starts before the clinical date of the attention and no
 * written reason of at least ten characters says why. A backdated certificate
 * is the typical shape of a certificate of favour: it is admitted only with
 * the reason written, and the reason stays in the record.
 */
export class CertificateBackdatingReasonRequiredError extends ValidationError {
  readonly code = 'CERTIFICATE_BACKDATING_REASON_REQUIRED';
  override readonly userTitle =
    'El reposo empieza antes del día de la atención. Escriba por qué, en al menos diez caracteres';
  override readonly fieldErrors: readonly DomainFieldError[] = [
    {
      field: 'backdatingReason',
      code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
      message:
        'Explique por qué el reposo empieza antes del día de la atención',
    },
  ];

  constructor() {
    super('A backdated rest needs a written reason');
  }
}

/**
 * CER-031. More than thirty days, both ends included: the IESS validates
 * rests of one to thirty days, and a longer one is covered by successive
 * certificates.
 */
export class CertificateRestTooLongError extends ValidationError {
  readonly code = 'CERTIFICATE_REST_TOO_LONG';
  override readonly userTitle =
    'Un certificado de reposo cubre como máximo 30 días. Para un reposo más largo, emita certificados sucesivos';
  override readonly fieldErrors: readonly DomainFieldError[] = [
    {
      field: 'restTo',
      code: 'CERTIFICATE_REST_TOO_LONG',
      message: 'El reposo no puede pasar de 30 días',
    },
  ];

  constructor() {
    super('A rest certificate covers at most 30 days');
  }
}

/**
 * CER-036. The site has no parish, so there is no city to print as the place
 * of issue. 422 and not 500: a datum of the installation is missing, and the
 * sentence says who fixes it and where.
 */
export class CertificateEstablishmentIncompleteError extends ValidationError {
  readonly code = 'CERTIFICATE_ESTABLISHMENT_INCOMPLETE';
  override readonly userTitle =
    'La sede no tiene parroquia configurada, así que el certificado no puede indicar el lugar de emisión. Complete los datos de la sede en configuración';

  constructor() {
    super('Site has no parish, so the place of issue cannot be resolved');
  }
}
