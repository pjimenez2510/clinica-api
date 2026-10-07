import type { StandingAllergyAbsence } from './allergy-history';

/**
 * EN-087. «¿Alguien afirmó que no tiene alergias, y sigue en pie?», for the
 * modules that do not own `patient_allergy_absence`.
 *
 * The consultation asked it alone until D-157.2: the receta now prints the
 * assertion (PR-117, DOC-116), so `prescription` asks it too, and it has to
 * get the SAME answer as the attention's band. The rule is not obvious —
 * retracted, or superseded by an allergy recorded after it or active now, on
 * the chart or on one it absorbed (`standingAbsenceFor`, D-A-018, EN-224,
 * EN-226) — so it is one statement in `shared/infrastructure/clinical`,
 * `findStandingAllergyAbsence`. This port is how `prescription` reaches it;
 * `encounter` and the `documents` reader, which already hold a Prisma
 * client, call the function itself.
 *
 * Separate from `ActiveAllergyReader` because it answers a different
 * question: an absence changes nothing a prescription CHECKS, only what the
 * receta SAYS.
 *
 * ⚠️ IT READS AND IT NEVER WRITES. Asserting and retracting are use cases of
 * `encounter`, each with its route, permission and audit entry.
 */
export interface AllergyAbsenceReader {
  /** EN-087. The chart's standing assertion, or `null` — «no se preguntó». */
  standingAbsenceFor(chartId: string): Promise<StandingAllergyAbsence | null>;
}

/** Injection token. No caller ever names the adapter. */
export const ALLERGY_ABSENCE_READER = Symbol('AllergyAbsenceReader');
