import type {
  CertificateType,
  ContingencyType,
  IessValidation,
} from './domain/certificate';
import type { CertificateView } from './domain/certificate.repository';
import type {
  IssueCertificateRequest,
  IssuedCertificate,
} from './application/certificate.service';
import type { ClinicalDate } from '../../shared/domain/clinic-time';
import type { Form117 } from '../../shared/domain/form-117/form-117';
import type {
  CertificateResponse,
  Form117Response,
  IssueCertificateBody,
  IssuedCertificateResponse,
} from './dto/certificate.dto';

/**
 * CER-001 to CER-008, CER-053. The body of an issue —or of the certificate a
 * correction issues— as the service reads it. The dates were validated as
 * calendar dates by the DTO.
 */
export function toIssueFields(
  dto: IssueCertificateBody,
): Omit<IssueCertificateRequest, 'encounterId'> {
  return {
    type: dto.type as CertificateType,
    restFrom: (dto.restFrom ?? null) as ClinicalDate | null,
    restTo: (dto.restTo ?? null) as ClinicalDate | null,
    includeDiagnosis: dto.includeDiagnosis,
    contingencyType: (dto.contingencyType ?? null) as ContingencyType | null,
    maternityAdmissionOn: (dto.maternityAdmissionOn ?? null) as ClinicalDate | null, // prettier-ignore
    birthOn: (dto.birthOn ?? null) as ClinicalDate | null,
    maternityDischargeOn: (dto.maternityDischargeOn ?? null) as ClinicalDate | null, // prettier-ignore
    backdatingReason: dto.backdatingReason ?? null,
    issuedByOtherReason: dto.issuedByOtherReason ?? null,
  };
}

/** CER-013. An issued certificate with what the IESS needs to be told. */
export function toIssuedResponse(
  issued: IssuedCertificate,
): IssuedCertificateResponse {
  return {
    certificate: toCertificateResponse(issued.certificate),
    iess: toIessResponse(issued.iess),
    restNotices: [...issued.restNotices],
  };
}

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
    contingencyType: certificate.contingencyType,
    maternityAdmissionOn: certificate.maternity?.admissionOn ?? null,
    birthOn: certificate.maternity?.birthOn ?? null,
    maternityDischargeOn: certificate.maternity?.dischargeOn ?? null,
    backdatingReason: certificate.backdatingReason,
    issuedByOtherReason: certificate.issuedByOtherReason,
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
      // The screen's contract (CER-027 in the DTO): code and display. The
      // certainty is the paper's PRE and DEF columns.
      form.diagnoses === 'NA'
        ? 'NA'
        : form.diagnoses.map(({ code, display }) => ({ code, display })),
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
