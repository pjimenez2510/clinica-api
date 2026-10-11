import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * PD-030, PD-075. The chart does not exist.
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
export class PrivacyNoticeInvalidError extends ValidationError {
  readonly code = 'PRIVACY_NOTICE_INVALID';
  override readonly userTitle =
    'Escriba el aviso de privacidad (hasta 20 000 caracteres)';

  constructor() {
    super('Privacy notice is blank or too long', {}, [
      {
        field: 'body',
        code: 'PRIVACY_NOTICE_INVALID',
        message: 'Escriba el aviso de privacidad (hasta 20 000 caracteres)',
      },
    ]);
  }
}

/** PD-005. Somebody else published the same number first. */
export class PrivacyNoticeVersionConflictError extends ConflictError {
  readonly code = 'PRIVACY_NOTICE_VERSION_CONFLICT';
  override readonly userTitle =
    'Otra persona publicó una versión del aviso al mismo tiempo. Revise la vigente antes de publicar';

  constructor() {
    super('Concurrent privacy notice publication');
  }
}

/**
 * PD-070. The purpose and the channel do not go together, or the chart lacks
 * the phone or the email the authorization would write to.
 */
export class PrivacyAuthorizationInvalidError extends ValidationError {
  readonly code = 'PRIVACY_AUTHORIZATION_INVALID';
  override readonly userTitle =
    'Esa autorización no se puede registrar: los recordatorios y la publicidad van por WhatsApp o por correo, y la ficha necesita ese teléfono o ese correo';

  constructor() {
    super('Authorization purpose, channel or contact do not match');
  }
}

/** PD-071. One standing per chart, purpose and channel. */
export class PrivacyAuthorizationAlreadyGrantedError extends ConflictError {
  readonly code = 'PRIVACY_AUTHORIZATION_ALREADY_GRANTED';
  override readonly userTitle =
    'El paciente ya tiene esa autorización vigente. Actualice la ficha';

  constructor() {
    super('Authorization already standing');
  }
}

/** PD-072. The authorization does not exist, or is not this chart's. */
export class PrivacyAuthorizationNotFoundError extends NotFoundError {
  readonly code = 'PRIVACY_AUTHORIZATION_NOT_FOUND';
  override readonly userTitle =
    'No se encontró esa autorización en la ficha. Actualice la ficha';

  constructor() {
    super('Patient authorization not found');
  }
}

/** PD-072. A revocation is recorded once. */
export class PrivacyAuthorizationAlreadyRevokedError extends ConflictError {
  readonly code = 'PRIVACY_AUTHORIZATION_ALREADY_REVOKED';
  override readonly userTitle =
    'Esa autorización ya estaba revocada. Actualice la ficha';

  constructor() {
    super('Patient authorization already revoked');
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
  | 'requesterDocument'
  | 'requesterRelationship'
  | 'copyPeriod'
  | 'reviewed';

const COPY_FIELD_MESSAGE: Readonly<Record<ClinicalRecordCopyField, string>> = {
  clinicalRecordCopy: 'La copia de la historia clínica se pide como acceso',
  documentsChecked:
    'Marque que recibió la solicitud firmada y la copia de la cédula',
  requesterName:
    'Escriba el nombre de quien la presenta (hasta 200 caracteres)',
  requesterDocument:
    'Escriba la cédula u oficio de quien la presenta (hasta 200 caracteres)',
  requesterRelationship:
    'Elija el parentesco del familiar con el paciente fallecido',
  copyPeriod:
    '«Atendida en parte» entrega un periodo: elija desde y hasta, sin pasar de hoy',
  reviewed: 'Marque que revisó la historia antes de dar el visto bueno',
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

/**
 * PD-065 (D-203 §8). The holder of a chart that records the death does not
 * present requests: the relative or the last legal representative do.
 */
export class DataRequestPatientDeceasedError extends ValidationError {
  readonly code = 'DATA_REQUEST_PATIENT_DECEASED';
  override readonly userTitle =
    'La ficha registra el fallecimiento: la solicitud la presenta un familiar o quien fue su representante legal';

  constructor() {
    super('The holder of a deceased chart presents a request', {}, [
      {
        field: 'requestedBy',
        code: 'DATA_REQUEST_PATIENT_DECEASED',
        message: 'El paciente falleció: elija quién la presenta',
      },
    ]);
  }
}

/**
 * PD-062 (D-203 §5). The copy for somebody other than the holder needs a
 * professional's review first. The title does NOT say why: whoever reads it
 * may not hold `record:protected`, and the reason is in the record.
 */
export class ClinicalRecordCopyReviewRequiredError extends ConflictError {
  readonly code = 'CLINICAL_RECORD_COPY_REVIEW_REQUIRED';
  override readonly userTitle =
    'Esta copia necesita el visto bueno de un profesional antes de autorizarla: pídaselo desde la ficha del paciente';

  constructor() {
    super('The copy needs the review of a professional before it is granted');
  }
}

/** PD-061. A copy is reviewed once. */
export class ClinicalRecordCopyAlreadyReviewedError extends ConflictError {
  readonly code = 'CLINICAL_RECORD_COPY_ALREADY_REVIEWED';
  override readonly userTitle = 'Esta copia ya tiene el visto bueno';

  constructor() {
    super('The copy already has its review');
  }
}
