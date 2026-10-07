/**
 * EN-052. The CEO-D and the CPO-D of the RDACAA form, columns 101 to 104.
 *
 * Which index an attention takes is a function of two facts, and this file
 * holds both rules as pure functions: the SPECIALTY of the attention (the
 * instructivo restricts the block to «profesionales con especialidad
 * odontólogo y odontólogo rural») and its FROZEN age (EN-008), never today's.
 *
 * ⚠️ THE DATABASE IS THE GUARANTEE FOR THE AGE: `trg_encounter_dental_index_applies`
 * refuses a row outside the two bands with the same bounds. This copy is what
 * lets the service answer «which index» before anything is written; the
 * integration tests of EN-052 try both sides of every bound against the real
 * database.
 */

/** EN-052. CEO-D: primary teeth. CPO-D: permanent teeth. */
export type DentalIndex = 'CEO_D' | 'CPO_D';

/**
 * D-160 (built literally while it is decided). The specialty code that counts
 * as odontology, from `prisma/seed-specialties.mts`. Whether odontopediatría
 * or others count too is the author's decision; adding them is this list.
 */
export const DENTISTRY_SPECIALTY_CODES: readonly string[] = ['odontologia'];

/** The age frozen on the attention, in the three units the RDACAA uses. */
export interface FrozenAge {
  ageYears: number | null;
  ageMonths: number | null;
  ageDays: number | null;
}

/**
 * EN-052, D-160. The index of the frozen age, or `null` when neither applies:
 * the CEO-D «>6 meses y < 11 años», the CPO-D «mayor o igual a 12 años». At
 * 11 years, at 6 months or less, or with no frozen age, none.
 *
 * The components are those of the age on the clinical date — months 0..11,
 * days 0..30 — so «more than 6 months» is a year or more, more than 6 months,
 * or exactly 6 months and some days.
 */
export function dentalIndexForAge(age: FrozenAge): DentalIndex | null {
  const { ageYears: years, ageMonths: months, ageDays: days } = age;
  if (years === null || months === null || days === null) return null;
  if (years >= 12) return 'CPO_D';
  const overSixMonths = years > 0 || months > 6 || (months === 6 && days > 0);
  return overSixMonths && years < 11 ? 'CEO_D' : null;
}

/**
 * EN-052, EN-203. The index of an attention: only odontology takes one, and
 * the specialty is the one the note template uses (its appointment's service
 * type, else the practitioner's primary specialty).
 */
export function dentalIndexOf(
  specialtyCode: string | null,
  age: FrozenAge,
): DentalIndex | null {
  if (
    specialtyCode === null ||
    !DENTISTRY_SPECIALTY_CODES.includes(specialtyCode)
  ) {
    return null;
  }
  return dentalIndexForAge(age);
}

/**
 * EN-052. The four counts as the row keeps them: the CEO-D has no `missing`
 * and the CPO-D no `extracted`.
 */
export interface DentalIndexCounts {
  decayed: number | null;
  extracted: number | null;
  filled: number | null;
  missing: number | null;
}

/** EN-052. The index as recorded, with when and when last corrected. */
export interface DentalIndexReading extends DentalIndexCounts {
  recordedAt: Date;
  editedAt: Date | null;
}
