import {
  classifyNumeric,
  classifyQualitative,
  type CriticalLimits,
} from './abnormal-flag';
import {
  ResultValueNotAllowedError,
  ResultValueTypeMismatchError,
} from './orders.errors';
import type {
  AbnormalFlag,
  AnalyteDefinition,
  PatientProfile,
} from './analyte';

/**
 * ORD-031 to ORD-038. One transcribed reading, turned into the row form 010B
 * describes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE VALUE COLUMNS, AND WHICH ONE IS NOT THE CALLER'S CHOICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `observation_result_one_value` already guarantees that exactly one of
 * `value_numeric`, `value_code` and `value_text` is populated. What the
 * database cannot know is WHICH one should be, because that is a property of
 * the analyte and lives in another table. So this file answers it, and refuses
 * the mismatch: a haemoglobin typed into `value_text` satisfies every
 * constraint in the schema and is still a string that merely looks like a
 * result — no graph plots it, no threshold compares it, no alert fires on it.
 *
 * ⚠️ THE UNIT AND THE RANGE ARE NEVER TAKEN FROM THE CALLER (ORD-034, ORD-037).
 * They are copied from the catalogue, frozen onto the row, and that is what
 * makes the printed report say the same thing in fifteen years and what stops
 * the same haemoglobin arriving once in `g/dL` and once in `g/L`.
 */

/** The scale of `observation_result.value_numeric`. */
const STORED_DECIMALS = 6;

/** What a transcriber sends for one determination. Exactly one is populated. */
export interface SubmittedValue {
  valueNumeric?: number | null;
  valueCode?: string | null;
  valueText?: string | null;
}

/** One `observation_result` row, ready to be written. */
export interface ResolvedResult {
  analyteId: string;
  /** ORD-031. The `DETERMINACIÓN` column, frozen. */
  analyteDisplay: string;
  valueNumeric: number | null;
  valueCode: string | null;
  valueText: string | null;
  /** ORD-034. The `UNIDAD DE MEDIDA` column, from the catalogue. */
  unit: string | null;
  /** ORD-037. The `VALOR DE REFERENCIA` column, frozen. */
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  /** ORD-122. The critical bounds the flag was computed with, frozen. */
  criticalLow: number | null;
  criticalHigh: number | null;
  /** ORD-035, ORD-038. Computed here; `null` means «nothing to compare against». */
  abnormalFlag: AbnormalFlag | null;
}

/**
 * ORD-031 to ORD-038. Validates one reading against its analyte and classifies
 * it.
 *
 * Throws `RESULT_VALUE_TYPE_MISMATCH` when the populated column is not the one
 * the analyte declares, and `RESULT_VALUE_NOT_ALLOWED` when a coded answer is
 * outside `allowed_values`.
 */
export function resolveResult(
  analyte: AnalyteDefinition,
  submitted: SubmittedValue,
  patient: PatientProfile,
  /** ORD-114, ORD-122. What the corrected version applied to this value. */
  applied?: CriticalLimits,
): ResolvedResult {
  const frozen = { analyteId: analyte.id, analyteDisplay: analyte.name };

  if (analyte.valueType === 'NUMERIC') {
    const submittedValue = submitted.valueNumeric;
    if (
      typeof submittedValue !== 'number' ||
      !Number.isFinite(submittedValue)
    ) {
      throw new ResultValueTypeMismatchError(analyte.code, 'NUMERIC');
    }
    /**
     * ORD-122. Classified as it will be STORED: `value_numeric` is
     * DECIMAL(18,6). Classifying the unrounded number, 400.0000004 against a
     * critical of 400 was flagged critical, stored as 400, and refused by
     * `observation_result_flag_agrees_with_critical_bounds`.
     */
    const value = Number(submittedValue.toFixed(STORED_DECIMALS));
    if (submitted.valueCode != null || submitted.valueText != null) {
      throw new ResultValueTypeMismatchError(analyte.code, 'NUMERIC');
    }

    const { flag, ...range } = classifyNumeric(
      value,
      analyte,
      patient,
      applied,
    );
    return {
      ...frozen,
      valueNumeric: value,
      valueCode: null,
      valueText: null,
      /**
       * ORD-034. `analyte_definition_numeric_carries_a_unit` guarantees a
       * numeric analyte declares one, and
       * `observation_result_unit_required` guarantees the row carries it. The
       * two together are why this can be read without a fallback: a number
       * with no unit is not a result.
       */
      unit: analyte.unit,
      ...range,
      abnormalFlag: flag,
    };
  }

  if (analyte.valueType === 'TEXT') {
    const value = submitted.valueText;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ResultValueTypeMismatchError(analyte.code, 'TEXT');
    }
    if (submitted.valueNumeric != null || submitted.valueCode != null) {
      throw new ResultValueTypeMismatchError(analyte.code, 'TEXT');
    }

    return {
      ...frozen,
      valueNumeric: null,
      valueCode: null,
      valueText: value.trim(),
      unit: null,
      ...qualitativeRange(analyte, patient),
      abnormalFlag: null,
    };
  }

  // CODED and ORDINAL. Both answer with one of a closed list; the difference
  // is whether the list is ORDERED, which matters to a chart and not to this.
  const value = submitted.valueCode;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResultValueTypeMismatchError(analyte.code, analyte.valueType);
  }
  if (submitted.valueNumeric != null || submitted.valueText != null) {
    throw new ResultValueTypeMismatchError(analyte.code, analyte.valueType);
  }

  const coded = value.trim();
  /**
   * ORD-033. ⚠️ AN ANALYTE WITH NO LIST IS NOT REFUSED, and that is deliberate:
   * `allowed_values` is nullable, and a coded analyte whose list nobody has
   * filled in yet has to remain transcribable. What the absence costs — four
   * spellings of «positivo» — is written on ORD-033, and the fix is a
   * catalogue row, not a rejection that blocks today's report.
   */
  if (analyte.allowedValues && !analyte.allowedValues.includes(coded)) {
    throw new ResultValueNotAllowedError(analyte.code, analyte.allowedValues);
  }

  return {
    ...frozen,
    valueNumeric: null,
    valueCode: coded,
    valueText: null,
    unit: null,
    ...qualitativeRange(analyte, patient),
    abnormalFlag: null,
  };
}

/**
 * ORD-037. The frozen `VALOR DE REFERENCIA` of a qualitative determination,
 * without the flag that `abnormal_flag` has no value for.
 *
 * Extracted so the two qualitative branches cannot drift: they differ in which
 * column carries the answer and in nothing else.
 */
function qualitativeRange(
  analyte: AnalyteDefinition,
  patient: PatientProfile,
): Pick<
  ResolvedResult,
  | 'referenceLow'
  | 'referenceHigh'
  | 'referenceText'
  | 'criticalLow'
  | 'criticalHigh'
> {
  const classified = classifyQualitative(analyte, patient);
  return {
    referenceLow: classified.referenceLow,
    referenceHigh: classified.referenceHigh,
    referenceText: classified.referenceText,
    criticalLow: classified.criticalLow,
    criticalHigh: classified.criticalHigh,
  };
}
