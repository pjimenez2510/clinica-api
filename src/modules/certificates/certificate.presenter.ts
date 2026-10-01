import type { IessValidation } from './domain/certificate';
import type { CertificateView } from './domain/certificate.repository';
import type { Form117 } from './domain/form-117';
import type {
  CertificateResponse,
  Form117Response,
} from './dto/certificate.dto';

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

/**
 * CER-020 to CER-029. The form as composed; only the instant of the
 * annulment changes shape, to ISO 8601 — its date is already served apart, in
 * Ecuador.
 */
export function toForm117Response(form: Form117): Form117Response {
  return {
    ...form,
    revocation:
      form.revocation === null
        ? null
        : {
            revokedAt: form.revocation.revokedAt.toISOString(),
            revokedOn: form.revocation.revokedOn,
            reason: form.revocation.reason,
          },
    diagnoses:
      form.diagnoses === 'NA' ? 'NA' : form.diagnoses.map((d) => ({ ...d })),
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
