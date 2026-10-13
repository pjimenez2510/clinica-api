import {
  BusinessRuleViolation,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong between an issued invoice and the SRI, in business terms.
 *
 * ⚠️ NO MESSAGE CARRIES A CERTIFICATE, A PASSWORD, A KEY OR A BUYER (SRI-030,
 * SRI-067). These objects reach logs; a .p12 password in an error is the
 * signature of the clinic in a log file.
 */

/** SRI-065. Absent, or of a site outside the caller's scope: one answer. */
export class ElectronicVoucherNotFoundError extends NotFoundError {
  readonly code = 'SRI_VOUCHER_NOT_FOUND';
  override readonly userTitle = 'Ese comprobante electrónico no existe';

  constructor() {
    super('No electronic voucher with that identifier in scope');
  }
}

/** SRI-058. Only what the SRI returned or refused is retried by a person. */
export class ElectronicVoucherNotRetriableError extends ConflictError {
  readonly code = 'SRI_VOUCHER_NOT_RETRIABLE';
  override readonly userTitle =
    'Ese comprobante no está devuelto ni rechazado: la cola lo está atendiendo';

  constructor() {
    super('Only RETURNED or NOT_AUTHORISED vouchers are retried');
  }
}

/**
 * SRI-110. Only a voucher returned ONLY with the 45 and never authorised gets
 * another number: anything else is corrected, re-sent or credited as before.
 */
export class ElectronicVoucherNotRenumberableError extends ConflictError {
  readonly code = 'SRI_VOUCHER_NOT_RENUMBERABLE';
  override readonly userTitle =
    'Ese comprobante no se renumera: sólo el que el SRI devolvió con «secuencial registrado» y nunca autorizó';

  constructor() {
    super(
      'Only a voucher returned only with error 45 and never authorised is renumbered',
    );
  }
}

/** SRI-116. The SRI turned out to have authorised the returned key. */
export class ElectronicVoucherAuthorisedAfterAllError extends ConflictError {
  readonly code = 'SRI_VOUCHER_AUTHORISED_AFTER_ALL';
  override readonly userTitle =
    'El SRI sí había autorizado este comprobante: queda autorizado con su número y no se renumera';

  constructor() {
    super('The SRI authorised the returned key; it is not renumbered');
  }
}

/** SRI-116. The SRI could not be asked about the returned key. */
export class ElectronicVoucherRenumberUncheckedError extends ExternalServiceError {
  readonly code = 'SRI_RENUMBER_UNCHECKED';
  readonly service = 'sri';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo confirmar con el SRI que este comprobante no esté autorizado. Inténtelo en unos minutos';
  override readonly retryAfterSeconds = 60;

  constructor() {
    super('The SRI could not confirm the returned key is not authorised');
  }
}

/** SRI-096. Only what the SRI authorised is e-mailed: there is no RIDE to send. */
export class ElectronicVoucherNotAuthorisedError extends ConflictError {
  readonly code = 'SRI_VOUCHER_NOT_AUTHORISED';
  override readonly userTitle =
    'Ese comprobante todavía no está autorizado por el SRI: no se puede reenviar por correo';

  constructor() {
    super('Only AUTHORISED vouchers are e-mailed again');
  }
}

/**
 * SRI-096. The relay did not take the copy. Asked for with somebody in front
 * of the desk, so it is said at once and NOT queued: a retry hours later would
 * write to an address that may have been mistyped. Carries no address.
 */
export class VoucherResendFailedError extends ExternalServiceError {
  readonly code = 'SRI_RESEND_FAILED';
  readonly service = 'smtp';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo enviar el correo. Revise la dirección o inténtelo de nuevo en un momento';

  constructor(cause?: unknown) {
    super('The voucher copy could not be e-mailed');
    this.cause = cause;
  }
}

/**
 * SRI-099 (D-167 §2). Who does not issue in the site only re-sends an e-mail
 * that did not go; the copies to other addresses are caja's.
 */
export class VoucherDeliveryNotFailedError extends ConflictError {
  readonly code = 'SRI_RESEND_DELIVERY_NOT_FAILED';
  override readonly userTitle =
    'Ese comprobante ya se envió por correo: sólo caja lo reenvía a otra dirección';

  constructor() {
    super('Only a failed delivery is re-sent without billing:write');
  }
}

/**
 * SRI-101. The person already e-mailed today the copies a day allows. Says
 * the number, so the cashier knows it is a rule and not a fault.
 */
export class VoucherResendDailyLimitError extends QuotaExceededError {
  readonly code = 'SRI_RESEND_DAILY_LIMIT';
  override readonly userTitle: string;

  constructor(limit: number) {
    super('The daily limit of voucher copies was reached');
    this.userTitle = `Ya reenvió hoy ${limit} comprobantes, el máximo diario por persona. Mañana podrá volver a hacerlo`;
  }
}

/**
 * SRI-081. Not a PKCS#12 with an RSA key, or the password does not open it —
 * deliberately ONE error: telling the two apart is an oracle for whoever is
 * guessing the password of a stolen file.
 */
export class SigningCertificateInvalidError extends ValidationError {
  readonly code = 'SRI_CERTIFICATE_INVALID';
  override readonly userTitle =
    'El archivo no es un certificado .p12 válido o la clave no corresponde';

  constructor() {
    super('The file is not a usable PKCS#12 with that password');
  }
}

/** SRI-033. Expired, or not yet valid. */
export class SigningCertificateExpiredError extends BusinessRuleViolation {
  readonly code = 'SRI_CERTIFICATE_EXPIRED';
  override readonly userTitle =
    'El certificado no está vigente: revise sus fechas de validez';

  constructor() {
    super('The certificate is outside its validity period');
  }
}

/** SRI-083. Checked BEFORE the file is opened. */
export class SigningCertificateTooLargeError extends ValidationError {
  readonly code = 'SRI_CERTIFICATE_TOO_LARGE';
  override readonly userTitle =
    'El archivo es demasiado grande para ser un certificado .p12';

  constructor() {
    super('The certificate file exceeds the size limit');
  }
}

/**
 * SRI-024. There is no master passphrase file, so nothing can be encrypted or
 * decrypted. A datum of the installation, not a fault of whoever uploads.
 */
export class SigningCertificateStoreNotConfiguredError extends BusinessRuleViolation {
  readonly code = 'SRI_CERTIFICATE_STORE_NOT_CONFIGURED';
  override readonly userTitle =
    'La instalación no tiene configurada la custodia del certificado de firma';

  constructor() {
    super('SRI_CERTIFICATE_MASTER_KEY_FILE is not configured or unreadable');
  }
}
