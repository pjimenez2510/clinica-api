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
  const say = (field: string, message: string) => {
    if (!found.has(field)) found.set(field, message);
  };
  const NOISE = 'valores normales saldrían críticos';

  for (const patient of patientsTellingApart(ranges)) {
    const reference = applicableRange(ranges, 'REFERENCE', patient);
    const { low, high } = criticalBounds(ranges, patient);
    const who = (range: ReferenceRange) => whoOf(range, patient);

    // The band itself, whatever the reference: with the sides resolved one
    // by one (ORD-036), a «varón» high of 30 under an inherited low of 40
    // makes every value critical. Named on the more specific row's own side.
    if (low && high && low.value > high.value) {
      const own =
        specificityOf(high.range) >= specificityOf(low.range)
          ? { field: `ranges[${rowOf(high.range)}].high`, range: high.range }
          : { field: `ranges[${rowOf(low.range)}].low`, range: low.range };
      say(
        own.field,
        `El crítico alto ${decimal(high.value)} es menor que el crítico bajo ${decimal(low.value)}${who(own.range)}: todo valor saldría crítico`,
      );
    }
    if (!reference) continue;
    const row = `de la fila ${rowOf(reference) + 1}${who(reference)}`;

    if (low && reference.low !== null && low.value > reference.low) {
      say(
        `ranges[${rowOf(low.range)}].low`,
        `El crítico bajo ${decimal(low.value)} es mayor que el límite inferior de referencia ${decimal(reference.low)} ${row}: ${NOISE}`,
      );
    } else if (low && reference.high !== null && low.value > reference.high) {
      // A reference with only its upper bound: a «low» written in the wrong
      // box would make every normal value critically low.
      say(
        `ranges[${rowOf(low.range)}].low`,
        `El crítico bajo ${decimal(low.value)} es mayor que el límite superior de referencia ${decimal(reference.high)} ${row}: ${NOISE}`,
      );
    }
    if (high && reference.high !== null && high.value < reference.high) {
      say(
        `ranges[${rowOf(high.range)}].high`,
        `El crítico alto ${decimal(high.value)} es menor que el límite superior de referencia ${decimal(reference.high)} ${row}: ${NOISE}`,
      );
    } else if (high && reference.low !== null && high.value < reference.low) {
      say(
        `ranges[${rowOf(high.range)}].high`,
        `El crítico alto ${decimal(high.value)} es menor que el límite inferior de referencia ${decimal(reference.low)} ${row}: ${NOISE}`,
      );
    }
  }
  return [...found].map(([field, message]) => ({ field, message }));
}

/** ORD-036's weighing: sex above an age window. */
function specificityOf(range: ReferenceRange): number {
  const aged = range.ageMinDays !== null || range.ageMaxDays !== null;
  return (range.sex !== null ? 2 : 0) + (aged ? 1 : 0);
}

/**
 * «(hombres, de 0 a 27 días)»: who a clash is about, from the row's own
 * qualifiers, the sex falling back to the patient's being walked.
 */
function whoOf(range: ReferenceRange, patient: PatientProfile): string {
  const sex = range.sex ?? patient.sex;
  const parts = [
    sex ? SEX_LABELS[sex] : null,
    ageWindow(range.ageMinDays, range.ageMaxDays),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Stored days, inclusive at both ends, as a laboratory reads them. */
function ageWindow(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (max === null) return `desde ${min} días`;
  return `de ${min ?? 0} a ${max} días`;
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
