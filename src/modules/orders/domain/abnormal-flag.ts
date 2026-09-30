import type {
  AbnormalFlag,
  AnalyteDefinition,
  PatientProfile,
  RangeKind,
  ReferenceRange,
} from './analyte';

/**
 * ORD-035 to ORD-038. The flag, computed here and never accepted from whoever
 * transcribes the report.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FLAG IS OURS AND NOT THE LABORATORY'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The A.M. 00002393 art. 39 obliges a laboratory that detects an alert value
 * to inform «de manera urgente al médico tratante y/o al usuario». It says
 * nothing about how, and in practice many laboratories send «alto/bajo», some
 * send nothing at all, and the ones that phone do it to whoever answers. So
 * the thresholds have to be OURS, as a safety net — which is what the
 * `CRITICAL` rows of `analyte_reference_range` are for.
 *
 * ⚠️ AND `CRITICAL` IS EVALUATED FIRST, WHICH IS THE POINT OF ORD-036. A
 * critical range is NOT a narrower reference range: it is the band that has to
 * reach a human today. A glucose of 25 mg/dL is both «below 70» and «below
 * 40», and answering `LOW` would put it in the same list as a 68.
 *
 * ⚠️ AND «NO RANGE» IS NOT `NORMAL` (ORD-038). Returning `NORMAL` when nothing
 * could be compared is the single most dangerous thing this file could do: it
 * would make an unclassifiable value indistinguishable from a reassuring one,
 * on the screen where somebody decides not to call the patient.
 *
 * ⚠️ WHAT THIS FILE CANNOT DO, AND IT IS A SCHEMA GAP. A qualitative result
 * gets NO FLAG, because `abnormal_flag` has `LOW`, `HIGH` and their critical
 * pair and no plain `ABNORMAL`. «Nitritos: Positivo» against an expected
 * «Negativo» is abnormal and neither high nor low, and inventing `HIGH` for it
 * would put a urine dipstick in the same bucket as a potassium of 7.2. The
 * reference text IS frozen on the row (ORD-037), so the report prints the
 * comparison a human can make; what is missing is the enum value that would
 * let a QUERY make it. Noted on ORD-038.
 *
 * PURE, no clock and no I/O: `pnpm arch:check` enforces it, and the reason is
 * this file has to be exercisable with the real seeded ranges — `HB` 13,0–17,0
 * for `MALE` and 12,0–15,5 for `FEMALE`, `GLU` critical below 40 and above
 * 400 — without a database in the room.
 */

/**
 * ORD-036. The most specific range of one kind that applies to this patient,
 * or `undefined`.
 *
 * SPECIFICITY, NOT ORDER OF ARRIVAL. An analyte can carry a range for everyone
 * and a narrower one for newborns; taking the first row would make the answer
 * depend on how the rows came back from the database, which is not an answer.
 * Sex is weighted above age because that is how the seeded catalogue is built
 * — `HB` and `HCT` split by sex and by nothing else — and because a range
 * qualified by sex is always about THIS patient, whereas an age window can be
 * a wide default.
 *
 * ⚠️ AN AGE-QUALIFIED RANGE NEVER APPLIES TO A PATIENT OF UNKNOWN AGE. The
 * alternative — treating «no sabemos» as «cabe en la ventana» — would classify
 * a neonate with an adult's range, and the neonatal ranges are exactly the
 * ones that differ most.
 */
export function applicableRange(
  ranges: readonly ReferenceRange[],
  kind: RangeKind,
  patient: PatientProfile,
): ReferenceRange | undefined {
  let best: ReferenceRange | undefined;
  let bestScore = -1;

  for (const range of ranges) {
    if (range.rangeKind !== kind) continue;
    if (!appliesTo(range, patient)) continue;

    const score = specificityOf(range);
    if (score > bestScore) {
      best = range;
      bestScore = score;
    }
  }

  return best;
}

/** Whether one range covers this patient at all. */
function appliesTo(range: ReferenceRange, patient: PatientProfile): boolean {
  if (range.sex !== null && range.sex !== patient.sex) return false;

  const bounded = range.ageMinDays !== null || range.ageMaxDays !== null;
  if (!bounded) return true;
  if (patient.ageDays === null) return false;
  if (range.ageMinDays !== null && patient.ageDays < range.ageMinDays) {
    return false;
  }
  if (range.ageMaxDays !== null && patient.ageDays > range.ageMaxDays) {
    return false;
  }
  return true;
}

/** Sex is worth more than an age window. See the note on `applicableRange`. */
function specificityOf(range: ReferenceRange): number {
  const bySex = range.sex !== null ? 2 : 0;
  const byAge = range.ageMinDays !== null || range.ageMaxDays !== null ? 1 : 0;
  return bySex + byAge;
}

/** What a computed classification leaves on the row, as the 010B prints it. */
export interface Classification {
  /** `null` means «no había con qué compararlo», never «normal» (ORD-038). */
  flag: AbnormalFlag | null;
  /** ORD-037. The range APPLIED, frozen so the report reads the same in 2040. */
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
}

/** Nothing to compare against: no flag and no frozen range. */
const UNCLASSIFIED: Classification = {
  flag: null,
  referenceLow: null,
  referenceHigh: null,
  referenceText: null,
};

/**
 * ORD-035 to ORD-038. Classifies one numeric value.
 *
 * The order is the requirement: critical first, reference second, nothing
 * third. A value inside the critical band but outside the reference band is
 * `LOW`/`HIGH`; a value outside the critical band is `CRITICAL_LOW`/
 * `CRITICAL_HIGH` even if no reference range exists at all.
 *
 * THE FROZEN RANGE IS ALWAYS THE REFERENCE ONE, even when the flag came from
 * the critical band. `VALOR DE REFERENCIA` is a column of form 010B and means
 * «lo normal»; printing the critical bounds there would tell a patient that
 * anything under 400 mg/dL of glucose is fine.
 */
export function classifyNumeric(
  value: number,
  analyte: Pick<AnalyteDefinition, 'ranges'>,
  patient: PatientProfile,
): Classification {
  const reference = applicableRange(analyte.ranges, 'REFERENCE', patient);
  const frozen = {
    referenceLow: reference?.low ?? null,
    referenceHigh: reference?.high ?? null,
    referenceText: reference?.text ?? null,
  };

  const critical = applicableRange(analyte.ranges, 'CRITICAL', patient);
  if (critical) {
    if (critical.low !== null && value < critical.low) {
      return { flag: 'CRITICAL_LOW', ...frozen };
    }
    if (critical.high !== null && value > critical.high) {
      return { flag: 'CRITICAL_HIGH', ...frozen };
    }
  }

  if (!reference) return { ...UNCLASSIFIED, ...frozen };
  if (reference.low === null && reference.high === null) {
    return { ...UNCLASSIFIED, ...frozen };
  }
  if (reference.low !== null && value < reference.low) {
    return { flag: 'LOW', ...frozen };
  }
  if (reference.high !== null && value > reference.high) {
    return { flag: 'HIGH', ...frozen };
  }
  return { flag: 'NORMAL', ...frozen };
}

/**
 * ORD-037, ORD-038. A qualitative value: the expected answer is frozen, and
 * NO FLAG IS PRODUCED.
 *
 * See the schema gap on this file's header. The reference text is what lets
 * the printed report say «Nitritos: Positivo (esperado: Negativo)»; what does
 * not exist is the enum value that would let the critical-value worklist find
 * it without reading Spanish.
 */
export function classifyQualitative(
  analyte: Pick<AnalyteDefinition, 'ranges'>,
  patient: PatientProfile,
): Classification {
  const reference = applicableRange(analyte.ranges, 'REFERENCE', patient);
  return {
    flag: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: reference?.text ?? null,
  };
}

/** ORD-060. Whether a flag is one of the two that have to reach a human today. */
export function isCritical(flag: AbnormalFlag | null): boolean {
  return flag === 'CRITICAL_LOW' || flag === 'CRITICAL_HIGH';
}
