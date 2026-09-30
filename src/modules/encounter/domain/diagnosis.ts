/**
 * Block K's pure rules: what a diagnosis IS, before any storage is involved.
 *
 * Everything here is a function of the CIE-10 code and the position of the
 * diagnosis in the attention. No clock, no database, no framework — which is
 * what lets the monthly report re-derive the same answers years later from the
 * frozen row rather than from a catalogue that has since been reloaded.
 */

import type { CareModality } from './encounter';

/**
 * EN-043. The rank of the principal diagnosis.
 *
 * ONE NUMBER, TWO ENFORCEMENT POINTS: `encounter_diagnosis_one_primary` is a
 * partial unique index `ON encounter_diagnosis (encounter_id) WHERE rank = 1`,
 * and this constant is what the application uses to speak about the same row.
 * Two principals make the monthly report count one consultation twice, in two
 * different causes of morbidity.
 */
export const PRIMARY_RANK = 1;

/**
 * EN-047. The number of diagnoses the RDACAA form has room for.
 *
 * ⚠️ IT IS NOT A LIMIT ON THE HISTORY, AND THAT DISTINCTION IS THE
 * REQUIREMENT. The form has three boxes (columns 83 to 94) and the clinical
 * history has no reason to have three: capping the record at three because a
 * sheet of A3 has three is refusing to write down what the patient has so it
 * fits on the paper. The trimming belongs to the EXPORT layer — the same line
 * PA-005 drew when it reduced sex to male/female only for the ministry's file
 * — so this constant is exported for the exporter of EN-110 and is used by
 * nothing that writes.
 */
export const RDACAA_DIAGNOSIS_SLOTS = 3;

/**
 * EN-046. Prevention or morbidity, DERIVED FROM THE CODE and never typed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT IS DERIVED AND WHY IT IS PER DIAGNOSIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The instructivo (p. 62) states the rule as a property of the code: chapter
 * Z — `Z00` to `Z99`, «factores que influyen en el estado de salud y contacto
 * con los servicios de salud» — is prevention, and everything else is
 * morbidity. A column somebody fills in is a column that can contradict the
 * code it sits next to, and the two would then disagree in the one place it
 * matters: columns 84 and 85 of the monthly report.
 *
 * AND IT IS NOT `encounter.care_modality`. That one says what the patient came
 * for and stays where it is; block K asks the question ONCE PER DIAGNOSIS. A
 * consultation in which a pregnancy is monitored (Z34) and a pharyngitis is
 * treated (J02) is prevention AND morbidity at the same time, and a single
 * mark on the attention forces choosing one and lying about the other.
 *
 * ⚠️ **Falta esquema.** There is no column for this on `encounter_diagnosis`,
 * so today it is computed on the way out instead of stored. That is enough for
 * a client and NOT enough for the export: a report composed from a derivation
 * has to re-run this function over rows whose code was frozen years earlier,
 * which is exactly what the frozen code is for — but a `WHERE` over a stored
 * column is what an index can answer. The note is on EN-046.
 */
export function careModalityOfCie10(code: string): CareModality {
  return /^Z/i.test(code.trim()) ? 'PREVENTION' : 'MORBIDITY';
}

/** EN-043. Whether this position is the principal diagnosis of the attention. */
export function isPrimary(rank: number): boolean {
  return rank === PRIMARY_RANK;
}

/**
 * EN-047. The position a diagnosis takes when the caller states none.
 *
 * THE FIRST DIAGNOSIS OF AN ATTENTION BECOMES THE PRINCIPAL, and the ones
 * after it queue behind it. It is the ordinary consultation written down: the
 * doctor types the reason the patient is being treated first, and the
 * comorbidities after. A caller that wants another order sends `rank`
 * explicitly and `encounter_diagnosis_one_primary` arbitrates the collision.
 *
 * TAKEN FROM THE HIGHEST RANK IN USE AND NOT FROM A COUNT: a report of the
 * ranks in use survives a diagnosis being registered with an explicit 5, which
 * a count does not — it would hand out 2 twice.
 */
export function nextRankAfter(ranksInUse: readonly number[]): number {
  return ranksInUse.reduce((highest, rank) => Math.max(highest, rank), 0) + 1;
}
