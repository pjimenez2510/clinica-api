import { withDoubts, type HeardWord } from './heard-doubts';
import { interpretDictation, type VitalField } from './vitals-dictation';

/**
 * AS-180. The readings of a taking a dictation can propose, by the name the
 * taking gives them (`encounter_vitals`).
 */
export type DictatedVitalField =
  | 'systolicBp'
  | 'diastolicBp'
  | 'heartRate'
  | 'respiratoryRate'
  | 'temperatureC'
  | 'oxygenSaturation'
  | 'weightKg'
  | 'heightCm';

/** A proposal for the form, never a taking: nothing of it is stored (AS-184). */
export interface DictatedVitals {
  signs: Partial<Record<DictatedVitalField, number>>;
  /** Named aloud but not read with certainty: the screen asks for them by hand (AS-182). */
  unclear: DictatedVitalField[];
}

/**
 * AS-183. The taking keeps one temperature and form 020 does not say where it
 * was taken, so SigmAI's oral and axillary land in the same field.
 */
const FIELD_OF: Readonly<Record<VitalField, DictatedVitalField>> = {
  systolic: 'systolicBp',
  diastolic: 'diastolicBp',
  heartRate: 'heartRate',
  respiratoryRate: 'respiratoryRate',
  temperatureC: 'temperatureC',
  temperatureAxillaryC: 'temperatureC',
  oxygenSaturation: 'oxygenSaturation',
  weightKg: 'weightKg',
  heightCm: 'heightCm',
};

/**
 * AS-180 to AS-183. SigmAI's reading, untouched, in the fields of the taking.
 * The one function the route and the evaluation harness both use.
 *
 * Two of SigmAI's fields share a field here: if they disagree, or one of them
 * was in doubt, the temperature is in doubt — the rule SigmAI applies to the
 * same field said twice.
 */
export function readDictatedVitals(text: string): DictatedVitals {
  const read = interpretDictation(text);
  const unclear = new Set(read.unclear.map((field) => FIELD_OF[field]));
  const values = new Map<DictatedVitalField, number>();

  for (const [field, value] of Object.entries(read.signs) as [
    VitalField,
    number,
  ][]) {
    const target = FIELD_OF[field];
    const before = values.get(target);
    if (before !== undefined && before !== value) unclear.add(target);
    values.set(target, value);
  }

  const signs: DictatedVitals['signs'] = {};
  for (const [field, value] of values) {
    if (!unclear.has(field)) signs[field] = value;
  }
  return { signs, unclear: [...unclear] };
}

/**
 * AS-197. Below this probability a token of the dictation is a doubt. Chosen
 * on the development set (`eval/casos/signos-dictados.json`) and checked on
 * the reserved one, which never moved it (SC-095, SC-096; D-255 §7).
 */
export const MIN_WORD_PROBABILITY = 0.75;

/**
 * AS-180 to AS-183, AS-197. What `clinica-ai` heard, read: the tokens it was
 * unsure of are doubts first. The one function the route and the harness use.
 */
export function readHeard(
  heard: { text: string; words: readonly HeardWord[] },
  minProbability = MIN_WORD_PROBABILITY,
): DictatedVitals {
  return readDictatedVitals(
    withDoubts(heard.text, heard.words, minProbability),
  );
}
