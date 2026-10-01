import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { CERTIFICATE_TYPES } from '../domain/certificate';

/**
 * The medical certificate's contract — form SNS-MSP/HCU-form.117/2021.
 *
 * Responses are schemas too: `clinica-web` generates its types from the
 * OpenAPI document.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

const CERTIFICATE_TYPE = z.enum(CERTIFICATE_TYPES as [string, ...string[]], {
  error: 'Elija el tipo de certificado: asistencia o reposo',
});

/** A calendar date in Ecuador, `YYYY-MM-DD`, that exists on the calendar. */
const clinicalDate = (message: string) =>
  z.string().refine((value) => {
    try {
      parseClinicalDate(value);
      return true;
    } catch {
      return false;
    }
  }, message);

/**
 * CER-001 to CER-008. Issuing a certificate from an attention.
 *
 * ⚠️ STRICT, AND THE STRICTNESS IS CER-004: the issuer is the session, and a
 * body that names one (`issuedById`, `practitionerId`) is refused rather than
 * silently dropped — dropping it would let the caller believe the name they
 * sent is the one on the certificate.
 *
 * ⚠️ `includeDiagnosis` HAS NO DEFAULT, AND THAT IS CER-007. The instructivo
 * makes block D obligatory and the LOPDP protects the patient whose employer
 * reads the paper; until D-075 is decided the doctor answers on every
 * certificate and nobody inherits a value.
 *
 * The rest period is validated for SHAPE here; whether it is required,
 * forbidden or inverted is CER-006 and the service says it, field by field.
 */
export const issueCertificateSchema = z.strictObject(
  {
    type: CERTIFICATE_TYPE,
    restFrom: clinicalDate('Escriba la fecha de inicio del reposo como AAAA-MM-DD').optional(), // prettier-ignore
    restTo: clinicalDate('Escriba la fecha de fin del reposo como AAAA-MM-DD').optional(), // prettier-ignore
    includeDiagnosis: z.boolean({
      error: 'Indique si el diagnóstico se incluye en el certificado',
    }),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'El certificado lo emite el profesional de la sesión: no envíe otros campos'
        : undefined,
  },
);
/** Body of POST /encounters/:encounterId/certificates. */
export class IssueCertificateDto extends createZodDto(issueCertificateSchema) {}

/**
 * CER-011. Annulling: the reason, and nothing else. Who annulled it is the
 * session; when, the server's clock.
 */
export const revokeCertificateSchema = z.object({
  reason: z
    .string({ error: 'Escriba por qué se anula el certificado' })
    .trim()
    .min(5, 'Escriba por qué se anula el certificado')
    .max(500, 'El motivo no puede superar 500 caracteres'),
});
/** Body of POST /certificates/:certificateId/revoke. */
export class RevokeCertificateDto extends createZodDto(
  revokeCertificateSchema,
) {}

/** A certificate as a client reads it on the write path. */
export const certificateSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  patientId: z.uuid(),
  /** CER-004. The practitioner of the session that issued it. */
  issuedById: z.uuid(),
  type: CERTIFICATE_TYPE,
  /** CER-009. Consecutive per site, without gaps. */
  number: z.number().int().positive(),
  /** Random, for a third party to verify it. Not the number. */
  verificationCode: z.string(),
  issuedAt: z.iso.datetime(),
  /** CER-006. Calendar dates in Ecuador, `YYYY-MM-DD`; `null` on attendance. */
  restFrom: z.string().nullable(),
  restTo: z.string().nullable(),
  /** CER-007. */
  includeDiagnosis: z.boolean(),
  /** CER-011. `null` while valid. */
  revokedAt: z.iso.datetime().nullable(),
  revocationReason: z.string().nullable(),
});
/** Response of reading one certificate and of annulling it. */
export class CertificateDto extends createZodDto(certificateSchema) {}

export const certificateListSchema = z.object({
  items: z.array(certificateSchema),
});
/** Response of GET /encounters/:encounterId/certificates. */
export class CertificateListDto extends createZodDto(certificateListSchema) {}

/** CER-013. What the response of a rest certificate tells the doctor. */
export const iessValidationSchema = z.object({
  /** `YYYY-MM-DD`: eight days after the end of the rest, in Ecuador. */
  lastValidationDay: z.string(),
  /** Not applicable to voluntary affiliates, retirees or Seguro Social Campesino. */
  notice: z.string(),
});

export const issuedCertificateSchema = z.object({
  certificate: certificateSchema,
  /** CER-013. `null` on an attendance certificate. */
  iess: iessValidationSchema.nullable(),
});
/** Response of POST /encounters/:encounterId/certificates. */
export class IssuedCertificateDto extends createZodDto(
  issuedCertificateSchema,
) {}

/** Response types the controllers return. */
export type CertificateResponse = z.infer<typeof certificateSchema>;
export type CertificateListResponse = z.infer<typeof certificateListSchema>;
export type IssuedCertificateResponse = z.infer<typeof issuedCertificateSchema>;
