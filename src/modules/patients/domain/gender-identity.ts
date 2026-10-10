import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import { ageInYearsOn } from '../../../shared/domain/priority-level';

import { SEXUAL_ORIENTATION_MIN_AGE_YEARS } from './sexual-orientation';

/**
 * From what age the RDACAA's gender identity may be recorded (PA-071, REQ-022).
 *
 * Column 8 of the ministry's form carries the SAME note as column 7: «Esta
 * variable aplica a usuarios a partir de los 10 años de edad» (instructivo
 * RDACAA 2.0, p. 47). It is a FLOOR, like PA-057 — nobody grows younger, so a
 * chart admissible when written stays admissible — which is why it is checked
 * at write time and not left to the export layer (the argument
 * `sexual-orientation.ts` makes against PA-005).
 *
 * ONE NUMBER: the two columns share the note, so they share the constant. If a
 * revision of the instructivo ever separates them, this is the line that
 * changes.
 */
export const GENDER_IDENTITY_MIN_AGE_YEARS = SEXUAL_ORIENTATION_MIN_AGE_YEARS;

/**
 * A chart as this rule sees it. The birth date and never an age, for the
 * reason `SexualOrientationDeclaration` gives (PA-030).
 */
export interface GenderIdentityDeclaration {
  birthDate: ClinicalDate;
  genderIdentityConceptId: string | null;
}

/**
 * Whether the chart may NOT hold the gender identity it declares (PA-071).
 *
 * PURE: `today` is the clinical date of Ecuador, resolved by the caller with
 * `clinicalDateToday()`. No gender identity, no rule — the field is optional
 * (D-028).
 */
export function genderIdentityBelowMinimumAge(
  chart: GenderIdentityDeclaration,
  today: ClinicalDate,
): boolean {
  if (chart.genderIdentityConceptId === null) return false;
  return ageInYearsOn(chart.birthDate, today) < GENDER_IDENTITY_MIN_AGE_YEARS;
}
