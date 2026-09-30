import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Block K's contract — the RDACAA's diagnoses and procedures.
 *
 * Responses are schemas too and not bare interfaces: `clinica-web` generates
 * its types from the OpenAPI document, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

const DIAGNOSIS_CERTAINTY = z.enum(['PRESUMPTIVE', 'DEFINITIVE']);
const DIAGNOSIS_OCCURRENCE = z.enum(['FIRST_TIME', 'SUBSEQUENT']);
const CARE_MODALITY = z.enum(['MORBIDITY', 'PREVENTION']);

/**
 * An instant, with its offset stated — the same rule as everywhere else in
 * this module.
 *
 * `2026-09-14T08:00:00` with nothing after it means whatever the reader's
 * clock says, and every clinical date here resolves in `America/Guayaquil`.
 */
const instant = (label: string) =>
  z.iso.datetime({
    offset: true,
    error: `${label} debe incluir la fecha, la hora y su zona horaria`,
  });

/**
 * EN-040 to EN-049. Registering one diagnosis.
 *
 * ⚠️ THERE IS NO `cie10Code` FIELD, AND THAT IS EN-040. What travels is the
 * identifier of the CONCEPT — a specific version of a specific code in a
 * specific catalogue — because a free-text code produces `E119`, `E11.9` and
 * `E 11.9` as three different diseases and the monthly report counts them
 * separately. The code and its description come back FROZEN in the response,
 * copied from the concept by `trg_diagnosis_snapshot`.
 *
 * ⚠️ AND THERE IS NO `careModality` FIELD EITHER (EN-046). Prevention or
 * morbidity is a property of the code — Z00 to Z99 is prevention, everything
 * else is morbidity, per the instructivo p. 62 — so it is derived and served,
 * never typed. A box somebody fills in is a box that can contradict the code
 * sitting next to it.
 */
export const recordDiagnosisSchema = z.object({
  conceptId: z.uuid('Seleccione el diagnóstico en el catálogo CIE-10'),
  /**
   * EN-044. ⚠️ TWO VALUES WHERE THE INSTRUCTIVO HAS FOUR — presuntivo,
   * definitivo inicial, definitivo inicial confirmado por laboratorio y
   * definitivo control. `diagnosis_certainty` has two, so the contract offers
   * two; widening it is a change of the enum, and the cost of not doing it is
   * written on EN-044.
   */
  certainty: DIAGNOSIS_CERTAINTY,
  /**
   * EN-045. ASKED FOR PER DIAGNOSIS and never derived from the attention's own
   * `visitSequence`: a patient seen for hypertension — subsequent — who is
   * diagnosed with diabetes today — first time — is the ordinary case, and
   * deriving it reports zero new cases of diabetes for the month.
   */
  occurrence: DIAGNOSIS_OCCURRENCE,
  /**
   * EN-043, EN-047. The priority order, with the principal at 1.
   *
   * OPTIONAL, AND ABSENT MEANS «DETRÁS DEL ÚLTIMO». The first diagnosis of an
   * attention becomes the principal and the comorbidities queue behind it,
   * which is the consultation as it is actually typed. A required field would
   * ask for a number on every single diagnosis; the upper bound is the
   * `smallint` the column is, not a limit on how many diagnoses a person may
   * have (EN-047).
   */
  rank: z
    .number()
    .int('El orden del diagnóstico debe ser un número entero')
    .min(1, 'El orden del diagnóstico empieza en 1, que es el principal')
    .max(32767, 'El orden del diagnóstico es demasiado alto')
    .optional(),
  /**
   * EN-049. ⚠️ A STOPGAP AND IT IS DECLARED AS TAL. The list of codes of
   * obligatory epidemiological notification has to be a property of the
   * CONCEPT so the system sets the flag instead of the doctor's memory, and
   * there is no such column. Until there is, this is the only way the datum
   * exists at all — and a dengue nobody ticks is a dengue nobody notifies.
   */
  notifiable: z.boolean().optional(),
  note: z
    .string()
    .trim()
    .max(2000, 'La nota del diagnóstico no puede superar 2000 caracteres')
    .optional(),
});
/** Body of POST /encounters/:encounterId/diagnoses. */
export class RecordDiagnosisDto extends createZodDto(recordDiagnosisSchema) {}

/**
 * EN-050. Registering one procedure.
 *
 * ⚠️ THERE IS NO AMOUNT FIELD, IN EITHER DIRECTION (EN-051, D-049). The
 * Tarifario supplies the nomenclature and the code; what the clinic charges
 * comes from the price list of the attention's payer on the service date, and
 * lives in `charge_item`, which belongs to `billing`. A price accepted here
 * would be a clinical row deciding an economic fact, and the two are separate
 * records on purpose: the act does not change because the patient did not pay.
 */
export const recordProcedureSchema = z.object({
  conceptId: z.uuid('Seleccione el procedimiento en el tarifario'),
  /**
   * EN-050. How many times it was performed, which is columns 95 to 100 of the
   * form: «por cada procedimiento se genera una o más actividades las cuales
   * debe registrar la cantidad realizada» — two extractions in one visit is
   * the instructivo's own example.
   */
  quantity: z
    .number()
    .int('La cantidad debe ser un número entero')
    .min(1, 'La cantidad tiene que ser al menos 1')
    .max(32767, 'La cantidad es demasiado alta')
    .default(1),
  /** EN-034. WHEN it was performed, not when it was typed. Absent means «ahora». */
  performedAt: instant('La hora del procedimiento').optional(),
  note: z
    .string()
    .trim()
    .max(2000, 'La nota del procedimiento no puede superar 2000 caracteres')
    .optional(),
});
/** Body of POST /encounters/:encounterId/procedures. */
export class RecordProcedureDto extends createZodDto(recordProcedureSchema) {}

/** One diagnosis as a client reads it. */
export const diagnosisSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  conceptId: z.uuid(),
  /**
   * EN-041. The code and the description AS THEY WERE the day the diagnosis
   * was made, kept in step with the concept by `trg_diagnosis_snapshot`. In
   * fifteen years the catalogue may have been migrated, pruned or reloaded and
   * the record still has to say what was diagnosed.
   */
  cie10Code: z.string(),
  cie10Display: z.string(),
  certainty: DIAGNOSIS_CERTAINTY,
  occurrence: DIAGNOSIS_OCCURRENCE,
  /** EN-043. 1 is the principal, and an attention has at most one. */
  rank: z.number().int(),
  /**
   * EN-046. Derived from the frozen code and served so no client derives it
   * differently — this is columns 84 and 85 of the monthly report.
   */
  careModality: CARE_MODALITY,
  notifiable: z.boolean(),
  note: z.string().nullable(),
  recordedAt: z.iso.datetime(),
});
/** Response of recording a diagnosis. */
export class DiagnosisDto extends createZodDto(diagnosisSchema) {}

export const diagnosisListSchema = z.object({
  items: z.array(diagnosisSchema),
});
/** Response of GET /encounters/:encounterId/diagnoses. */
export class DiagnosisListDto extends createZodDto(diagnosisListSchema) {}

/** One procedure as a client reads it. NO AMOUNT (EN-051). */
export const procedureSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  conceptId: z.uuid(),
  /** EN-050. Frozen when it was performed, for the same reason as the diagnosis. */
  procedureCode: z.string(),
  procedureDisplay: z.string(),
  quantity: z.number().int(),
  performedAt: z.iso.datetime(),
  note: z.string().nullable(),
});
/** Response of recording a procedure. */
export class ProcedureDto extends createZodDto(procedureSchema) {}

export const procedureListSchema = z.object({
  items: z.array(procedureSchema),
});
/** Response of GET /encounters/:encounterId/procedures. */
export class ProcedureListDto extends createZodDto(procedureListSchema) {}

/** Response types the controller returns, inferred from the schemas Swagger publishes. */
export type DiagnosisResponse = z.infer<typeof diagnosisSchema>;
export type DiagnosisListResponse = z.infer<typeof diagnosisListSchema>;
export type ProcedureResponse = z.infer<typeof procedureSchema>;
export type ProcedureListResponse = z.infer<typeof procedureListSchema>;
