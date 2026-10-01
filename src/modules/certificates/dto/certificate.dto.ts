import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { CERTIFICATE_TYPES, CONTINGENCY_TYPES } from '../domain/certificate';

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

/** CER-034. The contingency of a rest. */
const CONTINGENCY_TYPE = z.enum(CONTINGENCY_TYPES as [string, ...string[]], {
  error:
    'Elija el tipo de contingencia: enfermedad general, accidente de trabajo, enfermedad profesional o maternidad',
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
    /**
     * CER-034, CER-035, CER-030. Shape only here; whether each is required or
     * refused depends on the type and the attention, and the service says it
     * field by field.
     */
    contingencyType: CONTINGENCY_TYPE.optional(),
    maternityAdmissionOn: clinicalDate('Escriba la fecha de ingreso como AAAA-MM-DD').optional(), // prettier-ignore
    birthOn: clinicalDate('Escriba la fecha del parto como AAAA-MM-DD').optional(), // prettier-ignore
    maternityDischargeOn: clinicalDate('Escriba la fecha de alta como AAAA-MM-DD').optional(), // prettier-ignore
    backdatingReason: z
      .string()
      .trim()
      .max(2000, 'El motivo no puede superar 2000 caracteres')
      .optional(),
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
  /** CER-007. Always `true` on a rest. */
  includeDiagnosis: z.boolean(),
  /** CER-034. `null` on attendance. */
  contingencyType: CONTINGENCY_TYPE.nullable(),
  /** CER-035. `YYYY-MM-DD`, exactly with `MATERNITY`. */
  maternityAdmissionOn: z.string().nullable(),
  birthOn: z.string().nullable(),
  maternityDischargeOn: z.string().nullable(),
  /** CER-030. Why the rest starts before the attention, or `null`. */
  backdatingReason: z.string().nullable(),
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
  /** CER-032. Over 3 and over 7 days; provisional text, never a refusal. */
  restNotices: z.array(z.string()),
});
/** Response of POST /encounters/:encounterId/certificates. */
export class IssuedCertificateDto extends createZodDto(
  issuedCertificateSchema,
) {}

/** «NA = no aplica», as the instructivo of form 117 writes it. */
const NA = z.literal('NA');

/** CER-023, CER-026. The three boxes of a date and the sentence beside them. */
const dateInNumbersAndWordsSchema = z.object({
  /** `YYYY-MM-DD`, a calendar date in Ecuador. */
  iso: z.string(),
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int(),
  /** Derived from the figures, never typed. */
  inWords: z.string(),
});

/**
 * CER-020 to CER-029. Form SNS-MSP/HCU-form.117/2021, block by block.
 *
 * Every printed value is a string or «NA»: the instructivo says «En caso de
 * que existan variables que no pueden ser llenadas, se colocará NA», and an
 * empty box on an official form is a box somebody can fill in afterwards.
 */
export const form117Schema = z.object({
  id: z.uuid(),
  /** CER-029. Consecutive per site. */
  number: z.number().int().positive(),
  /** CER-029. */
  verificationCode: z.string(),
  type: CERTIFICATE_TYPE,
  /** CER-029. `null` while valid; the paper must not read as valid otherwise. */
  revocation: z
    .object({
      revokedAt: z.iso.datetime(),
      /** `YYYY-MM-DD`, in Ecuador. */
      revokedOn: z.string(),
      reason: z.string(),
    })
    .nullable(),
  /**
   * CER-038. The patient's employer, job title, address and phone, read from
   * the chart, on a rest; «NA» on attendance.
   */
  work: z.union([
    z.object({
      employer: z.string(),
      jobTitle: z.string(),
      address: z.string(),
      phone: z.string(),
    }),
    NA,
  ]),
  /** CER-033. «CONFIDENCIAL» exactly when the diagnosis is printed. */
  confidential: z.boolean(),
  /** CER-036. The canton of the site's parish, or «NA». */
  placeOfIssue: z.string(),
  /**
   * CER-037. The site's address and phone for the letterhead. `email` is
   * always `null`: neither the site nor the establishment has one in the
   * schema.
   */
  letterhead: z.object({
    address: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.null(),
  }),
  /** CER-034. The contingency in Spanish, or «NA». */
  contingency: z.string(),
  /** CER-035. Admission, birth and discharge, or «NA». */
  maternity: z.union([
    z.object({
      admission: dateInNumbersAndWordsSchema,
      birth: dateInNumbersAndWordsSchema,
      discharge: dateInNumbersAndWordsSchema,
    }),
    NA,
  ]),
  /** CER-020. Block A. */
  establishment: z.object({
    /** MSP, IESS, ISSFFA or ISPOL; a private clinic is none: «NA». */
    institution: NA,
    mspUnicode: z.string(),
    name: z.string(),
    /** The patient's identity document, or «NA». */
    clinicalRecordNumber: z.string(),
    /** The patient's `mrn`. */
    archiveNumber: z.string(),
  }),
  /** CER-021. Block B, the person. */
  patient: z.object({
    firstFamilyName: z.string(),
    secondFamilyName: z.string(),
    firstGivenName: z.string(),
    secondGivenName: z.string(),
    sex: z.enum(['Hombre', 'Mujer', 'NA']),
    /** The frozen age of the attention, with its condition H/D/M/A. */
    age: z.object({
      value: z.string(),
      condition: z.enum(['H', 'D', 'M', 'A', 'NA']),
    }),
  }),
  /** CER-022 to CER-024. Block B, the attention. */
  attention: z.object({
    service: z.string(),
    specialty: z.string(),
    date: dateInNumbersAndWordsSchema,
    /** `HH:MM`, 24 hours, in Ecuador. */
    from: z.string(),
    to: z.string(),
    admissionDate: NA,
    dischargeDate: NA,
  }),
  /** CER-025, CER-026. Block C. */
  rest: z.object({
    rest: z.enum(['SÍ', 'NO']),
    /** CER-026. Days, both ends included — never hours (D-075). */
    days: z.string(),
    daysInWords: z.string(),
    from: z.union([dateInNumbersAndWordsSchema, NA]),
    to: z.union([dateInNumbersAndWordsSchema, NA]),
    /** «desde el … hasta el …, ambas fechas incluidas», or «NA». */
    periodInWords: z.string(),
  }),
  /** CER-027. Block D: principal first, or «NA». */
  diagnoses: z.union([
    z.array(z.object({ code: z.string(), display: z.string() })),
    NA,
  ]),
  /** CER-028. Block E. */
  professional: z.object({
    /** `YYYY-MM-DD` of the issue, in Ecuador. */
    date: z.string(),
    /** `HH:MM` of the issue, 24 hours, in Ecuador. */
    time: z.string(),
    givenNames: z.string(),
    familyNames: z.string(),
    identification: z.string(),
    hasSeal: z.boolean(),
    /** There is no drawn signature: the credential signs (as PR-035). */
    signature: z.literal('CREDENTIAL'),
  }),
});
/** Response of GET /certificates/:certificateId, the audited read. */
export class Form117Dto extends createZodDto(form117Schema) {}

/** Response types the controllers return. */
export type CertificateResponse = z.infer<typeof certificateSchema>;
export type CertificateListResponse = z.infer<typeof certificateListSchema>;
export type Form117Response = z.infer<typeof form117Schema>;
export type IssuedCertificateResponse = z.infer<typeof issuedCertificateSchema>;
