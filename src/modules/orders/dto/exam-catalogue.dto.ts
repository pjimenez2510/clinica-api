import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * ORD-010 to ORD-012. The catalogue of what can be ordered, as a client reads
 * it.
 *
 * ⚠️ NO PRICE (ORD-002). The exam points at what the line is invoiced under;
 * the amount lives in a price list, per payer, per period, and belongs to
 * `billing`. A price on this response would be an economic fact travelling on a
 * clinical screen.
 */

const VALUE_TYPE = z.enum(['NUMERIC', 'CODED', 'TEXT', 'ORDINAL']);

/** ORD-011, ORD-012. One determination the exam yields. */
export const examAnalyteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** UCUM, so `mg/dL` means one thing. `null` on the coded ones. */
  unit: z.string().nullable(),
  valueType: VALUE_TYPE,
  decimals: z.number().int().nullable(),
  /** ORD-033. The answers a coded determination admits. */
  allowedValues: z.array(z.string()).nullable(),
  /** ORD-011. Printing order, stored and never derived from the name. */
  position: z.number().int(),
  /** ORD-012, ORD-039. Expected absent, so its absence is not a gap. */
  isReflex: z.boolean(),
});

export const examDefinitionSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** ORD-010. The section of form 010A, so a compliant order can be printed. */
  form010Section: z.string().nullable(),
  specimenType: z.string().nullable(),
  /** ORD-010. Printed on the order: an unstated fast is a second extraction. */
  patientPreparation: z.string().nullable(),
  turnaroundHours: z.number().int().nullable(),
  performedExternally: z.boolean(),
  externalLabName: z.string().nullable(),
  analytes: z.array(examAnalyteSchema),
});
export class ExamDefinitionDto extends createZodDto(examDefinitionSchema) {}

export const examDefinitionListSchema = z.object({
  items: z.array(examDefinitionSchema),
});
export class ExamDefinitionListDto extends createZodDto(
  examDefinitionListSchema,
) {}

export type ExamDefinitionListResponse = z.infer<
  typeof examDefinitionListSchema
>;
