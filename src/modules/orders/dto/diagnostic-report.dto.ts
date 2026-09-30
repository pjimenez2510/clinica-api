import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The result's contract — the four columns of form 010B, and the two things
 * this API refuses to be told.
 */

const REPORT_STATUS = z.enum(['PARTIAL', 'FINAL', 'CORRECTED', 'CANCELLED']);
const ABNORMAL_FLAG = z.enum([
  'NORMAL',
  'LOW',
  'HIGH',
  'CRITICAL_LOW',
  'CRITICAL_HIGH',
]);

const instant = (label: string) =>
  z.iso.datetime({
    offset: true,
    error: `${label} debe incluir la fecha, la hora y su zona horaria`,
  });

/**
 * ORD-031 to ORD-038. One transcribed determination.
 *
 * ⚠️ THERE IS NO `unit` FIELD (ORD-034). The unit is a property of the analyte
 * and is copied from the catalogue: accepted from the transcriber, the same
 * haemoglobin arrives once in `g/dL` and once in `g/L`, and nothing downstream
 * can tell which.
 *
 * ⚠️ THERE IS NO `referenceLow`/`referenceHigh` EITHER (ORD-036, ORD-037). The
 * applicable range is resolved by SEX and AGE IN DAYS from the catalogue: a
 * range typed by hand is a range that contradicts the one the next report
 * used, on the same analyte, for the same patient.
 *
 * ⚠️ AND `abnormalFlag` IS ACCEPTED ONLY TO BE REFUSED (ORD-035). It is
 * declared so a client that sends it gets `RESULT_FLAG_IS_DERIVED` instead of
 * having it dropped in silence — which would leave whoever typed it believing
 * their mark is the one on the record, on the datum that decides whether
 * somebody phones the patient tonight.
 */
export const submittedResultSchema = z.object({
  analyteDefinitionId: z.uuid('Seleccione la determinación en el catálogo'),
  valueNumeric: z
    .number()
    .finite('El valor numérico no es un número válido')
    .optional(),
  valueCode: z
    .string()
    .trim()
    .max(64, 'El valor no puede superar 64 caracteres')
    .optional(),
  valueText: z
    .string()
    .trim()
    .max(4000, 'El texto del resultado no puede superar 4000 caracteres')
    .optional(),
  abnormalFlag: ABNORMAL_FLAG.optional(),
});

/**
 * ORD-030 to ORD-042. Registering what came back.
 *
 * ⚠️ THERE IS NO `status` FIELD (ORD-030, ORD-039). Whether the report is
 * `PARTIAL` or `FINAL` is DERIVED from whether every non-reflex determination
 * the order asked for has arrived. A status somebody selects is a status that
 * can contradict the rows beside it, and «FINAL» on a report missing three
 * determinations is exactly how a line leaves the worklist unseen.
 *
 * ⚠️ AND THERE IS NO `performedById` (ORD-070). It is a foreign key to OUR
 * practitioners, and the realistic case is an external laboratory (D-A-012).
 * Putting the transcriber there would claim a professional of this clinic
 * performed the analysis.
 */
export const registerReportSchema = z.object({
  /**
   * ORD-071. The conclusion the laboratory printed, if any.
   *
   * ⚠️ THE PDF IS A VIEW, NOT A SOURCE. IHE considers a report NON-CONFORMANT
   * when it carries an interpretation absent from the structured data, and the
   * rule is adopted here: whatever this text says, the values are what the
   * system compares, plots and alerts on.
   */
  conclusion: z
    .string()
    .trim()
    .max(4000, 'La conclusión no puede superar 4000 caracteres')
    .optional(),
  /** ORD-030. WHEN the laboratory issued it, which is not when it was typed. */
  issuedAt: instant('La fecha de emisión del informe').optional(),
  results: z
    .array(submittedResultSchema)
    .min(1, 'Registre al menos una determinación')
    .max(200, 'Un informe no puede llevar más de 200 determinaciones'),
});
export class RegisterReportDto extends createZodDto(registerReportSchema) {}

/**
 * ORD-050 to ORD-054. Correcting a report.
 *
 * THE SAME SHAPE AS REGISTERING, and it has to be: a correction that could
 * carry less than the original would produce a «current version» with holes in
 * it. What makes it a correction is the route and the report it names, never a
 * different payload.
 */
export const correctReportSchema = registerReportSchema;
export class CorrectReportDto extends createZodDto(correctReportSchema) {}

/** ORD-031 to ORD-038. One determination as a client reads it. */
export const observationSchema = z.object({
  id: z.string(),
  /** ORD-040. `null` means nobody asked for it: it is in the unmatched list. */
  orderItemId: z.uuid().nullable(),
  /** `DETERMINACIÓN` — frozen at the moment it was registered. */
  analyteDisplay: z.string(),
  /** `RESULTADO`, in whichever of the three the analyte declares. */
  valueNumeric: z.number().nullable(),
  valueText: z.string().nullable(),
  valueCode: z.string().nullable(),
  /** `UNIDAD DE MEDIDA`. */
  unit: z.string().nullable(),
  /** `VALOR DE REFERENCIA`. */
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  referenceText: z.string().nullable(),
  /** ORD-038. `null` is «no había con qué compararlo», NEVER «normal». */
  abnormalFlag: ABNORMAL_FLAG.nullable(),
  observedAt: z.iso.datetime(),
});

/** ORD-030, ORD-051. One report as a client reads it. */
export const diagnosticReportSchema = z.object({
  id: z.uuid(),
  serviceOrderId: z.uuid(),
  status: REPORT_STATUS,
  conclusion: z.string().nullable(),
  issuedAt: z.iso.datetime().nullable(),
  /** ORD-050. The report this one corrects. */
  supersedesId: z.uuid().nullable(),
  /**
   * ORD-051. The correction that replaced THIS one, and when.
   *
   * It is what lets a screen print «corregido el …» beside a number somebody
   * may already have acted on, instead of quietly showing the new one.
   */
  supersededById: z.uuid().nullable(),
  supersededAt: z.iso.datetime().nullable(),
  results: z.array(observationSchema),
});
export class DiagnosticReportDto extends createZodDto(diagnosticReportSchema) {}

export const diagnosticReportListSchema = z.object({
  items: z.array(diagnosticReportSchema),
});
export class DiagnosticReportListDto extends createZodDto(
  diagnosticReportListSchema,
) {}

/** ORD-040, ORD-060. One entry of a safety worklist. */
export const flaggedResultSchema = z.object({
  resultId: z.string(),
  reportId: z.uuid(),
  orderId: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  analyteDisplay: z.string(),
  valueNumeric: z.number().nullable(),
  valueCode: z.string().nullable(),
  unit: z.string().nullable(),
  abnormalFlag: ABNORMAL_FLAG.nullable(),
  observedAt: z.iso.datetime(),
});

export const flaggedResultListSchema = z.object({
  items: z.array(flaggedResultSchema),
});
export class FlaggedResultListDto extends createZodDto(
  flaggedResultListSchema,
) {}

/**
 * ORD-043. Pairing an orphan result with a line of its own order.
 *
 * ⚠️ THERE IS NO `orderId` FIELD, AND THE ABSENCE IS THE REQUIREMENT. The order
 * is the one the result's report already belongs to, read from the row — the
 * same rule that keeps `orderedById` out of the order (ORD-001). An order id in
 * the request is a result somebody can file against another person's order, and
 * it would be accepted by a schema that could not possibly tell.
 *
 * ⚠️ AND THERE IS NO «DESCARTAR» FIELD (⚠️ **Falta esquema**, ORD-041, ORD-043).
 * `observation_result` has no column saying that a person looked at this value
 * and it belongs to nobody here, nor who decided it. A flag with nowhere to
 * record the author and the motive would empty the queue while destroying the
 * only evidence that it was ever worked.
 */
export const matchResultSchema = z.object({
  orderItemId: z.uuid('Elija la línea de la orden que este resultado responde'),
});
export class MatchResultDto extends createZodDto(matchResultSchema) {}

/** ORD-040, ORD-060. How much of a safety worklist to bring back. */
export const worklistQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200, 'No se pueden listar más de 200 resultados de una vez')
    .default(100),
});
export class WorklistQueryDto extends createZodDto(worklistQuerySchema) {}

export type DiagnosticReportResponse = z.infer<typeof diagnosticReportSchema>;
export type DiagnosticReportListResponse = z.infer<
  typeof diagnosticReportListSchema
>;
export type FlaggedResultListResponse = z.infer<typeof flaggedResultListSchema>;
