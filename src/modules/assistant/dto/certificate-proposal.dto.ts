import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-299. The certificate said in the conversation, read by rules. A schema
 * so `clinica-web` types it from OpenAPI.
 */
const part = <Value extends z.ZodType>(value: Value) =>
  z.object({
    value,
    /** The phrase that says it, as it was heard. */
    quote: z.string(),
    /** The start of its sentence, in the listening's clock. */
    startMs: z.number().int(),
  });

export const certificateProposalSchema = z.object({
  /** Null when no certificate was said, or it was denied. */
  certificate: z
    .object({
      type: part(z.enum(['MEDICAL_REST', 'ATTENDANCE'])),
      days: part(z.number().int().positive()).nullable(),
    })
    .nullable(),
});

export class CertificateProposalDto extends createZodDto(
  certificateProposalSchema,
) {}
