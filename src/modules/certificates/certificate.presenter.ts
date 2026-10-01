import type { IessValidation } from './domain/certificate';
import type { CertificateView } from './domain/certificate.repository';
import type { CertificateResponse } from './dto/certificate.dto';

/**
 * Domain shapes out, JSON in. Shared by the two controllers of this module.
 *
 * Instants leave as ISO 8601; the rest dates leave as `YYYY-MM-DD`, because
 * they are calendar dates and never instants — an ISO timestamp would be
 * rendered by the browser in its own zone.
 */

/** A certificate, field by field. */
export function toCertificateResponse(
  certificate: CertificateView,
): CertificateResponse {
  return {
    id: certificate.id,
    encounterId: certificate.encounterId,
    patientId: certificate.patientId,
    issuedById: certificate.issuedById,
    type: certificate.type,
    number: certificate.number,
    verificationCode: certificate.verificationCode,
    issuedAt: certificate.issuedAt.toISOString(),
    restFrom: certificate.restFrom,
    restTo: certificate.restTo,
    includeDiagnosis: certificate.includeDiagnosis,
    revokedAt: certificate.revokedAt?.toISOString() ?? null,
    revocationReason: certificate.revocationReason,
  };
}

/** CER-013. What the IESS needs to be said, or `null`. */
export function toIessResponse(
  iess: IessValidation | null,
): { lastValidationDay: string; notice: string } | null {
  return iess === null
    ? null
    : { lastValidationDay: iess.lastValidationDay, notice: iess.notice };
}
