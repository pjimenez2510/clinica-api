import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The exam catalogue's administration contract (ORD-103 to ORD-111).
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

/** ORD-103. The exam's writable fields. */
const examFields = {
  name: z
    .string()
    .trim()
    .min(1, 'Escriba el nombre del examen')
    .max(200, 'El nombre no puede superar 200 caracteres'),
  category: CATEGORY,
  form010Section: optionalText(60, 'La sección no puede superar 60 caracteres'),
  specimenType: optionalText(80, 'La muestra no puede superar 80 caracteres'),
  patientPreparation: optionalText(500, 'La preparación no puede superar 500 caracteres'), // prettier-ignore
  turnaroundHours: z
    .number()
    .int('Escriba horas enteras')
    .min(1, 'El tiempo de entrega es de al menos una hora')
    .max(32000, 'El tiempo de entrega es demasiado largo')
    .nullable(),
  performedExternally: z.boolean(),
  externalLabName: optionalText(160, 'El laboratorio no puede superar 160 caracteres'), // prettier-ignore
  externalLabCode: optionalText(64, 'El código del laboratorio no puede superar 64 caracteres'), // prettier-ignore
  /** ORD-004. The tariff code the order line resolves on the clinical date. */
  tariffCode: optionalText(32, 'El código del tarifario no puede superar 32 caracteres'), // prettier-ignore
  billableServiceId: z.uuid('Elija la prestación de la lista').nullable(),
  active: z.boolean(),
};

export const createExamSchema = z
  .object({ code: CODE, ...examFields })
  .strict();
/** Body of POST /exam-catalogue/exams. */
export class CreateExamDto extends createZodDto(createExamSchema) {}

/** ORD-103. Any subset; the code is not among them, it never changes. */
export const updateExamSchema = z.object(examFields).partial().strict();
/** Body of PATCH /exam-catalogue/exams/:examId. */
export class UpdateExamDto extends createZodDto(updateExamSchema) {}

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
/** Body of PUT /exam-catalogue/exams/:examId/analytes. */
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

export const updateAnalyteSchema = z.object(analyteFields).partial().strict();
/** Body of PATCH /exam-catalogue/analytes/:analyteId. */
export class UpdateAnalyteDto extends createZodDto(updateAnalyteSchema) {}

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

const examServiceSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  categoryName: z.string(),
  kind: z.string(),
  active: z.boolean(),
});

export const adminExamSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  category: CATEGORY,
  form010Section: z.string().nullable(),
  specimenType: z.string().nullable(),
  patientPreparation: z.string().nullable(),
  turnaroundHours: z.number().int().nullable(),
  performedExternally: z.boolean(),
  externalLabName: z.string().nullable(),
  externalLabCode: z.string().nullable(),
  tariffCode: z.string().nullable(),
  active: z.boolean(),
  /** ORD-108. Shown by code, name and class; never a price (ORD-002). */
  billableService: examServiceSchema.nullable(),
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
/** One exam of the administration screen. */
export class AdminExamDto extends createZodDto(adminExamSchema) {}

export const adminExamListSchema = z.object({
  items: z.array(adminExamSchema),
});
/** Response of GET /exam-catalogue/exams. */
export class AdminExamListDto extends createZodDto(adminExamListSchema) {}

export type AdminExamResponse = z.infer<typeof adminExamSchema>;
export type AdminExamListResponse = z.infer<typeof adminExamListSchema>;
export type AdminAnalyteResponse = z.infer<typeof adminAnalyteSchema>;
export type AdminAnalyteListResponse = z.infer<typeof adminAnalyteListSchema>;
