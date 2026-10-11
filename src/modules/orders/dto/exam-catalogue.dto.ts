import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * ORD-010 to ORD-012. The catalogue of what can be ordered, as a client reads
 * it.
 *
 * ADR-013, BI-284. Each orderable is a service with an order extension: its
 * `id` and `code` are the service's.
 *
 * ⚠️ NO PRICE (ORD-002). The amount lives in a price list, per payer, per period, and belongs to
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

export const orderableExamSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** ORD-101. What lets the list be filtered by the order's category. */
  category: z.enum(['LABORATORY', 'IMAGING', 'PROCEDURE']),
  /** ORD-010. The section of form 010A, so a compliant order can be printed. */
  form010Section: z.string().nullable(),
  specimenType: z.string().nullable(),
  /** ORD-010. Printed on the order: an unstated fast is a second extraction. */
  patientPreparation: z.string().nullable(),
  turnaroundHours: z.number().int().nullable(),
  requiresFasting: z.boolean(),
  fastingHours: z.number().int().nullable(),
  /**
   * ORD-004, BI-285. The service's MSP code, or `null`. Never a condition to
   * order (D-218 §1): the server resolves the TARIFF version in force, when
   * there is one, and a client never sends it. The key keeps its old name.
   */
  tariffCode: z.string().nullable(),
  performedExternally: z.boolean(),
  externalLabName: z.string().nullable(),
  analytes: z.array(examAnalyteSchema),
});
/** One orderable; no route returns it alone, it is the row of `OrderableExamListDto`. */
export class OrderableExamDto extends createZodDto(orderableExamSchema) {}

export const orderableExamListSchema = z.object({
  items: z.array(orderableExamSchema),
});
/** Response of GET /exams. */
export class OrderableExamListDto extends createZodDto(
  orderableExamListSchema,
) {}

/** What the controller returns, inferred from the schema Swagger publishes. */
export type OrderableExamListResponse = z.infer<typeof orderableExamListSchema>;
