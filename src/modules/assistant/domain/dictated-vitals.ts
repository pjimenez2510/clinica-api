import {
  interpretDictation,
  type DictationOptions,
  type HeightPosition,
  type VitalField,
} from './vitals-dictation';

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
  | 'heightCm'
  // AS-253 (B3).
  | 'headCircumferenceCm'
  | 'abdominalCircumferenceCm'
  | 'hemoglobinGDl'
  | 'hemoglobinCorrectedGDl';

/** A proposal for the form, never a taking: nothing of it is stored (AS-184). */
export interface DictatedVitals {
  signs: Partial<Record<DictatedVitalField, number>>;
  /** Named aloud but not read with certainty: the screen asks for them by hand (AS-182). */
  unclear: DictatedVitalField[];
  /** AS-253. How the height was taken, when a height was named and one way said. */
  heightPosition?: HeightPosition;
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
  headCircumferenceCm: 'headCircumferenceCm',
  abdominalCircumferenceCm: 'abdominalCircumferenceCm',
  hemoglobinGDl: 'hemoglobinGDl',
  hemoglobinCorrectedGDl: 'hemoglobinCorrectedGDl',
};

/**
 * AS-180 to AS-183. SigmAI's reading, untouched, in the fields of the taking.
 * The one function the route and the evaluation harness both use.
 *
 * Two of SigmAI's fields share a field here: if they disagree, or one of them
 * was in doubt, the temperature is in doubt — the rule SigmAI applies to the
 * same field said twice.
 */
export function readDictatedVitals(
  text: string,
  options: DictationOptions = {},
): DictatedVitals {
  const read = interpretDictation(text, options);
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
  const dictated: DictatedVitals = { signs, unclear: [...unclear] };
  if (read.heightPosition) dictated.heightPosition = read.heightPosition;
  return dictated;
}
