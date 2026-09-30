import type { AnalyteDefinition, ReferenceRange } from './analyte';

/**
 * The REAL catalogue rows, as `prisma/seed-billing.mts` writes them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FIXTURES ARE THE SEED AND NOT ROUND NUMBERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A test written against `low: 10, high: 20` proves the comparison operator
 * and nothing else. The seed carries the two shapes that actually decide
 * whether this module is correct — a range that DIFFERS BY SEX (`HB`:
 * 13,0–17,0 for `MALE`, 12,0–15,5 for `FEMALE`, which is the whole reason the
 * range is a table and not two columns) and a range that is CRITICAL (`GLU`:
 * below 40 or above 400, which is the A.M. 00002393 art. 39 net) — and a fixture
 * that rounded them would stop testing the case the clinic will actually meet.
 *
 * ⚠️ THEY LIVE IN A `.ts` AND NOT A `.spec.ts` BECAUSE TWO SUITES USE THEM: the
 * flag policy and the value coherence. A copy in each is two copies that drift,
 * and the one that drifts is the one nobody re-checks against the seed.
 *
 * IDS ARE FIXED STRINGS. A failing test has to be reproducible, and a random
 * uuid in a fixture is a failure that reads differently every run.
 */

/** A `REFERENCE` range with no age bounds; `sex` null applies to both. */
const reference = (
  sex: 'MALE' | 'FEMALE' | null,
  low: number | null,
  high: number | null,
  text: string | null = null,
): ReferenceRange => ({
  rangeKind: 'REFERENCE',
  sex,
  ageMinDays: null,
  ageMaxDays: null,
  low,
  high,
  text,
});

/**
 * `HB` — Hemoglobina. Two reference ranges and no critical one.
 *
 * THE CASE THAT JUSTIFIES THE WHOLE `analyte_reference_range` TABLE: with one
 * range for everybody, 12,5 g/dL would flag half the female population as
 * anaemic or none of the male one.
 */
export const HAEMOGLOBIN: AnalyteDefinition = {
  id: '00000000-0000-4000-8000-0000000000a1',
  code: 'HB',
  name: 'Hemoglobina',
  unit: 'g/dL',
  valueType: 'NUMERIC',
  decimals: 1,
  allowedValues: null,
  ranges: [reference('MALE', 13.0, 17.0), reference('FEMALE', 12.0, 15.5)],
};

/**
 * `GLU` — Glucosa en ayunas. One reference range for everybody AND a critical
 * one, which is the pair the flag policy exists for.
 */
export const GLUCOSE: AnalyteDefinition = {
  id: '00000000-0000-4000-8000-0000000000a2',
  code: 'GLU',
  name: 'Glucosa en ayunas',
  unit: 'mg/dL',
  valueType: 'NUMERIC',
  decimals: 0,
  allowedValues: null,
  ranges: [
    reference(null, 70, 100),
    {
      rangeKind: 'CRITICAL',
      sex: null,
      ageMinDays: null,
      ageMaxDays: null,
      low: 40,
      high: 400,
      text: 'Fuera de estos límites: aviso inmediato al médico tratante y constancia de la notificación.',
    },
  ],
};

/**
 * `EMO-NITRITOS` — coded, with a closed list of answers and a qualitative
 * reference. No unit, no bounds: this is the analyte that proves `value_type`
 * has to exist.
 */
export const NITRITES: AnalyteDefinition = {
  id: '00000000-0000-4000-8000-0000000000a3',
  code: 'EMO-NITRITOS',
  name: 'Nitritos',
  unit: null,
  valueType: 'CODED',
  decimals: null,
  allowedValues: ['Negativo', 'Positivo'],
  ranges: [reference(null, null, null, 'Negativo')],
};

/** A free-text analyte: «no growth at 48h» is a result and not a number. */
export const CULTURE: AnalyteDefinition = {
  id: '00000000-0000-4000-8000-0000000000a4',
  code: 'CULTIVO',
  name: 'Cultivo',
  unit: null,
  valueType: 'TEXT',
  decimals: null,
  allowedValues: null,
  ranges: [],
};
