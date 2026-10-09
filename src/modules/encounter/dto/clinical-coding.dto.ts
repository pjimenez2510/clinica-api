import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CONSENT_EXCEPTION_KINDS,
  CONSENT_SIGNERS,
  REFUSAL_SIGNERS,
  REPRESENTATIVE_RELATIONSHIPS,
} from '../domain/procedure-consent';
import { CARE_PLACE } from './encounter.dto';

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
/** EN-007. First-time or subsequent, at this establishment. */
const VISIT_SEQUENCE = z.enum(['FIRST_TIME', 'SUBSEQUENT']);

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

/** EN-152 to EN-154. Who signs for the patient: name and relationship. */
const representativeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Indique el nombre del representante')
    .max(240, 'El nombre admite hasta 240 caracteres'),
  relationship: z.enum(REPRESENTATIVE_RELATIONSHIPS, {
    error: 'Elija el parentesco del representante',
  }),
  document: z
    .string()
    .trim()
    .max(20, 'El documento admite hasta 20 caracteres')
    .nullish(),
});

/**
 * EN-152 (D-159.2, .3). The form 024 that travels with the procedure: who
 * signed the paper and when, or the exception with its written ground.
 */
export const procedureConsentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('SIGNED'),
    signer: z.enum(CONSENT_SIGNERS, {
      error: 'Indique si firmó el paciente o su representante',
    }),
    representative: representativeSchema.nullish(),
    /** Absent means «ahora». Never after the procedure (EN-152). */
    signedAt: instant('La hora de la firma').optional(),
  }),
  z.object({
    kind: z.literal('EXCEPTION'),
    exceptionKind: z.enum(CONSENT_EXCEPTION_KINDS, {
      error: 'Elija si fue una emergencia o un procedimiento inesperado',
    }),
    reason: z
      .string()
      .trim()
      .min(1, 'Escriba el fundamento de la excepción')
      .max(1000, 'El fundamento admite hasta 1000 caracteres'),
  }),
]);

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
  /** EN-152. Only when the concept's service demands the 024 (EN-151). */
  consent: procedureConsentSchema.optional(),
});
/** Body of POST /encounters/:encounterId/procedures. */
export class RecordProcedureDto extends createZodDto(recordProcedureSchema) {}

/**
 * EN-244 (D-127). Correcting a procedure in place: its tariff concept, how
 * many times, its note. Only what is present changes; at least one thing has
 * to. `note: null` (or blank) clears it.
 */
export const editProcedureSchema = z
  .object({
    conceptId: z.uuid('Seleccione el procedimiento en el tarifario').optional(),
    quantity: z
      .number()
      .int('La cantidad debe ser un número entero')
      .min(1, 'La cantidad tiene que ser al menos 1')
      .max(32767, 'La cantidad es demasiado alta')
      .optional(),
    note: z
      .string()
      .trim()
      .max(2000, 'La nota del procedimiento no puede superar 2000 caracteres')
      .nullable()
      .optional(),
  })
  // A typed `procedureCode` would be dropped in silence: UNKNOWN_FIELD.
  .strict()
  .refine(
    (edit) =>
      edit.conceptId !== undefined ||
      edit.quantity !== undefined ||
      edit.note !== undefined,
    { message: 'Indique qué cambia del procedimiento' },
  );
/** Body of PATCH /encounters/:encounterId/procedures/:procedureId. */
export class EditProcedureDto extends createZodDto(editProcedureSchema) {}

/**
 * EN-245 (D-194.2). Removing a procedure states why. Optional in the transport
 * so the refusal is the domain's, by field (`PROCEDURE_RETRACTION_REASON_REQUIRED`).
 */
export const retractProcedureSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'El motivo no puede superar 500 caracteres')
    .optional(),
});
/** Body of POST /encounters/:encounterId/procedures/:procedureId/retract. */
export class RetractProcedureDto extends createZodDto(retractProcedureSchema) {}

/** EN-152. `?conceptId=` of the screen's question «¿exige el 024?». */
export const consentRequirementQuerySchema = z.object({
  conceptId: z.uuid('Seleccione el procedimiento en el tarifario'),
});
export class ConsentRequirementQueryDto extends createZodDto(
  consentRequirementQuerySchema,
) {}

/** EN-152. The answer: whether its service carries the 024 mark. */
export const consentRequirementSchema = z.object({ required: z.boolean() });
export class ConsentRequirementDto extends createZodDto(
  consentRequirementSchema,
) {}

/**
 * EN-153 (D-159.4). The refusal of an intervention: who refused, or — when
 * nobody signs — the external witness with their document.
 */
export const recordRefusalSchema = z.object({
  conceptId: z.uuid('Seleccione el procedimiento en el tarifario'),
  signer: z.enum(REFUSAL_SIGNERS, {
    error: 'Indique quién firmó la negativa, o que no firmó nadie',
  }),
  representative: representativeSchema.nullish(),
  witness: z
    .object({
      name: z
        .string()
        .trim()
        .min(1, 'Indique el nombre del testigo')
        .max(240, 'El nombre admite hasta 240 caracteres'),
      document: z
        .string()
        .trim()
        .min(1, 'Indique el documento del testigo')
        .max(20, 'El documento admite hasta 20 caracteres'),
    })
    .nullish(),
  // No instant travels: the refusal is recorded when it is expressed, with
  // the application's clock (a refusal «in the future» or years old is not
  // something the screen ever needs to say).
});
/** Body of POST /encounters/:encounterId/procedure-refusals. */
export class RecordRefusalDto extends createZodDto(recordRefusalSchema) {}

/** EN-154. Who expresses the revocation. */
export const revokeConsentSchema = z.object({
  signer: z.enum(CONSENT_SIGNERS, {
    error: 'Indique si revoca el paciente o su representante',
  }),
  representative: representativeSchema.nullish(),
});
/** Body of POST /encounters/:encounterId/procedure-consents/:consentId/revoke. */
export class RevokeConsentDto extends createZodDto(revokeConsentSchema) {}

/**
 * EN-180, EN-213, EN-214. Removing a diagnosis. The reason is optional here
 * and required by the service when an issued certificate or receta printed
 * the code: the transport cannot see the papers. On the screen it is chosen
 * from a list (D-126.3).
 */
export const retractDiagnosisSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'El motivo no puede superar 500 caracteres')
    .optional(),
});
/** Body of POST /encounters/:encounterId/diagnoses/:diagnosisId/retract. */
export class RetractDiagnosisDto extends createZodDto(retractDiagnosisSchema) {}

/**
 * EN-212 (D-127). Editing a diagnosis in place. Only what is present changes;
 * at least one thing has to.
 *
 * ⚠️ THE CODE CHANGES THROUGH `conceptId`, as on registering (EN-040): a typed
 * code is how `E119` and `E11.9` become two diseases.
 *
 * `reason` is optional here and owed by the service when the code changes and
 * a paper in a third party's hands printed the old one: the transport cannot
 * see the paper. On the screen it is chosen from a list (D-126.3).
 */
export const editDiagnosisSchema = z
  .object({
    conceptId: z
      .uuid('Seleccione el diagnóstico en el catálogo CIE-10')
      .optional(),
    certainty: DIAGNOSIS_CERTAINTY.optional(),
    occurrence: DIAGNOSIS_OCCURRENCE.optional(),
    /** `true` makes it the principal; `false` takes the principal off it. */
    primary: z.boolean().optional(),
    reason: z
      .string()
      .trim()
      .max(500, 'El motivo no puede superar 500 caracteres')
      .optional(),
  })
  // A typed `cie10Code` or a `rank` would be dropped in silence and the
  // caller would believe it changed: refused as UNKNOWN_FIELD instead.
  .strict()
  .refine(
    (edit) =>
      edit.conceptId !== undefined ||
      edit.certainty !== undefined ||
      edit.occurrence !== undefined ||
      edit.primary !== undefined,
    { message: 'Indique qué cambia del diagnóstico' },
  );
/** Body of PATCH /encounters/:encounterId/diagnoses/:diagnosisId. */
export class EditDiagnosisDto extends createZodDto(editDiagnosisSchema) {}

/**
 * EN-187, EN-215, EN-012, EN-013. Correcting the attention's own coding: what
 * the patient came for, whether it is first-time or subsequent, where it was
 * given and whether it is of the «Médico del Barrio» strategy. Only what
 * travels changes.
 */
export const correctEncounterCodingSchema = z
  .object({
    careModality: CARE_MODALITY.optional(),
    visitSequence: VISIT_SEQUENCE.optional(),
    carePlace: CARE_PLACE.optional(),
    medicoDelBarrio: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.careModality !== undefined ||
      body.visitSequence !== undefined ||
      body.carePlace !== undefined ||
      body.medicoDelBarrio !== undefined,
    { message: 'Indique qué corrige de la atención' },
  );
/** Body of PATCH /encounters/:encounterId. */
export class CorrectEncounterCodingDto extends createZodDto(
  correctEncounterCodingSchema,
) {}

/** EN-187, EN-215. The attention's coding after the correction. */
export const encounterCodingSchema = z.object({
  careModality: CARE_MODALITY,
  visitSequence: VISIT_SEQUENCE,
  /** EN-012. */
  carePlace: CARE_PLACE,
  /** EN-013. */
  medicoDelBarrio: z.boolean(),
});
/** Response of PATCH /encounters/:encounterId. */
export class EncounterCodingDto extends createZodDto(encounterCodingSchema) {}

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
  /**
   * EN-235 (D-147.3). `false` when its code is an asterisk or an external
   * cause of the WHO's list: it is never the principal, so the screen does
   * not offer «Marcar principal» for it.
   */
  mayBePrincipal: z.boolean(),
  note: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  /** EN-212. When it was last edited; `null` if never. */
  editedAt: z.iso.datetime().nullable(),
});
/** Response of recording a diagnosis. */
export class DiagnosisDto extends createZodDto(diagnosisSchema) {}

/** EN-180. A diagnosis taken off the attention, as the archive keeps it. */
export const retractedDiagnosisSchema = z.object({
  id: z.uuid(),
  cie10Code: z.string(),
  cie10Display: z.string(),
  rank: z.number().int(),
  retractedAt: z.iso.datetime(),
  retractedBy: z.object({ id: z.uuid(), name: z.string() }),
  reason: z.string().nullable(),
});

export const diagnosisListSchema = z.object({
  /**
   * EN-189. With whether an issued certificate printed the code, so removing
   * it asks for the reason before sending.
   */
  items: z.array(
    diagnosisSchema.extend({
      printedOnCertificate: z.boolean(),
      /** EN-214 (D-117.14). An issued receta printed the code. */
      printedOnPrescription: z.boolean(),
      /** ORD-121. An issued order printed the code. */
      printedOnOrder: z.boolean(),
    }),
  ),
  /** EN-180. What was removed, so the trace is in front of whoever reads. */
  retracted: z.array(retractedDiagnosisSchema),
});
/** Response of GET /encounters/:encounterId/diagnoses. */
export class DiagnosisListDto extends createZodDto(diagnosisListSchema) {}

/**
 * EN-212. The versions an edit replaced, most recent first: each as it was,
 * with who replaced it, when and — if the code changed while a paper printed
 * it — why.
 */
export const diagnosisVersionListSchema = z.object({
  items: z.array(
    z.object({
      version: z.number().int(),
      replacedBy: z.object({ id: z.uuid(), name: z.string() }),
      replacedAt: z.iso.datetime(),
      reason: z.string().nullable(),
      diagnosis: diagnosisSchema,
    }),
  ),
});
/** Response of GET /encounters/:encounterId/diagnoses/:diagnosisId/versions. */
export class DiagnosisVersionListDto extends createZodDto(
  diagnosisVersionListSchema,
) {}

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
  /** EN-244. When it was last corrected; `null` if never. */
  editedAt: z.iso.datetime().nullable(),
});
const personSchema = z.object({ id: z.uuid(), name: z.string() });
const representativeResponseSchema = z
  .object({
    name: z.string(),
    relationship: z.enum(REPRESENTATIVE_RELATIONSHIPS),
    document: z.string().nullable(),
  })
  .nullable();

/** EN-152, EN-154. The 024 of a procedure, with its revocation if any. */
export const procedureConsentResponseSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['SIGNED', 'EXCEPTION']),
  signer: z.enum(CONSENT_SIGNERS).nullable(),
  representative: representativeResponseSchema,
  exceptionKind: z.enum(CONSENT_EXCEPTION_KINDS).nullable(),
  exceptionReason: z.string().nullable(),
  informedBy: personSchema.nullable(),
  signedAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  recordedBy: personSchema,
  revocation: z
    .object({
      signer: z.enum(CONSENT_SIGNERS),
      representative: representativeResponseSchema,
      revokedAt: z.iso.datetime(),
      revokedBy: personSchema,
    })
    .nullable(),
});
/** Response of revoking a consent. */
export class ProcedureConsentDto extends createZodDto(
  procedureConsentResponseSchema,
) {}

/** EN-152. A procedure with the 024 that covers it, or `null`. */
export const recordedProcedureSchema = procedureSchema.extend({
  consent: procedureConsentResponseSchema.nullable(),
});
/** Response of recording, correcting or restoring a procedure. */
export class ProcedureDto extends createZodDto(recordedProcedureSchema) {}

/** EN-153. A refusal, with the intervention it refused. */
export const refusalSchema = z.object({
  id: z.uuid(),
  conceptId: z.uuid(),
  procedureCode: z.string(),
  procedureDisplay: z.string(),
  signer: z.enum(REFUSAL_SIGNERS),
  representative: representativeResponseSchema,
  witness: z.object({ name: z.string(), document: z.string() }).nullable(),
  informedBy: personSchema,
  refusedAt: z.iso.datetime(),
  recordedBy: personSchema,
});
/** Response of recording a refusal. */
export class RefusalDto extends createZodDto(refusalSchema) {}

/** EN-245. A procedure taken off the attention, as the archive keeps it. */
export const retractedProcedureSchema = z.object({
  id: z.uuid(),
  procedureCode: z.string(),
  procedureDisplay: z.string(),
  quantity: z.number().int(),
  retractedAt: z.iso.datetime(),
  retractedBy: z.object({ id: z.uuid(), name: z.string() }),
  reason: z.string(),
});

export const procedureListSchema = z.object({
  items: z.array(recordedProcedureSchema),
  /** EN-245. What was removed, folded on the screen, restorable while live. */
  retracted: z.array(retractedProcedureSchema),
  /** EN-153. The interventions the patient refused. */
  refusals: z.array(refusalSchema),
});
/** Response of GET /encounters/:encounterId/procedures. */
export class ProcedureListDto extends createZodDto(procedureListSchema) {}

/** EN-244. The versions a correction replaced, most recent first. */
export const procedureVersionListSchema = z.object({
  items: z.array(
    z.object({
      version: z.number().int(),
      replacedBy: z.object({ id: z.uuid(), name: z.string() }),
      replacedAt: z.iso.datetime(),
      procedure: procedureSchema,
    }),
  ),
});
/** Response of GET /encounters/:encounterId/procedures/:procedureId/versions. */
export class ProcedureVersionListDto extends createZodDto(
  procedureVersionListSchema,
) {}

/** Response types the controller returns, inferred from the schemas Swagger publishes. */
export type DiagnosisResponse = z.infer<typeof diagnosisSchema>;
export type DiagnosisListResponse = z.infer<typeof diagnosisListSchema>;
export type DiagnosisVersionListResponse = z.infer<
  typeof diagnosisVersionListSchema
>;
export type ProcedureResponse = z.infer<typeof procedureSchema>;
export type RecordedProcedureResponse = z.infer<typeof recordedProcedureSchema>;
export type ProcedureConsentResponse = z.infer<
  typeof procedureConsentResponseSchema
>;
export type RefusalResponse = z.infer<typeof refusalSchema>;
export type ProcedureListResponse = z.infer<typeof procedureListSchema>;
export type ProcedureVersionListResponse = z.infer<
  typeof procedureVersionListSchema
>;
