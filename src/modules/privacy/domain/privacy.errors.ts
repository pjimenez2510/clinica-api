import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * PD-015, PD-030. The chart does not exist.
 *
 * Its own code and not `PATIENT_NOT_FOUND`: that one belongs to `patients`, a
 * code is declared by one class only, and no module imports another. The
 * message is the same, and so is the reason it does not distinguish «no
 * existe» from «no puede verla».
 */
export class DataSubjectNotFoundError extends NotFoundError {
  readonly code = 'DATA_SUBJECT_NOT_FOUND';
  override readonly userTitle =
    'No se encontró el paciente indicado. Búsquelo de nuevo';

  constructor() {
    super('Data subject (patient) not found');
  }
}

/** PD-004. */
export class ConsentTextInvalidError extends ValidationError {
  readonly code = 'CONSENT_TEXT_INVALID';
  override readonly userTitle =
    'Escriba el texto del consentimiento (hasta 20 000 caracteres)';

  constructor() {
    super('Consent text is blank or too long', {}, [
      {
        field: 'body',
        code: 'CONSENT_TEXT_INVALID',
        message:
          'Escriba el texto del consentimiento (hasta 20 000 caracteres)',
      },
    ]);
  }
}

/** PD-005. Somebody else published the same number first. */
export class ConsentTextVersionConflictError extends ConflictError {
  readonly code = 'CONSENT_TEXT_VERSION_CONFLICT';
  override readonly userTitle =
    'Otra persona publicó una versión del texto al mismo tiempo. Revise la vigente antes de publicar';

  constructor() {
    super('Concurrent consent text publication');
  }
}

/** There is no current text yet, or the version sent does not exist. */
export class ConsentTextNotPublishedError extends NotFoundError {
  readonly code = 'CONSENT_TEXT_NOT_PUBLISHED';
  override readonly userTitle =
    'Todavía no hay un texto de consentimiento publicado. Pida a administración que lo publique';

  constructor() {
    super('No consent text version published');
  }
}

/**
 * PD-012. The version the patient was shown is no longer the current one: what
 * is recorded must be what was shown, so the screen has to show the new one.
 */
export class ConsentTextOutdatedError extends ConflictError {
  readonly code = 'CONSENT_TEXT_OUTDATED';
  override readonly userTitle =
    'Se publicó una versión nueva del texto de consentimiento. Muéstresela al paciente y regístrelo de nuevo';

  constructor(readonly currentVersion: number) {
    super('Consent text version is not the current one', {
      currentVersion,
    });
  }
}

export class DataRequestNotFoundError extends NotFoundError {
  readonly code = 'DATA_REQUEST_NOT_FOUND';
  override readonly userTitle = 'La solicitud indicada no existe';

  constructor() {
    super('Data subject request not found');
  }
}

/** PD-031. */
export class DataRequestReceivedInFutureError extends ValidationError {
  readonly code = 'DATA_REQUEST_RECEIVED_IN_FUTURE';
  override readonly userTitle =
    'La fecha de recepción no puede ser posterior a este momento';

  constructor() {
    super('Data subject request received in the future', {}, [
      {
        field: 'receivedAt',
        code: 'DATA_REQUEST_RECEIVED_IN_FUTURE',
        message: 'La fecha de recepción no puede ser posterior a este momento',
      },
    ]);
  }
}

/** PD-033. An answer is given once. */
export class DataRequestAlreadyAnsweredError extends ConflictError {
  readonly code = 'DATA_REQUEST_ALREADY_ANSWERED';
  override readonly userTitle =
    'Esta solicitud ya tiene respuesta y no se puede cambiar';

  constructor() {
    super('Data subject request already answered');
  }
}

/** PD-042. Only access and portability are answered with the data itself. */
export class DataExportNotApplicableError extends ValidationError {
  readonly code = 'DATA_EXPORT_NOT_APPLICABLE';
  override readonly userTitle =
    'Solo se exportan los datos para una solicitud de acceso o de portabilidad';

  constructor() {
    super('Export requested for a right other than access or portability');
  }
}
