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

/** PD-044. The consent to correct does not exist, or is not this chart's. */
export class ConsentNotFoundError extends NotFoundError {
  readonly code = 'CONSENT_NOT_FOUND';
  override readonly userTitle =
    'No se encontró ese consentimiento en la ficha. Actualice la lista';

  constructor() {
    super('Patient consent not found');
  }
}

/**
 * PD-044. The consent was already corrected: what stands is the correction,
 * and that is the one to correct. The original is never rewritten.
 */
export class ConsentAlreadyCorrectedError extends ConflictError {
  readonly code = 'CONSENT_ALREADY_CORRECTED';
  override readonly userTitle =
    'Ese consentimiento ya se corrigió. Actualice la lista y corrija el vigente';

  constructor() {
    super('Patient consent already superseded by a correction');
  }
}

/** PD-047. There is no answer to rectify yet: the request is answered first. */
export class DataRequestNotAnsweredError extends ConflictError {
  readonly code = 'DATA_REQUEST_NOT_ANSWERED';
  override readonly userTitle =
    'Esta solicitud todavía no tiene respuesta: respóndala en lugar de corregirla';

  constructor() {
    super('Data subject request has no answer to rectify');
  }
}

/**
 * PD-052. A third party (A.M. 5216 art. 28) asks for the copy of the clinical
 * record; the rights of the LOPDP are the holder's, or their representative's.
 */
export class DataRequestPartyNotAllowedError extends ValidationError {
  readonly code = 'DATA_REQUEST_PARTY_NOT_ALLOWED';
  override readonly userTitle =
    'Un apoderado, una persona autorizada, una autoridad o un familiar sólo pueden pedir la copia de la historia clínica';

  constructor() {
    super('A third party only asks for the copy of the clinical record', {}, [
      {
        field: 'requestedBy',
        code: 'DATA_REQUEST_PARTY_NOT_ALLOWED',
        message: 'Sólo puede pedir la copia de la historia clínica',
      },
    ]);
  }
}

/** PD-052. The relative asks for the copy of a deceased patient's record. */
export class DataRequestPatientNotDeceasedError extends ValidationError {
  readonly code = 'DATA_REQUEST_PATIENT_NOT_DECEASED';
  override readonly userTitle =
    'La ficha no registra el fallecimiento: un familiar sólo pide la copia de un paciente fallecido';

  constructor() {
    super('The relative of a living patient asks for the copy', {}, [
      {
        field: 'requestedBy',
        code: 'DATA_REQUEST_PATIENT_NOT_DECEASED',
        message: 'La ficha no registra el fallecimiento del paciente',
      },
    ]);
  }
}

/** The fields of a copy request that `ClinicalRecordCopyInvalidError` names. */
export type ClinicalRecordCopyField =
  | 'clinicalRecordCopy'
  | 'documentsChecked'
  | 'requesterName'
  | 'requesterDocument';

const COPY_FIELD_MESSAGE: Readonly<Record<ClinicalRecordCopyField, string>> = {
  clinicalRecordCopy: 'La copia de la historia clínica se pide como acceso',
  documentsChecked:
    'Marque que recibió la solicitud firmada y la copia de la cédula',
  requesterName:
    'Escriba el nombre de quien la presenta (hasta 200 caracteres)',
  requesterDocument:
    'Escriba la cédula u oficio de quien la presenta (hasta 200 caracteres)',
};

/**
 * PD-052, PD-053. A request for the copy of the clinical record that the
 * A.M. 5216 would not admit: not an access request, without the signed
 * request and the cedula at hand, or without who presents it.
 */
export class ClinicalRecordCopyInvalidError extends ValidationError {
  readonly code = 'CLINICAL_RECORD_COPY_INVALID';
  override readonly userTitle: string;

  constructor(readonly field: ClinicalRecordCopyField) {
    super(`Invalid request for the copy of the clinical record: ${field}`, {}, [
      {
        field,
        code: 'CLINICAL_RECORD_COPY_INVALID',
        message: COPY_FIELD_MESSAGE[field],
      },
    ]);
    this.userTitle = COPY_FIELD_MESSAGE[field];
  }
}
