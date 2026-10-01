import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
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
