import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * SRI-080, SRI-083. The .p12 travels as base64 inside JSON, with its password.
 *
 * The length cap is the base64 of 64 KiB plus padding: a larger body is
 * refused by the schema before anything decodes it, and the service checks
 * the decoded size again (SRI-083).
 */
const uploadCertificateSchema = z.object({
  pkcs12Base64: z
    .string('Adjunte el archivo .p12')
    .min(1, 'Adjunte el archivo .p12')
    .max(
      Math.ceil((64 * 1024) / 3) * 4 + 4,
      'El archivo es demasiado grande para ser un certificado .p12',
    )
    .regex(
      /^[A-Za-z0-9+/]+={0,2}$/,
      'El archivo no llegó completo; vuelva a adjuntarlo',
    ),
  password: z
    .string('Escriba la clave del certificado')
    .min(1, 'Escriba la clave del certificado')
    .max(200, 'La clave es demasiado larga'),
});
export class UploadCertificateDto extends createZodDto(
  uploadCertificateSchema,
) {}

const certificateSchema = z.object({
  id: z.uuid(),
  subject: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  /** SRI-102. The holder's RUC as the certificate states it. */
  holderRuc: z.string().nullable(),
  /** SRI-102. `false`: not the establishment's; `null`: it could not tell. */
  holderRucMatchesIssuer: z.boolean().nullable(),
});
export class CertificateDto extends createZodDto(certificateSchema) {}
export type CertificateResponse = z.infer<typeof certificateSchema>;

const sriMessageSchema = z.object({
  identifier: z.string(),
  message: z.string(),
  additionalInformation: z.string().nullable(),
  type: z.string(),
});

const voucherStatus = z.enum([
  'NO_VOUCHER',
  // SRI-109. Never listed: a replaced voucher belongs to no document.
  'SUPERSEDED',
  'PREPARED',
  'SIGNED',
  'RECEIVED',
  'AUTHORISED',
  'RETURNED',
  'NOT_AUTHORISED',
]);

const monitorRowSchema = z.object({
  /** SRI-088. An invoice or a credit note. */
  document: z.enum(['INVOICE', 'CREDIT_NOTE']),
  /** The invoice, or the one the credit note modifies. */
  invoiceId: z.uuid(),
  creditNoteId: z.uuid().nullable(),
  /** SRI-088. For a credit note, the number of the invoice it modifies. */
  modifiedDocumentNumber: z.string().nullable(),
  /** BI-303. The credit note's reason code; `null` for an invoice. */
  creditNoteReasonCode: z.string().nullable(),
  voucherId: z.uuid().nullable(),
  siteId: z.uuid(),
  documentNumber: z.string(),
  buyerName: z.string(),
  buyerIdentification: z.string(),
  issuedAt: z.iso.datetime(),
  total: z.string(),
  status: voucherStatus,
  /** Why a PREPARED voucher is not moving (SRI-028 to SRI-030, SRI-017). */
  blockedReason: z.string().nullable(),
  /** SRI-008. What the installation lacks for an invoice to have a voucher. */
  missingData: z.array(z.string()),
  accessKey: z.string().nullable(),
  lastMessages: z.array(sriMessageSchema),
  attemptCount: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  /** SRI-062. The SRI's last reception of it; a day without answer counts from here. */
  receivedAt: z.iso.datetime().nullable(),
  /** SRI-055, D-102. Its key belongs to the environment not configured now. */
  environmentMismatch: z.boolean(),
  needsAPerson: z.boolean(),
  /** SRI-108. Returned only with the 45 and never authorised: renumber it. */
  renumberable: z.boolean(),
  /** SRI-108. What decides it: whether the SRI ever authorised the voucher. */
  authorisationNumber: z.string().nullable(),
  everAuthorised: z.boolean(),
  /** SRI-109. The numbers the SRI already held, oldest first. */
  renumberedFrom: z.array(
    z.object({
      previousNumber: z.string(),
      newSequential: z.string(),
      renumberedAt: z.iso.datetime(),
      renumberedByName: z.string(),
      sriMessage: z.string(),
    }),
  ),
  /**
   * SRI-069. The last attempt, when it was a transport failure: the status
   * and a summary of the fault's string. The whole of it, its detail and the
   * body are asked for apart (D-107).
   */
  lastTransportFailure: z
    .object({
      at: z.iso.datetime(),
      httpStatus: z.number().int().nullable(),
      faultCode: z.string().nullable(),
      /** D-107. The first 500 characters, with the cut mark; whole apart. */
      faultSummary: z.string().nullable(),
      /** The failure in one line, only when there is no `faultString`. */
      error: z.string().nullable(),
      hasResponseBody: z.boolean(),
    })
    .nullable(),
});

const monitorSchema = z.object({
  rows: z.array(monitorRowSchema),
  // SRI-082, SRI-063. Caja learns WHETHER signing works and until when — not
  // whose certificate it is: the subject carries the signer's name and
  // cédula, and seeing certificates is `config:manage`.
  certificate: z.object({
    active: z
      .object({ notBefore: z.iso.datetime(), notAfter: z.iso.datetime() })
      .nullable(),
    aboutToExpire: z.boolean(),
    expired: z.boolean(),
  }),
  webServiceConfigured: z.boolean(),
  /** SRI-098. E-mails still failing three days after their authorisation. */
  deliveryStalled: z.object({
    count: z.number().int(),
    oldestAuthorisedAt: z.iso.datetime().nullable(),
  }),
});
export class SriMonitorDto extends createZodDto(monitorSchema) {}
export type SriMonitorResponse = z.infer<typeof monitorSchema>;

/** SRI-069. The SRI's answer to the last failed attempt, as it was kept (SRI-059). */
const transportFailureSchema = z.object({
  failure: z
    .object({
      at: z.iso.datetime(),
      httpStatus: z.number().int().nullable(),
      faultCode: z.string().nullable(),
      faultString: z.string().nullable(),
      faultDetail: z.string().nullable(),
      error: z.string(),
      responseBody: z.string().nullable(),
    })
    .nullable(),
});
export class SriTransportFailureDto extends createZodDto(
  transportFailureSchema,
) {}
export type SriTransportFailureResponse = z.infer<
  typeof transportFailureSchema
>;

/**
 * SRI-095. Body of POST /sri/vouchers/:voucherId/resend: where the copy goes,
 * and nothing else. Strict, like every body that reaches a person's data.
 */
const resendVoucherSchema = z.strictObject({
  email: z
    .email('Ingrese un correo electrónico válido')
    .max(320, 'El correo no puede superar 320 caracteres'),
});
export class ResendVoucherDto extends createZodDto(resendVoucherSchema) {}

/** SRI-109. The number the SRI already held, and the one it goes out with now. */
const renumberedSchema = z.object({
  previousSequential: z.string(),
  newSequential: z.string(),
});
export class RenumberedDto extends createZodDto(renumberedSchema) {}
export type RenumberedResponse = z.infer<typeof renumberedSchema>;
