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
  'PREPARED',
  'SIGNED',
  'RECEIVED',
  'AUTHORISED',
  'RETURNED',
  'NOT_AUTHORISED',
]);

const monitorRowSchema = z.object({
  invoiceId: z.uuid(),
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
});
export class SriMonitorDto extends createZodDto(monitorSchema) {}
export type SriMonitorResponse = z.infer<typeof monitorSchema>;
