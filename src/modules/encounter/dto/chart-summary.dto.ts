import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  activeAllergySchema,
  noKnownAllergiesSchema,
} from './patient-allergy.dto';
import { historySchema } from './patient-history.dto';

/**
 * EN-159 to EN-161. The patient's history, as it is read DURING the
 * consultation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE IS THE REQUIREMENT, AND IT IS ORDERED BY WHAT KILLS FIRST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `allergies` comes first in this contract because it is the field that
 * changes what the doctor does in the next thirty seconds. Then the previous
 * attentions, each with its diagnoses and its vital signs — which is the order
 * §7 bis of `FLUJO-DE-LA-ATENCION.md` records clinicians asking for.
 *
 * ⚠️ AND WHAT IS ABSENT IS AS DELIBERATE AS WHAT IS PRESENT. No note text
 * (EN-160): 46% of a clinical note today is copied and 36% imported, and each
 * 1% of imported text adds 1,5% of length. This payload carries identifiers
 * and structured values; the note is opened through its own route. The
 * antecedentes travel as structured entries (EN-085), live ones only. No
 * prescriptions: they belong to `prescription`, and
 * they arrive here the way the allergies do — through a shared port.
 */

const CARE_MODALITY = z.enum(['MORBIDITY', 'PREVENTION']);
const CARE_SETTING = z.enum(['INTRAMURAL', 'EXTRAMURAL']);
const VISIT_SEQUENCE = z.enum(['FIRST_TIME', 'SUBSEQUENT']);
const DIAGNOSIS_CERTAINTY = z.enum(['PRESUMPTIVE', 'DEFINITIVE']);
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
  'DECEASED',
  'REFERRED',
  'ABANDONED',
]);

/** EN-041, EN-043. One diagnosis of a previous attention, principal first. */
export const summaryDiagnosisSchema = z.object({
  /**
   * EN-041. The code AS IT WAS FROZEN the day the diagnosis was made, never as
   * the catalogue reads it today.
   */
  cie10Code: z.string(),
  cie10Display: z.string(),
  certainty: DIAGNOSIS_CERTAINTY,
  /** EN-043. 1 is the principal; an attention has at most one. */
  rank: z.number().int(),
});

/**
 * EN-068. The five measurements a consultation looks back at.
 *
 * A SUBSET OF `VitalSignsDto`, and the ones it leaves out — the two
 * circumferences, the respiratory rate, the oxygen saturation — are one click
 * away at `GET /encounters/:id/vitals`. Ten numbers per row across five rows
 * is a dump; five is a trend somebody can actually see.
 */
export const summaryVitalsSchema = z.object({
  weightKg: z.number().nullable(),
  heightCm: z.number().nullable(),
  /** EN-061. Written by `trg_encounter_vitals_bmi`, never derived by a client. */
  bmi: z.number().nullable(),
  systolicBp: z.number().int().nullable(),
  diastolicBp: z.number().int().nullable(),
  temperatureC: z.number().nullable(),
  measuredAt: z.iso.datetime(),
});

/** EN-159. One previous attention, in the facts a consultation uses. */
export const previousEncounterSchema = z.object({
  /**
   * EN-160. THE LINK, which is what replaces pasting the note in here. The
   * whole attention is opened at `GET /encounters/:id`, which leaves its own
   * audit entry when somebody actually reads it.
   */
  id: z.uuid(),
  siteId: z.uuid(),
  startedAt: z.iso.datetime(),
  status: ENCOUNTER_STATUS,
  careModality: CARE_MODALITY,
  careSetting: CARE_SETTING,
  visitSequence: VISIT_SEQUENCE,
  dischargeCondition: DISCHARGE_CONDITION.nullable(),
  diagnoses: z.array(summaryDiagnosisSchema),
  /** `null` when nobody took the signs, which is itself an answer. */
  vitals: summaryVitalsSchema.nullable(),
});

export const chartSummarySchema = z.object({
  /** The attention the summary was read from; excluded from `previousEncounters`. */
  encounterId: z.uuid(),
  /** The chart asked about — the SURVIVING one, never an absorbed id. */
  patientId: z.uuid(),
  /**
   * EN-081, EN-159. The active allergies, worst first. FIRST FIELD ON PURPOSE.
   *
   * They travel here AND on `GET /encounters/:id`, and the duplication is the
   * requirement rather than an oversight: «una alergia que hay que ir a buscar
   * a otra pantalla no es visible de manera permanente».
   */
  allergies: z.array(activeAllergySchema),
  /**
   * EN-087. The standing «sin alergias conocidas», or `null`.
   *
   * ⚠️ IT IS WHAT TURNS TWO STATES INTO THREE, and the three are D-A-018:
   *
   *   - `allergies` con filas          → hay alergias registradas
   *   - vacío y esto presente          → «sin alergias conocidas (quién, cuándo)»
   *   - vacío y esto `null`            → «no se preguntó»
   *
   * `null` NUNCA SIGNIFICA «NO TIENE». Que la lista venga vacía y no haya
   * afirmación es exactamente «no lo sabemos», y una pantalla que lo pintara
   * como «ninguna» estaría afirmando por su cuenta lo que el estándar reserva a
   * una persona: «una afirmación positiva por parte de un usuario clínico, y no
   * una posición por defecto afirmada por un sistema informático a falta de
   * otra información».
   *
   * ⚠️ Y DEJA DE SERVIRSE EN CUANTO SE REGISTRA UNA ALERGIA POSTERIOR, aunque
   * después se refute. Afirmado en marzo, penicilina en abril, descartada en
   * mayo: la ficha vuelve a estar vacía y **nadie ha preguntado desde
   * entonces**. Mantener viva la afirmación de marzo sería el sistema
   * afirmándola por iniciativa propia.
   */
  noKnownAllergies: noKnownAllergiesSchema.nullable(),
  /**
   * EN-085. The personal and family history that has not been ruled out, of
   * the chart and the charts it absorbed. An empty list means «no consta
   * ninguno», which is what it says: there is no «sin antecedentes» assertion.
   */
  history: z.array(historySchema),
  /** EN-159. The previous attentions, newest first, bounded. */
  previousEncounters: z.array(previousEncounterSchema),
  /**
   * EN-159. How many attentions the chart has in all, within the caller's
   * scope.
   *
   * SERVED BESIDE THE BOUNDED LIST so a screen can say «5 de 23». A truncation
   * the reader cannot see is a history that quietly looks shorter than it is.
   */
  totalEncounters: z.number().int(),
});
/** Response of GET /encounters/:encounterId/chart-summary. */
export class ChartSummaryDto extends createZodDto(chartSummarySchema) {}

/** What the controller returns, and the type of one `previousEncounters` entry, inferred from the schemas. Nothing outside this file imports the second today. */
export type ChartSummaryResponse = z.infer<typeof chartSummarySchema>;
export type PreviousEncounterResponse = z.infer<typeof previousEncounterSchema>;
