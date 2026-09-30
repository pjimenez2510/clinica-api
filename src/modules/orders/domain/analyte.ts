/**
 * The RESULTABLE half of the module: what returns a value.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO CATALOGUES AND NOT ONE, AND IT IS THE DECISION THAT DECIDES EVERYTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Biometría hemática» is ONE line on the order and ONE line on the invoice,
 * and it returns six values, each with its own unit, its own reference range
 * by sex and age, and its own flag. Every standard separates the two — HL7 v2
 * puts them in different segments, LOINC classifies them with a field of its
 * own — and the MSP did too: form 010A is a closed list of «determinaciones»
 * ticked with an X, and form 010B reports DETERMINACIÓN · RESULTADO · UNIDAD
 * DE MEDIDA · VALOR DE REFERENCIA.
 *
 * This file is the RESULTABLE side (`analyte_definition`); `service-order.ts`
 * is the ORDERABLE side.
 */

/**
 * What kind of answer an analyte gives, as
 * `analyte_definition_value_type_is_known` enumerates it.
 *
 * FOUR AND NOT ONE because lab results are genuinely polymorphic: glucose is
 * 92, blood group is O+, a culture is «no growth at 48h». Forcing the coded
 * ones into a number would mean inventing a 0/1 encoding nobody could read on
 * the printed report — which is exactly what `EMO-NITRITOS` would need.
 */
export type AnalyteValueType = 'NUMERIC' | 'CODED' | 'TEXT' | 'ORDINAL';

/** The three kinds of range, as `analyte_reference_range_kind_is_known` says. */
export type RangeKind = 'REFERENCE' | 'CRITICAL' | 'ABSOLUTE';

/**
 * The flag, as the `abnormal_flag` enum has it.
 *
 * ⚠️ THERE IS NO PLAIN `ABNORMAL`, and the absence has a consequence this
 * module cannot fix on its own: see `abnormal-flag.ts`.
 */
export type AbnormalFlag =
  'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL_LOW' | 'CRITICAL_HIGH';

/** The patient sexes the chart records, as `patient_sex` has them. */
export type PatientSex = 'MALE' | 'FEMALE' | 'INTERSEX' | 'UNKNOWN';

/**
 * An analyte as this module needs to know it.
 *
 * NOT A ROW: `loinc_code` is deliberately absent. It is a SECONDARY code for
 * the twenty to sixty analytes worth the mapping effort, never the identity of
 * anything, and nothing in this module branches on it — a field that is never
 * loaded cannot be mistaken for a key.
 */
export interface AnalyteDefinition {
  id: string;
  /** `HB`, `GLU`, `EMO-NITRITOS`. The identity of the row. */
  code: string;
  name: string;
  /** UCUM. Present on every `NUMERIC` analyte, by CHECK constraint. */
  unit: string | null;
  valueType: AnalyteValueType;
  decimals: number | null;
  /** The answers a coded analyte admits: `['Negativo', 'Positivo']`. */
  allowedValues: readonly string[] | null;
  ranges: readonly ReferenceRange[];
}

/**
 * One reference range, qualified by sex and by age IN DAYS.
 *
 * DAYS AND NOT YEARS, and it is the schema's own comment: the ranges that
 * differ most are a neonate's, and a bilirubin range that changes on day three
 * cannot be expressed in years at all.
 *
 * `null` in `sex`, `ageMinDays` or `ageMaxDays` means «applies to everyone».
 */
export interface ReferenceRange {
  rangeKind: RangeKind;
  sex: PatientSex | null;
  ageMinDays: number | null;
  ageMaxDays: number | null;
  low: number | null;
  high: number | null;
  /** The qualitative ones, where there are no bounds to compare against. */
  text: string | null;
}

/**
 * ORD-036. Who the value belongs to, which is what makes a range applicable.
 *
 * `ageDays` is the age the patient HAD on the day of the attention, which is
 * the number `trg_encounter_freeze_age` writes and never recomputes. A range
 * resolved against today's age would reclassify a two-year-old result every
 * time somebody opened it.
 */
export interface PatientProfile {
  sex: PatientSex | null;
  ageDays: number | null;
}
