import type { AnalyteValueType, ReferenceRange } from './analyte';
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

  /**
   * ORD-060. A critical band more specific than another (a sex, an age) is
   * applied WHOLE in its place (ORD-036). If it lacks a side the general one
   * has, that side stops alerting for exactly those patients: a man with a
   * glucose of 25 would read LOW and nobody would be called. Refused until
   * the author decides whether a partial band inherits the missing side
   * (D-123).
   */
  const lostSides: { field: string; message: string }[] = [];
  ranges.forEach((range, index) => {
    if (range.rangeKind !== 'CRITICAL') return;
    ranges.forEach((general, other) => {
      if (
        other === index ||
        general.rangeKind !== 'CRITICAL' ||
        specificity(general) >= specificity(range) ||
        !covers(general, range)
      ) {
        return;
      }
      if (general.low !== null && range.low === null) {
        lostSides.push({
          field: `ranges[${index}].low`,
          message: `Le falta el límite inferior que tiene el crítico de la fila ${other + 1}: sin él, esos pacientes no tienen alerta baja`,
        });
      }
      if (general.high !== null && range.high === null) {
        lostSides.push({
          field: `ranges[${index}].high`,
          message: `Le falta el límite superior que tiene el crítico de la fila ${other + 1}: sin él, esos pacientes no tienen alerta alta`,
        });
      }
    });
  });
  if (lostSides.length > 0) throw new ReferenceRangeInvalidError(lostSides);

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
}

/**
 * ORD-107. Two ranges ORD-036 could not choose between: same kind, same sex,
 * both with or both without an age window, and windows that meet. A narrower
 * one beside a general one is NOT an overlap — ORD-036 takes the narrower.
 */
/** ORD-036's weighing: sex above an age window. */
function specificity(range: ReferenceRange): number {
  return (range.sex !== null ? 2 : 0) + (aged(range) ? 1 : 0);
}

function aged(range: ReferenceRange): boolean {
  return range.ageMinDays !== null || range.ageMaxDays !== null;
}

/** Whether some patient the specific range applies to is also under `general`. */
function covers(general: ReferenceRange, specific: ReferenceRange): boolean {
  if (general.sex !== null && general.sex !== specific.sex) return false;
  const gMin = general.ageMinDays ?? -Infinity;
  const gMax = general.ageMaxDays ?? Infinity;
  const sMin = specific.ageMinDays ?? -Infinity;
  const sMax = specific.ageMaxDays ?? Infinity;
  return gMin <= sMax && sMin <= gMax;
}

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
