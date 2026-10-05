import { applicableRange, criticalBounds } from './abnormal-flag';
import type {
  AnalyteValueType,
  PatientProfile,
  PatientSex,
  ReferenceRange,
} from './analyte';
import {
  AnalyteDefinitionInvalidError,
  ReferenceRangeInvalidError,
  ReferenceRangeOverlapError,
} from './orders.errors';

/**
 * THE RULES OF THE EXAM CATALOGUE THAT NO CONSTRAINT CAN SEE (ORD-104 to
 * ORD-107).
 *
 * The database already refuses a numeric analyte without a unit
 * (`analyte_definition_numeric_carries_a_unit`), a range with its bounds
 * reversed (`analyte_reference_range_bounds_are_ordered`) and ages reversed
 * (`…_ages_are_ordered`). What it cannot see is what crosses two tables — a
 * numeric or critical range on an analyte that is not numeric — or two rows of
 * one table — two ranges ORD-036 could not choose between. Those are here,
 * pure, and named field by field so the screen can put each sentence under
 * the box that caused it.
 */

/** ORD-104. What an analyte is written with. */
export interface AnalyteDraft {
  valueType: AnalyteValueType;
  unit: string | null;
  decimals: number | null;
  allowedValues: readonly string[] | null;
}

/**
 * ORD-104. Unit, decimals and allowed values against the value type.
 *
 *  - NUMERIC carries a unit and no list; decimals between 0 and 4.
 *  - CODED and ORDINAL carry at least two distinct answers and no decimals.
 *  - TEXT carries neither a list nor decimals.
 */
export function assertAnalyteFitsItsType(analyte: AnalyteDraft): void {
  const fields: { field: string; message: string }[] = [];
  const list = analyte.allowedValues ?? [];
  const distinct = new Set(list.map((value) => value.trim().toLowerCase()));

  if (analyte.valueType === 'NUMERIC') {
    if (!analyte.unit?.trim()) {
      fields.push({ field: 'unit', message: 'Un valor numérico lleva unidad' });
    }
    if (list.length > 0) {
      fields.push({
        field: 'allowedValues',
        message: 'Un valor numérico no lleva lista de respuestas',
      });
    }
  } else {
    if (analyte.decimals !== null) {
      fields.push({
        field: 'decimals',
        message: 'Sólo un valor numérico lleva decimales',
      });
    }
  }

  if (analyte.valueType === 'CODED' || analyte.valueType === 'ORDINAL') {
    if (distinct.size < 2 || distinct.size !== list.length) {
      fields.push({
        field: 'allowedValues',
        message: 'Escriba al menos dos respuestas, sin repetir',
      });
    }
  }
  if (analyte.valueType === 'TEXT' && list.length > 0) {
    fields.push({
      field: 'allowedValues',
      message: 'Un texto libre no lleva lista de respuestas',
    });
  }

  if (fields.length > 0) throw new AnalyteDefinitionInvalidError(fields);
}

/**
 * ORD-106, ORD-107. A whole set of ranges for one analyte, as it will be
 * stored. Each refusal names its row (`ranges[2].low`).
 */
export function assertRangesHold(
  valueType: AnalyteValueType,
  ranges: readonly ReferenceRange[],
): void {
  const invalid: { field: string; message: string }[] = [];

  ranges.forEach((range, index) => {
    const at = (field: string) => `ranges[${index}].${field}`;
    const bounded = range.low !== null || range.high !== null;

    if (valueType === 'NUMERIC' && !bounded) {
      // A numeric range made of text alone never classifies anything: a
      // critical one would switch the alert off for whoever it is more
      // specific to (ORD-036 picks it over the general one).
      invalid.push({
        field: at('low'),
        message:
          'Un rango de una determinación numérica lleva al menos un límite',
      });
    } else if (!bounded && !range.text?.trim()) {
      invalid.push({ field: at('low'), message: 'Escriba un límite o un texto' }); // prettier-ignore
    }
    if (range.low !== null && range.high !== null && range.low > range.high) {
      invalid.push({
        field: at('high'),
        message: 'El límite superior no puede ser menor que el inferior',
      });
    }
    if (
      range.ageMinDays !== null &&
      range.ageMaxDays !== null &&
      range.ageMinDays > range.ageMaxDays
    ) {
      invalid.push({
        field: at('ageMaxDays'),
        message: 'La edad máxima no puede ser menor que la mínima',
      });
    }
    if (valueType !== 'NUMERIC' && bounded) {
      invalid.push({
        field: at('low'),
        message: 'Sólo una determinación numérica lleva límites',
      });
    }
    if (valueType !== 'NUMERIC' && range.rangeKind !== 'REFERENCE') {
      invalid.push({
        field: at('rangeKind'),
        message: 'Sólo una determinación numérica lleva rango crítico',
      });
    }
  });
  if (invalid.length > 0) throw new ReferenceRangeInvalidError(invalid);

  const overlaps: { field: string; message: string }[] = [];
  ranges.forEach((range, index) => {
    const earlier = ranges.findIndex(
      (other, otherIndex) => otherIndex < index && overlap(range, other),
    );
    if (earlier >= 0) {
      overlaps.push({
        field: `ranges[${index}].sex`,
        message: `Se pisa con la fila ${earlier + 1}: mismo tipo, mismo sexo y edades que se cruzan`,
      });
    }
  });
  if (overlaps.length > 0) throw new ReferenceRangeOverlapError(overlaps);

  const inside = criticalInsideReference(ranges);
  if (inside.length > 0) throw new ReferenceRangeInvalidError(inside);
}

const SEX_LABELS: Record<PatientSex, string> = {
  MALE: 'hombres',
  FEMALE: 'mujeres',
  INTERSEX: 'personas intersexuales',
  UNKNOWN: 'pacientes sin sexo registrado',
};

/**
 * ORD-112, D-123.3. The critical band lies OUTSIDE the reference one: a
 * critical low of 700 instead of 70 would flag every glucose as critical, and
 * a safety queue full of noise is one nobody looks at.
 *
 * ⚠️ WITH THE FLAG'S OWN RESOLUTION, NOT ROW AGAINST ROW. Which reference and
 * which critical apply to whom is ORD-036's question — side by side for the
 * critical band — so the check walks every sex and every age the written
 * rows tell apart and asks `applicableRange` and `criticalBounds` themselves.
 * A check that paired rows by eye could pass a set the flag then reads
 * differently. Equal is admitted: the critical bound is the band's edge.
 */
function criticalInsideReference(
  ranges: readonly ReferenceRange[],
): { field: string; message: string }[] {
  const found = new Map<string, string>();
  const rowOf = (range: ReferenceRange) => ranges.indexOf(range);

  for (const patient of patientsTellingApart(ranges)) {
    const reference = applicableRange(ranges, 'REFERENCE', patient);
    if (!reference) continue;
    const critical = criticalBounds(ranges, patient);
    const who = patient.sex ? ` (${SEX_LABELS[patient.sex]})` : '';

    if (
      critical.low &&
      reference.low !== null &&
      critical.low.value > reference.low
    ) {
      const field = `ranges[${rowOf(critical.low.range)}].low`;
      if (!found.has(field)) {
        found.set(
          field,
          `El crítico bajo ${decimal(critical.low.value)} es mayor que el límite inferior de referencia ${decimal(reference.low)} de la fila ${rowOf(reference) + 1}${who}: valores normales saldrían críticos`,
        );
      }
    }
    if (
      critical.high &&
      reference.high !== null &&
      critical.high.value < reference.high
    ) {
      const field = `ranges[${rowOf(critical.high.range)}].high`;
      if (!found.has(field)) {
        found.set(
          field,
          `El crítico alto ${decimal(critical.high.value)} es menor que el límite superior de referencia ${decimal(reference.high)} de la fila ${rowOf(reference) + 1}${who}: valores normales saldrían críticos`,
        );
      }
    }
  }
  return [...found].map(([field, message]) => ({ field, message }));
}

/**
 * Every patient the written rows tell apart: each sex (and «not recorded»),
 * at no known age and at each edge of every age window, on both sides of it.
 * Between two edges nothing changes which row applies, so these are enough.
 */
function patientsTellingApart(
  ranges: readonly ReferenceRange[],
): PatientProfile[] {
  const ages = new Set<number | null>([null, 0]);
  for (const range of ranges) {
    for (const edge of [range.ageMinDays, range.ageMaxDays]) {
      if (edge === null) continue;
      for (const age of [edge - 1, edge, edge + 1]) {
        if (age >= 0) ages.add(age);
      }
    }
  }
  const sexes: (PatientSex | null)[] = [null, ...(Object.keys(SEX_LABELS) as PatientSex[])]; // prettier-ignore
  return sexes.flatMap((sex) => [...ages].map((ageDays) => ({ sex, ageDays })));
}

/** As the laboratory writes it: decimal comma. */
function decimal(value: number): string {
  return String(value).replace('.', ',');
}

/**
 * ORD-107. Two ranges ORD-036 could not choose between: same kind, same sex,
 * both with or both without an age window, and windows that meet. A narrower
 * one beside a general one is NOT an overlap — ORD-036 takes the narrower.
 */
export function overlap(a: ReferenceRange, b: ReferenceRange): boolean {
  if (a.rangeKind !== b.rangeKind) return false;
  if (a.sex !== b.sex) return false;
  const aAged = a.ageMinDays !== null || a.ageMaxDays !== null;
  const bAged = b.ageMinDays !== null || b.ageMaxDays !== null;
  if (aAged !== bAged) return false;
  if (!aAged) return true;
  const aMin = a.ageMinDays ?? -Infinity;
  const aMax = a.ageMaxDays ?? Infinity;
  const bMin = b.ageMinDays ?? -Infinity;
  const bMax = b.ageMaxDays ?? Infinity;
  return aMin <= bMax && bMin <= aMax;
}
