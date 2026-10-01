import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { activeAllergySchema } from './patient-allergy.dto';

/**
 * The attention's contract, requests and responses.
 *
 * Responses are schemas too and not bare interfaces: `clinica-web` generates
 * its types from the OpenAPI document, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

const ENCOUNTER_STATUS = z.enum([
  'OPEN',
  'ON_HOLD',
  'DISCONTINUED',
  'DISCHARGED',
  'COMPLETED',
  'ENTERED_IN_ERROR',
]);

const DISCHARGE_CONDITION = z.enum([
  'ALIVE',
  'REFERRED',
  'DECEASED',
  'ABANDONED',
]);

const CARE_MODALITY = z.enum(['MORBIDITY', 'PREVENTION']);
const CARE_SETTING = z.enum(['INTRAMURAL', 'EXTRAMURAL']);
const VISIT_SEQUENCE = z.enum(['FIRST_TIME', 'SUBSEQUENT']);

/**
 * An instant, with its offset stated.
 *
 * THE OFFSET IS REQUIRED. `2026-09-14T08:00:00` with nothing after it means
 * whatever the reader's clock happens to say, and for an attention that is not
 * a five-hour cosmetic problem: `trg_encounter_freeze_age` resolves the
 * clinical date in `America/Guayaquil` from this very instant, so a start read
 * in the wrong zone moves a neonate's `age_days` by a whole day — which is how
 * the RDACAA classifies neonates (REQ-160).
 */
const instant = (label: string) =>
  z.iso.datetime({
    offset: true,
    error: `${label} debe incluir la fecha, la hora y su zona horaria`,
  });

/**
 * EN-003 to EN-008, EN-141. Opening an attention.
 *
 * ⚠️ THE SITE IS IN THE BODY AND THE ROUTE DECLARES `'query'` SITE SCOPE, which
 * is the opposite of what the agenda does. It is not an oversight: the agenda
 * is rooted at `agenda/sites/:siteId` because everything under it belongs to
 * one site's calendar, while an attention is addressed by its own identifier
 * for the rest of its life (`/encounters/:id`) and a URL that carried the site
 * as well would make the same attention reachable at two addresses. So the
 * HANDLER narrows with the caller's resolved scope, and
 * `route-authorisation.spec.ts` refuses any route that declares `'global'`
 * while taking a `siteId` in the body (D-023).
 */
export const openEncounterSchema = z.object({
  siteId: z.uuid('Seleccione la sede en la que se atiende'),
  practitionerId: z.uuid('Seleccione el profesional que atiende'),
  patientId: z.uuid('Seleccione el paciente que se atiende'),
  /**
   * EN-003. Absent on a walk-in, and that is half of outpatient care: forcing
   * an appointment to exist produces fictitious citas with falsified hours,
   * which is what destroys the inasistencia metric of AG-080.
   */
  agendaEntryId: z.uuid('Seleccione una cita válida').optional(),
  /**
   * EN-034. A DATUM and not `now()`. Art. 5 asks the history to be filled «de
   * forma simultánea a la atención, CUANDO SEA POSIBLE», and that clause is a
   * permission: the home visit and the network outage exist.
   */
  startedAt: instant('La hora de inicio de la atención'),
  careModality: CARE_MODALITY,
  careSetting: CARE_SETTING.default('INTRAMURAL'),
  /**
   * EN-007. ASKED FOR AND NEVER DERIVED. The ministry's definition is «por una
   * determinada enfermedad o acción de salud y en un determinado servicio», so
   * a patient with twenty previous attentions coming today for a new problem
   * is FIRST_TIME — and deriving it from the history would answer the opposite
   * in the commonest case there is (instructivo, p. 11).
   */
  visitSequence: VISIT_SEQUENCE,
});
/** Body of POST /encounters (`encounter:open`). */
export class OpenEncounterDto extends createZodDto(openEncounterSchema) {}

/**
 * EN-131, EN-144, EN-147. Closing the account.
 *
 * ⚠️ NO DISCHARGE CONDITION HERE, AND THAT IS THE DESIGN. It was stated when
 * the consultation note was signed (EN-138), which is the only moment at which
 * it is a clinical fact rather than a guess, and
 * `encounter_discharge_states_a_condition` already refused the discharge
 * without it. A field here would let the cashier restate a clinical outcome
 * the doctor had already declared — and the two would disagree.
 *
 * ⚠️ AND NO STATE FIELD EITHER. `PATCH /encounters/:id/status` would be
 * exactly the box EN-134 forbids: every state except this one is produced by
 * documenting something.
 */
export const closeEncounterSchema = z.object({
  /**
   * EN-147. Why somebody other than the author is closing it.
   *
   * OPTIONAL HERE AND OBLIGATORY THERE: the ordinary closure is done by the
   * practitioner who gave the attention and owes nobody an explanation, so a
   * required field would ask for typing on every single closure. When it IS
   * somebody else, the service refuses without it
   * (`SUBSTITUTE_CLOSURE_REASON_REQUIRED`) and
   * `encounter_substitute_closure_states_reason` refuses it a second time.
   */
  substituteReason: z
    .string()
    .trim()
    .max(500, 'El motivo no puede superar 500 caracteres')
    .optional(),
});
/** Body of POST /encounters/:id/close. */
export class CloseEncounterDto extends createZodDto(closeEncounterSchema) {}

/**
 * EN-166 (D-077). Body of POST /encounters/:id/enter-in-error.
 *
 * The reason is OPTIONAL in the schema and obligatory in the service, like
 * the amendment: the refusal then comes as one field error with the sentence
 * of the domain, and not as a Zod message nobody wrote for this case.
 */
export const annulEncounterSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'El motivo no puede superar 500 caracteres')
    .optional(),
});
export class AnnulEncounterDto extends createZodDto(annulEncounterSchema) {}

/** EN-167 (D-076, D-082). Body of POST /encounters/:id/discontinue. */
export const discontinueEncounterSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'El motivo no puede superar 500 caracteres')
    .optional(),
  /** EN-129. Where the interruption came from; obligatory in the service. */
  origin: z.enum(['PATIENT', 'ESTABLISHMENT']).optional(),
});
export class DiscontinueEncounterDto extends createZodDto(
  discontinueEncounterSchema,
) {}

/**
 * EN-015, EN-162. One PAGE of a chart's attentions, absorbed charts included.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ SE PAGINA, Y POR QUÉ CORTAR EN EL CLIENTE NO ERA PAGINAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La ruta devolvía la historia entera y la ficha del paciente se traía las
 * ciento treinta y siete atenciones para pintar veinte. Eso reduce lo que el
 * navegador dibuja, **no lo que viaja por la red**, y el paciente crónico de
 * diez años es exactamente el caso que lo rompe.
 *
 * `page`/`pageSize` Y NO UNA TERCERA FORMA. Es la misma pareja que el registro
 * de pacientes y el árbol de catálogos ya publican, con el mismo `total` al
 * lado en la respuesta: un cliente que ya sabe paginar una lista de este
 * sistema sabe paginar ésta.
 */
export const chartHistoryQuerySchema = z.object({
  patientId: z.uuid('Seleccione el paciente cuya historia quiere ver'),
  page: z.coerce.number().int().min(1).default(1),
  /**
   * Acotado a 50, como el registro de pacientes y no como el catálogo.
   *
   * La historia de una persona **crece sin final** —es la lista que motiva
   * esto—, así que el tope es el bajo. Un nivel de un catálogo es una lista
   * cerrada y corta y por eso llega a 500; aquí un tope alto sería volver a
   * ofrecer «tráemelas todas» con otro nombre.
   */
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
/** Query of GET /encounters. */
export class ChartHistoryQueryDto extends createZodDto(
  chartHistoryQuerySchema,
) {}

/** EN-146. The attentions one practitioner has not closed. */
export const openEncountersQuerySchema = z.object({
  /** Absent means «todas las de mi alcance», which is what a supervisor reads. */
  practitionerId: z.uuid('Seleccione un profesional de la lista').optional(),
});
/** Query of GET /encounters/open. */
export class OpenEncountersQueryDto extends createZodDto(
  openEncountersQuerySchema,
) {}

/**
 * EN-060 to EN-063, EN-066. Block D — form **020**.
 *
 * ⚠️ THE UNITS ARE IN THE FIELD NAMES ON PURPOSE. `weightKg` and not `weight`:
 * the column is `Decimal(6,3)` in kilograms and `encounter_vitals_ranges_*`
 * refuses anything outside 0,3–400, so a client sending grams would be refused
 * for a reason nobody could read off the field name.
 *
 * ⚠️ AND THERE IS NO `bmi` FIELD. EN-061 says the system computes it and it is
 * never typed; a body that carries one is REFUSED and not ignored
 * (`BMI_IS_DERIVED`), because dropping it silently would leave the caller
 * believing the figure they typed is the one in the record. It is caught in
 * the service rather than declared here as a forbidden key, so the refusal
 * carries the code the SPEC's table names instead of a generic
 * `VALIDATION_FAILED`.
 *
 * ⚠️ THE PHYSIOLOGICAL RANGES ARE NOT REPEATED HERE. `encounter_vitals_ranges_*`
 * owns them and they are deliberately wide — the goal is to catch the finger
 * that typed 750 instead of 75, not to argue physiology with the clinic. A
 * copy in the DTO would be a second, stricter rule that refuses readings the
 * database accepts. What the schema does refuse is what is not a measurement
 * at all: a negative weight, a text where a number goes.
 */
export const recordVitalsSchema = z
  .object({
    weightKg: z.number().positive('El peso debe ser un número positivo').optional(), // prettier-ignore
    heightCm: z.number().positive('La talla debe ser un número positivo').optional(), // prettier-ignore
    headCircumferenceCm: z.number().positive('El perímetro cefálico debe ser un número positivo').optional(), // prettier-ignore
    abdominalCircumferenceCm: z.number().positive('El perímetro abdominal debe ser un número positivo').optional(), // prettier-ignore
    systolicBp: z.number().int().positive('La tensión sistólica debe ser un número entero positivo').optional(), // prettier-ignore
    diastolicBp: z.number().int().positive('La tensión diastólica debe ser un número entero positivo').optional(), // prettier-ignore
    heartRate: z.number().int().positive('La frecuencia cardiaca debe ser un número entero positivo').optional(), // prettier-ignore
    respiratoryRate: z.number().int().positive('La frecuencia respiratoria debe ser un número entero positivo').optional(), // prettier-ignore
    temperatureC: z.number().positive('La temperatura debe ser un número positivo').optional(), // prettier-ignore
    oxygenSaturation: z.number().int().positive('La saturación debe ser un número entero positivo').optional(), // prettier-ignore
    /** EN-064. Mandatory with a height; the database refuses one without the other. */
    heightPosition: z.enum(['STANDING', 'LYING']).optional(),
    /** EN-065. g/dl, both typed; ranges are the database's (D-058). */
    hemoglobinGDl: z.number().positive('La hemoglobina debe ser un número positivo').optional(), // prettier-ignore
    hemoglobinCorrectedGDl: z.number().positive('La hemoglobina corregida debe ser un número positivo').optional(), // prettier-ignore
    /** EN-163. The reason in the patient's own words, trimmed; blank is absent. */
    presentingComplaint: z
      .string()
      .trim()
      .max(500, 'El motivo no puede superar 500 caracteres')
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
    /**
     * EN-060. WHEN the measurement was taken, which is not when it was typed.
     * Absent means «ahora», which is the ordinary case at the bedside.
     */
    measuredAt: instant('La hora de la toma').optional(),
  })
  /**
   * EN-061. `passthrough` so a `bmi` in the body SURVIVES validation and
   * reaches the service, which refuses it with the code the requirement names.
   * Stripping it here — the default — would make the request succeed silently
   * with the figure dropped, which is the outcome `BmiIsDerivedError` exists
   * to prevent.
   */
  .catchall(z.unknown());
/** Body of PUT /encounters/:id/vitals. */
export class RecordVitalsDto extends createZodDto(recordVitalsSchema) {}

/**
 * The attention as a client reads it.
 *
 * ⚠️ NO PATIENT NAME AND NO CLINICAL CONTENT (EN-124, SC-016). Identifiers,
 * instants, the state and the frozen age. The name is asked of the patient
 * register, and THAT request is the one that leaves an audit row — joining it
 * in here would make every listing an undocumented read of forty charts.
 */
export const encounterSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  practitionerId: z.uuid(),
  patientId: z.uuid(),
  /** `null` on a walk-in (EN-003). */
  agendaEntryId: z.uuid().nullable(),
  startedAt: z.iso.datetime(),
  /** EN-126. Present exactly on the four states that ended the act. */
  endedAt: z.iso.datetime().nullable(),
  status: ENCOUNTER_STATUS,
  careModality: CARE_MODALITY,
  careSetting: CARE_SETTING,
  visitSequence: VISIT_SEQUENCE,
  /**
   * EN-008, REQ-027, REQ-160. The age the patient HAD that day, in the three
   * units the RDACAA classifies by, written once by
   * `trg_encounter_freeze_age` and never recomputed.
   *
   * SERVED AS THREE NUMBERS AND NOT AS A BIRTH DATE: publishing the birth date
   * would let every client compute a different age from the one in the row,
   * and the row is what the monthly report is composed from.
   */
  ageYears: z.number().int().nullable(),
  ageMonths: z.number().int().nullable(),
  ageDays: z.number().int().nullable(),
  dischargeCondition: DISCHARGE_CONDITION.nullable(),
  /**
   * EN-131, EN-147. Who settled the account and when — and, when it was not
   * the attending practitioner, why.
   *
   * THE CONSTANCIA TRAVELS IN EVERY RESPONSE, not only on the substituted
   * ones: a field that appears sometimes is a field clients forget to read,
   * and this one exists so a closure by somebody else cannot be mistaken
   * twelve months later for one by the doctor who attended.
   */
  closedById: z.uuid().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedBySubstituteReason: z.string().nullable(),
  /** EN-166. Why and when it was annulled; `null` unless `ENTERED_IN_ERROR`. */
  annulment: z.object({ reason: z.string(), at: z.iso.datetime() }).nullable(),
  /** EN-167. Why, from where and when it was interrupted; `null` unless `DISCONTINUED`. */
  interruption: z
    .object({
      reason: z.string(),
      origin: z.enum(['PATIENT', 'ESTABLISHMENT']),
      at: z.iso.datetime(),
    })
    .nullable(),
});
/** Response of opening and closing an attention, and of POST /encounters/:id/vitals/start (EN-135). */
export class EncounterDto extends createZodDto(encounterSchema) {}

export const encounterListSchema = z.object({
  items: z.array(encounterSchema),
});
/** Response of GET /encounters/open. */
export class EncounterListDto extends createZodDto(encounterListSchema) {}

/**
 * EN-162. Una página de la historia de una ficha, con cuántas hay en total.
 *
 * ⚠️ EL `total` ES LA MITAD QUE HACE LEGIBLE LA PÁGINA. Sin él, una pantalla
 * que enseña veinte no puede distinguir «son veinte» de «son las veinte
 * primeras de ciento treinta y siete», y la única manera de averiguarlo es
 * pedirlas todas — que es justo lo que la paginación existe para evitar.
 *
 * ⚠️ LOS ELEMENTOS SIGUEN SIENDO `encounterSchema`, SIN CONTENIDO CLÍNICO
 * (EN-123, EN-124). Este listado lo abre cualquiera con `record:read` sobre la
 * sede y **no deja fila de bitácora**, así que un diagnóstico, una nota o unos
 * signos aquí convertirían cada apertura de la pantalla en la lectura de
 * cuarenta historias sin rastro. Paginar cambia cuántos identificadores viajan
 * y nada más.
 *
 * MISMA FORMA QUE `PatientPageDto` Y `CatalogPageDto`: `items`, `total`,
 * `page`, `pageSize`. Una tercera forma de la misma respuesta es una tercera
 * cosa que cada cliente tiene que aprender.
 */
export const encounterPageSchema = z.object({
  items: z.array(encounterSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
/** Response of GET /encounters. */
export class EncounterPageDto extends createZodDto(encounterPageSchema) {}

/**
 * EN-081. The attention as it is OPENED, with the allergies already on board.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE ALLERGIES TRAVEL HERE AND NOT IN A CALL OF THEIR OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is the literal half of REQ-008: «de forma visible **de manera permanente
 * durante la consulta**». An allergy that has to be fetched from another
 * screen is not permanently visible, and what a doctor in a hurry does not see
 * does not exist. Carrying them in the opening is also what makes it
 * impossible for a screen to forget to ask.
 *
 * ⚠️ AND IT IS A SHAPE OF ITS OWN, NOT `encounterSchema` WITH A FIELD ADDED.
 * `encounterSchema` is what the LISTING serves, and the listing is opened by
 * everybody holding `record:read` over the site and leaves NO audit row
 * (EN-123, EN-124). An allergy is clinical content, so it must never travel in
 * it — the split is the requirement, not tidiness.
 *
 * ⚠️ NOR DOES IT ANSWER `POST /encounters`. Opening an attention takes
 * `encounter:open`, which admissions holds and which authorises no clinical
 * reading at all (EN-141). Serving allergies on the creation would hand a
 * health datum to the front desk as a side effect of registering a visit.
 */
export const encounterDetailSchema = encounterSchema.extend({
  /** EN-081. The unrefuted ones, worst first. Never the refuted ones. */
  allergies: z.array(activeAllergySchema),
});
/** Response of GET /encounters/:id. */
export class EncounterDetailDto extends createZodDto(encounterDetailSchema) {}

/**
 * Block D as a client reads it.
 *
 * `bmi` IS SERVED AND IS NEVER ACCEPTED (EN-061): what comes back is the
 * number `trg_encounter_vitals_bmi` computed, so a screen shows the figure
 * that is actually stored rather than one it derived itself — and the two
 * cannot disagree.
 */
export const vitalSignsSchema = z.object({
  encounterId: z.uuid(),
  weightKg: z.number().nullable(),
  heightCm: z.number().nullable(),
  headCircumferenceCm: z.number().nullable(),
  abdominalCircumferenceCm: z.number().nullable(),
  /** Computed by the database. `null` while weight or height is missing. */
  bmi: z.number().nullable(),
  systolicBp: z.number().int().nullable(),
  diastolicBp: z.number().int().nullable(),
  heartRate: z.number().int().nullable(),
  respiratoryRate: z.number().int().nullable(),
  temperatureC: z.number().nullable(),
  oxygenSaturation: z.number().int().nullable(),
  heightPosition: z.enum(['STANDING', 'LYING']).nullable(),
  hemoglobinGDl: z.number().nullable(),
  hemoglobinCorrectedGDl: z.number().nullable(),
  /** EN-163. Clinical content: served here and never in a listing. */
  presentingComplaint: z.string().nullable(),
  measuredAt: z.iso.datetime(),
  /** EN-143. Who took this reading; `null` only for takings older than the column. */
  recordedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** EN-143. Who corrected it last, and when; a correction is not a taking. */
  correctedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  correctedAt: z.iso.datetime().nullable(),
});
/** Response of reading and recording block D. */
export class VitalSignsDto extends createZodDto(vitalSignsSchema) {}

/** Response types the controller returns, inferred from the schemas Swagger publishes. */
export type EncounterResponse = z.infer<typeof encounterSchema>;
export type EncounterDetailResponse = z.infer<typeof encounterDetailSchema>;
export type EncounterListResponse = z.infer<typeof encounterListSchema>;
export type EncounterPageResponse = z.infer<typeof encounterPageSchema>;
export type VitalSignsResponse = z.infer<typeof vitalSignsSchema>;
