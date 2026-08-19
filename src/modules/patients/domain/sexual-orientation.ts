import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import { ageInYearsOn } from '../../../shared/domain/priority-level';

/**
 * From what age the RDACAA's sexual orientation may be recorded
 * (PA-057, REQ-022, D-039 (b)).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO CLOCK IN HERE. THE REFERENCE DATE IS A PARAMETER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The caller resolves today with `clinicalDateToday()`, which asks Ecuador and
 * not the host, and that matters on this rule specifically: at 21:00 in
 * Guayaquil it is already tomorrow in UTC, so a chart sitting exactly on its
 * tenth birthday would be accepted or refused depending on what time of day
 * the receptionist typed it. It is the same defect PA-030 exists to avoid, and
 * it affects the entire evening clinic, every evening.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A WRITE-TIME RULE AND «INTERSEXUAL» (PA-005) IS NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The instructivo carries two age conditions, and they look alike and are not.
 * Column 6 says the sex «Intersexual» is recorded only under one year of age —
 * and a chart that was valid the day it was written becomes invalid on its
 * first birthday WITHOUT ANYBODY TOUCHING IT, which is why this system does
 * not validate it and PA-005 says so at length. Column 7 runs the other way:
 * ten years is a FLOOR, nobody grows younger, and a chart admissible when it
 * was written stays admissible forever. That asymmetry — the direction of the
 * inequality, not a different criterion — is the whole reason one of the two
 * is enforced here and the other belongs to the export layer.
 */

/**
 * The age from which the ministry's form asks the question.
 *
 * «Esta variable aplica a usuarios a partir de los 10 años de edad»
 * (§ 1.4.7). INCLUSIVE: the tenth birthday itself qualifies.
 *
 * ⚠️ ONE NUMBER, IN ONE PLACE, for the same reason as `NEONATE_MAX_AGE_DAYS`:
 * the day a norm revision moves it, moving it here has to be the whole change.
 */
export const SEXUAL_ORIENTATION_MIN_AGE_YEARS = 10;

/**
 * A chart as this rule sees it: when the patient was born, and whether the
 * chart declares a sexual orientation.
 *
 * ⚠️ THE BIRTH DATE AND NOT AN AGE. The age is derived and never stored
 * (PA-030); accepting a number here would let a caller hand this rule an age
 * computed in the browser's zone, which is the one thing the whole of PA-030
 * exists to prevent.
 *
 * ⚠️ AND `deceasedAt` IS DELIBERATELY ABSENT, unlike `AgeableChart`. What is
 * being decided is whether the datum MAY BE WRITTEN NOW, and a chart is only
 * corrected by somebody who is doing it today; freezing the age at death — the
 * right answer for what a certificate reports — would here mean refusing to
 * correct the chart of somebody who died at nine and accepting one for
 * somebody who died at eighty, which is not a distinction this rule makes.
 */
export interface SexualOrientationDeclaration {
  birthDate: ClinicalDate;
  sexualOrientationConceptId: string | null;
}

/**
 * Whether the chart may NOT hold the sexual orientation it declares (PA-057).
 *
 * No orientation, no rule: the field is optional at registration (D-028), and
 * a newborn's chart without one is the ordinary case rather than a half-filled
 * one.
 */
export function sexualOrientationBelowMinimumAge(
  chart: SexualOrientationDeclaration,
  today: ClinicalDate,
): boolean {
  if (chart.sexualOrientationConceptId === null) return false;
  return (
    ageInYearsOn(chart.birthDate, today) < SEXUAL_ORIENTATION_MIN_AGE_YEARS
  );
}
