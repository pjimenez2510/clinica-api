import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The exam catalogue's administration contract (ORD-104 to ORD-111). The
 * exam itself is a service, written by billing (ADR-013, BI-280).
 *
 * Wording follows ADR-005: what to do, in Spanish, without the norm.
 */

const CATEGORY = z.enum(['LABORATORY', 'IMAGING', 'PROCEDURE']);
const VALUE_TYPE = z.enum(['NUMERIC', 'CODED', 'TEXT', 'ORDINAL']);
const RANGE_KIND = z.enum(['REFERENCE', 'CRITICAL']);
const SEX = z.enum(['MALE', 'FEMALE']);

/** A free text that is `null` when left blank. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullable()
    .transform((value) => (value ? value : null));

/** Codes are what a paper report quotes: upper case, no spaces. */
const CODE = z
  .string()
  .trim()
  .min(1, 'Escriba el código')
  .max(32, 'El código no puede superar 32 caracteres')
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use mayúsculas, números, punto, guion o guion bajo, sin espacios'); // prettier-ignore

/** ORD-105. The structure, in printing order. */
export const examStructureSchema = z
  .object({
    analytes: z
      .array(
        z
          .object({
            analyteDefinitionId: z.uuid('Elija la determinación de la lista'),
            isReflex: z.boolean().default(false),
          })
          .strict(),
      )
      .max(80, 'Un examen no puede devolver más de 80 determinaciones')
      .refine(
        (list) =>
          new Set(list.map((entry) => entry.analyteDefinitionId)).size ===
          list.length,
        'Una determinación no puede repetirse en el mismo examen',
      ),
  })
  .strict();
/** Body of PUT /exam-catalogue/exams/:serviceId/analytes. */
export class ExamStructureDto extends createZodDto(examStructureSchema) {}

/** ORD-104. The analyte's writable fields. */
const analyteFields = {
  name: z
    .string()
    .trim()
    .min(1, 'Escriba el nombre de la determinación')
    .max(160, 'El nombre no puede superar 160 caracteres'),
  valueType: VALUE_TYPE,
  unit: optionalText(32, 'La unidad no puede superar 32 caracteres'),
  decimals: z
    .number()
    .int('Escriba un número entero de decimales')
    .min(0, 'Los decimales van de 0 a 4')
    .max(4, 'Los decimales van de 0 a 4')
    .nullable(),
  allowedValues: z
    .array(z.string().trim().min(1, 'Una respuesta no puede ir vacía').max(60))
    .max(30, 'No más de 30 respuestas')
    .nullable()
    .transform((list) => (list && list.length > 0 ? list : null)),
  loincCode: optionalText(16, 'El código LOINC no puede superar 16 caracteres'),
  active: z.boolean(),
};

export const createAnalyteSchema = z
  .object({ code: CODE, ...analyteFields })
  .strict();
/** Body of POST /exam-catalogue/analytes. */
export class CreateAnalyteDto extends createZodDto(createAnalyteSchema) {}

/** ORD-106. One range: by sex and age in days, bounds or text. */
const rangeSchema = z
  .object({
    rangeKind: RANGE_KIND,
    sex: SEX.nullable(),
    ageMinDays: z.number().int().min(0, 'La edad no puede ser negativa').nullable(), // prettier-ignore
    ageMaxDays: z.number().int().min(0, 'La edad no puede ser negativa').nullable(), // prettier-ignore
    low: z.number().nullable(),
    high: z.number().nullable(),
    text: optionalText(200, 'El texto no puede superar 200 caracteres'),
  })
  .strict();

export const analyteRangesSchema = z
  .object({
    ranges: z.array(rangeSchema).max(40, 'No más de 40 rangos por determinación'), // prettier-ignore
  })
  .strict();
/** Body of PUT /exam-catalogue/analytes/:analyteId/ranges. */
export class AnalyteRangesDto extends createZodDto(analyteRangesSchema) {}

/**
 * ORD-104, ORD-141. Any subset of the analyte's fields, and optionally its new
 * ranges: the unit and the ranges written in it change together, in one
 * transaction, or neither does.
 */
export const updateAnalyteSchema = z
  .object({ ...analyteFields, ranges: analyteRangesSchema.shape.ranges })
  .partial()
  .strict();
/** Body of PATCH /exam-catalogue/analytes/:analyteId. */
export class UpdateAnalyteDto extends createZodDto(updateAnalyteSchema) {}

// ─── Responses ───────────────────────────────────────────────────────────

const rangeResponse = z.object({
  rangeKind: z.enum(['REFERENCE', 'CRITICAL', 'ABSOLUTE']),
  sex: z.string().nullable(),
  ageMinDays: z.number().int().nullable(),
  ageMaxDays: z.number().int().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  text: z.string().nullable(),
});

/** ORD-114. One version of a range, with the time it applied. */
export const rangeHistorySchema = z.object({
  items: z.array(
    rangeResponse.extend({
      validFrom: z.iso.datetime(),
      /** `null` while it is the one in force. */
      validTo: z.iso.datetime().nullable(),
    }),
  ),
});
/** Response of GET /exam-catalogue/analytes/:analyteId/ranges/history. */
export class RangeHistoryDto extends createZodDto(rangeHistorySchema) {}

export const adminAnalyteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  valueType: VALUE_TYPE,
  unit: z.string().nullable(),
  decimals: z.number().int().nullable(),
  allowedValues: z.array(z.string()).nullable(),
  loincCode: z.string().nullable(),
  active: z.boolean(),
  ranges: z.array(rangeResponse),
  /** ORD-105. Correcting the analyte corrects every one of these. */
  usedBy: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string() })), // prettier-ignore
});
/** One analyte of the administration screen. */
export class AdminAnalyteDto extends createZodDto(adminAnalyteSchema) {}

export const adminAnalyteListSchema = z.object({
  items: z.array(adminAnalyteSchema),
});
/** Response of GET /exam-catalogue/analytes. */
export class AdminAnalyteListDto extends createZodDto(adminAnalyteListSchema) {}

/** ORD-105. One ordered service with its structure; `id` is the service's. */
export const adminExamSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  category: CATEGORY,
  form010Section: z.string().nullable(),
  specimenType: z.string().nullable(),
  patientPreparation: z.string().nullable(),
  turnaroundHours: z.number().int().nullable(),
  requiresFasting: z.boolean(),
  fastingHours: z.number().int().nullable(),
  performedExternally: z.boolean(),
  externalLabName: z.string().nullable(),
  externalLabCode: z.string().nullable(),
  /** BI-285. The service's MSP code; never a price (ORD-002). */
  mspCode: z.string().nullable(),
  active: z.boolean(),
  /** ORD-105. In printing order, each with its ranges (ORD-106). */
  analytes: z.array(
    z.object({
      position: z.number().int(),
      isReflex: z.boolean(),
      analyte: z.object({
        id: z.uuid(),
        code: z.string(),
        name: z.string(),
        valueType: VALUE_TYPE,
        unit: z.string().nullable(),
        decimals: z.number().int().nullable(),
        allowedValues: z.array(z.string()).nullable(),
        ranges: z.array(rangeResponse),
      }),
    }),
  ),
});
/** Response of PUT /exam-catalogue/exams/:serviceId/analytes. */
export class AdminExamDto extends createZodDto(adminExamSchema) {}

export type AdminExamResponse = z.infer<typeof adminExamSchema>;
export type AdminAnalyteResponse = z.infer<typeof adminAnalyteSchema>;
export type AdminAnalyteListResponse = z.infer<typeof adminAnalyteListSchema>;
export type RangeHistoryResponse = z.infer<typeof rangeHistorySchema>;
