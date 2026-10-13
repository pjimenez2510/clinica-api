/**
 * B2 (AS-182). Copied as is from SigmAI (`sigmai-api` `modules/vitals/plausibility.ts`,
 * measured in E-055); only the type of the fields is written here, because SigmAI's came from
 * its own vitals module. Its bounds are slightly narrower than `encounter_vitals_ranges_*`
 * (D-058): what falls between the two is not proposed and is typed by hand (D-255 §4).
 */
export interface VitalSigns {
  weightKg: number | null;
  heightCm: number | null;
  temperatureC: number | null;
  temperatureAxillaryC: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  systolic: number | null;
  diastolic: number | null;
  /** AS-253 (B3). Not in SigmAI: the readings its nursing never dictated. */
  headCircumferenceCm: number | null;
  abdominalCircumferenceCm: number | null;
  hemoglobinGDl: number | null;
  hemoglobinCorrectedGDl: number | null;
}

export interface PlausibleRange {
  min: number;
  max: number;
  unit: string;
  label: string;
}

/**
 * What a person can physically measure, not what is clinically normal: the job here is to
 * catch a typo, never to judge the patient. A pressure of 210/130 is alarming and real, and
 * goes through. The clinic's own records hold a weight of 770 kg, an oxygen saturation of
 * 98 170 and a temperature of 366, because nothing ever checked (RF-D02).
 *
 * These bounds are the single place they are written: the wire schema is built from them, so
 * they travel to the browser in the published contract instead of being repeated there.
 */
export const PLAUSIBLE: Readonly<Record<keyof VitalSigns, PlausibleRange>> = {
  weightKg: { min: 0.5, max: 400, unit: 'kg', label: 'El peso' },
  heightCm: { min: 30, max: 250, unit: 'cm', label: 'La talla' },
  temperatureC: { min: 30, max: 45, unit: '°C', label: 'La temperatura bucal' },
  temperatureAxillaryC: {
    min: 30,
    max: 45,
    unit: '°C',
    label: 'La temperatura axilar',
  },
  heartRate: {
    min: 20,
    max: 300,
    unit: 'lpm',
    label: 'La frecuencia cardiaca',
  },
  respiratoryRate: {
    min: 4,
    max: 80,
    unit: 'rpm',
    label: 'La frecuencia respiratoria',
  },
  oxygenSaturation: {
    min: 50,
    max: 100,
    unit: '%',
    label: 'La saturación de oxígeno',
  },
  systolic: { min: 50, max: 300, unit: 'mmHg', label: 'La presión sistólica' },
  diastolic: {
    min: 20,
    max: 200,
    unit: 'mmHg',
    label: 'La presión diastólica',
  },
  // AS-248 (D-260 §4). SigmAI had no bounds for these: the database's
  // (`encounter_vitals_ranges_*`, D-058), never narrower ones made up here.
  headCircumferenceCm: {
    min: 20,
    max: 80,
    unit: 'cm',
    label: 'El perímetro cefálico',
  },
  abdominalCircumferenceCm: {
    min: 20,
    max: 250,
    unit: 'cm',
    label: 'El perímetro abdominal',
  },
  hemoglobinGDl: { min: 1, max: 25, unit: 'g/dl', label: 'La hemoglobina' },
  hemoglobinCorrectedGDl: {
    min: 1,
    max: 25,
    unit: 'g/dl',
    label: 'La hemoglobina corregida',
  },
};

export function outOfRangeMessage(field: keyof VitalSigns): string {
  const range = PLAUSIBLE[field];

  return `${range.label} debe estar entre ${range.min} y ${range.max} ${range.unit}.`;
}

export function isEmpty(signs: VitalSigns): boolean {
  return Object.values(signs).every(
    (value) => value === null || value === undefined,
  );
}
