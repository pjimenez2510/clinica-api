/**
 * Block D of the RDACAA and form **020**: what may be written, what may not,
 * and what may not be left out.
 *
 * ⚠️ FORM **020**, NEVER «004». The 004 DOES NOT EXIST in Annex 1 of the
 * A.M. 00115-2021 — the list jumps from 003 to 005 — and the number this
 * document used to carry was from the numbering the 2021 accord DEROGATED.
 * `form_code` is written into every row of `clinical_note`, so the mistake
 * would have ended up in the data (EN-021).
 *
 * WHAT THIS FILE DOES *NOT* DO, and the absences are the design:
 *
 *  - IT DOES NOT COMPUTE THE BMI (EN-061). `trg_encounter_vitals_bmi` does,
 *    on every insert and update of the weight or the height. A second
 *    implementation here would be a number that can disagree with the stored
 *    one, and the stored one is the one a nutritional screening filters on.
 *  - IT DOES NOT CHECK THE PHYSIOLOGICAL RANGES (EN-062).
 *    `encounter_vitals_ranges_*` does, deliberately wide: the goal is to catch
 *    the finger that typed 750 instead of 75, not to argue physiology with the
 *    clinic. A stricter copy here would refuse readings the database accepts,
 *    and the two would drift the first time either moved.
 *
 * PURE: the age is handed in already frozen, so nothing here reads a clock.
 */

import { BmiIsDerivedError } from './encounter.errors';

/**
 * EN-060. The block D measurements, as `encounter_vitals` stores them.
 *
 * EVERY ONE OPTIONAL, and EN-063 is what makes three of them obligatory for
 * part of the population: the instructivo marks them with an asterisk for
 * under-fives and pregnant women and calls them optional for everybody else,
 * so a required field here would refuse the ordinary adult consultation.
 *
 * NO `bmi` FIELD AT ALL. It is not merely refused when supplied (EN-061) —
 * there is no way to name it on the way in, which is a stronger statement than
 * a check: `assertBmiNotSupplied` exists for the ONE caller that can still
 * carry it, the raw HTTP body.
 */
/** EN-064. Column 23 of the RDACAA: 1 standing, 2 lying down. */
export type HeightPosition = 'STANDING' | 'LYING';

export interface VitalSigns {
  weightKg?: number;
  heightCm?: number;
  /**
   * EN-064. HOW the height was taken — mandatory with a height, and the
   * database says so (`encounter_vitals_height_needs_position`). Never
   * deduced from the age: the instructivo's cut-off is how it SHOULD be
   * measured, and the record says how it WAS.
   */
  heightPosition?: HeightPosition;
  headCircumferenceCm?: number;
  abdominalCircumferenceCm?: number;
  systolicBp?: number;
  diastolicBp?: number;
  heartRate?: number;
  respiratoryRate?: number;
  temperatureC?: number;
  oxygenSaturation?: number;
  /** EN-065. Both typed: correcting needs the site's altitude. g/dl. */
  hemoglobinGDl?: number;
  hemoglobinCorrectedGDl?: number;
  /**
   * EN-163. The reason for the visit in the patient's own words, taken in
   * preparation. It is not the 002's `motivoConsulta`: that one is the
   * doctor's, and opening the note would move the patient to
   * `RECEIVING_CARE` before the doctor called them.
   */
  presentingComplaint?: string;
  /**
   * EN-060. WHEN the measurement was taken, which is not when it was typed.
   *
   * Its own instant and not `created_at`, for the same reason
   * `encounter.started_at` is a datum and not `now()` (EN-034): nursing takes
   * the weight at 08:10 and the network comes back at 08:40, and a record that
   * says 08:40 has quietly moved a fact.
   */
  measuredAt?: Date;
}

/**
 * EN-063, EN-217. The anthropometry the instructivo makes obligatory for
 * under-fives and for pregnant women, by the field name the API uses.
 *
 * WHICH ONES ARE DEMANDED OR MISSING IS NOT DECIDED HERE:
 * `encounter_anthropometry_required` in the database states the rule, and
 * `encounter_anthropometry_pending`, built on it, answers what is missing for
 * the taking's response, for the signature and for the deferred trigger that
 * guards the signature (D-132 B); the opening serves the first (EN-063). The rule
 * reads the frozen age, the chart's dated pregnancy on the clinical date and
 * the absorbed charts; one statement of it is what keeps the three answers
 * the same.
 */
export type AnthropometryField =
  'weightKg' | 'heightCm' | 'headCircumferenceCm';

/**
 * EN-061. Refuses a body that carried a body mass index.
 *
 * A SEPARATE ASSERTION AND NOT A FIELD OF `VitalSigns`: the type already makes
 * the value unnameable everywhere inside this module, so the only place it can
 * still arrive is the JSON of a request. That is exactly one caller, and the
 * refusal belongs there — which is what keeps the rest of the module from
 * having to remember a field that does not exist.
 *
 * REFUSED AND NOT DROPPED. See `BmiIsDerivedError` for why silence would be
 * the worse answer.
 */
export function assertBmiNotSupplied(body: { readonly bmi?: unknown }): void {
  if (body.bmi !== undefined) throw new BmiIsDerivedError();
}
