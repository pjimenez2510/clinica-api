/**
 * SRI-020 to SRI-034. The ports through which the issuer's certificate is
 * opened, inspected and used. The domain knows that a .p12 exists and what
 * may be said about it; it never knows how it is encrypted or how XAdES works.
 */

/** What anybody may know about a certificate (SRI-022): never its content. */
export interface CertificateDescription {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
}

/**
 * Opens a PKCS#12 to describe it. Throws `SigningCertificateInvalidError` when
 * the file is not a PKCS#12 with an RSA private key and its certificate, or
 * the password does not open it (SRI-081).
 */
export interface Pkcs12Inspector {
  inspect(pkcs12: Buffer, password: string): CertificateDescription;
}
export const PKCS12_INSPECTOR = Symbol('Pkcs12Inspector');

/**
 * SRI-020, SRI-021. XAdES-BES, enveloped, SHA-1 and RSA-SHA1 — the SRI's
 * requirement, not a preference: SHA-256 is rejected with error 39.
 *
 * Throws `SigningCertificateInvalidError` if the .p12 cannot be opened.
 */
export interface XadesSigner {
  sign(xml: string, pkcs12: Buffer, password: string): string;
}
export const XADES_SIGNER = Symbol('XadesSigner');

/**
 * SRI-023 to SRI-025. Encrypts and decrypts with a key derived from the master
 * passphrase and a per-certificate salt. Throws
 * `SigningCertificateStoreNotConfiguredError` when there is no passphrase.
 */
export interface CertificateCipher {
  newSalt(): Buffer;
  seal(plain: Buffer, salt: Buffer): Promise<Buffer>;
  open(sealed: Buffer, salt: Buffer): Promise<Buffer>;
}
export const CERTIFICATE_CIPHER = Symbol('CertificateCipher');

/** SRI-032. Days of warning before `notAfter`. */
export const CERTIFICATE_EXPIRY_WARNING_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** SRI-028, SRI-033. Whether `instant` falls inside the validity. */
export function isWithinValidity(
  certificate: Pick<CertificateDescription, 'notBefore' | 'notAfter'>,
  instant: Date,
): boolean {
  return (
    instant.getTime() >= certificate.notBefore.getTime() &&
    instant.getTime() < certificate.notAfter.getTime()
  );
}

/** SRI-032. Within the last 30 days of the validity. */
export function isAboutToExpire(
  certificate: Pick<CertificateDescription, 'notAfter'>,
  instant: Date,
): boolean {
  const remaining = certificate.notAfter.getTime() - instant.getTime();
  return (
    remaining > 0 && remaining <= CERTIFICATE_EXPIRY_WARNING_DAYS * MS_PER_DAY
  );
}
