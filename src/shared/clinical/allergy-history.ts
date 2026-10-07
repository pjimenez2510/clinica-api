import { CLINIC_TIME_ZONE, clinicalDateOf } from '../domain/clinic-time';

/**
 * PR-117, DOC-116 (D-157). What the receta says about allergies, in ONE
 * sentence, on the screen and on the paper.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ONE FUNCTION FOR TWO MODULES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `prescription` serves the receta the doctor reads and `documents` prints the
 * one the pharmacy reads. They are composed by different modules, and the
 * pharmacist and the doctor must read the same words: two copies of this
 * sentence would drift, and the way they drift is already known — the paper
 * said «Ninguna conocida» while the screen said «no consta» (DOC-072).
 *
 * THREE ANSWERS, AND ONLY ONE OF THEM SAYS «NONE»:
 *  - the active allergies, when there are any;
 *  - «Sin alergias conocidas (<who>, <when>)» when a clinician asserted it and
 *    the assertion still stands (EN-087, `standingAbsenceFor`, D-A-018) — with
 *    the name and the date, because it is an act of a person, never a default;
 *  - otherwise «No registradas: pregunte al paciente»: what whoever dispenses
 *    has to do when nobody asked.
 */

/** D-157.1. The words for a chart nobody has asked about. */
export const ALLERGIES_NOT_RECORDED = 'No registradas: pregunte al paciente';

/** EN-087. A standing «sin alergias conocidas»: who asserted it and when. */
export interface StandingAllergyAbsence {
  assertedByName: string;
  assertedAt: Date;
}

/**
 * PR-117, DOC-116. The sentence, with the assertion's date resolved in
 * Ecuador and printed `DD/MM/AAAA` like every other date on the receta.
 *
 * The assertion is ignored when there are allergies: the reader only serves a
 * standing one over an empty chart, and this keeps the sentence right even if
 * a caller ever passes both.
 */
export function allergyHistoryOf(
  allergies: readonly string[],
  absence: StandingAllergyAbsence | null,
  timeZone: string = CLINIC_TIME_ZONE,
): string {
  if (allergies.length > 0) return allergies.join(', ');
  // PR-117: never «sin alergias» without WHO said it. A nameless account
  // falls to the safe sentence.
  if (absence === null || absence.assertedByName.trim() === '') {
    return ALLERGIES_NOT_RECORDED;
  }
  const [year, month, day] = clinicalDateOf(absence.assertedAt, timeZone).split(
    '-',
  );
  return `Sin alergias conocidas (${absence.assertedByName}, ${day}/${month}/${year})`;
}
