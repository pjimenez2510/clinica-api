/**
 * AS-035 (P5). The barrier between what a model wrote and what a physician
 * is shown: a code is shown only when the WHO catalogue of this installation
 * has it, selectable and in force on the attention's clinical date.
 *
 * A port of `shared/` because the catalogue is `catalogs`'s and the barrier
 * is the assistant's; the encounter's own trigger
 * (`trg_diagnosis_concept_in_force`) asks the same question when the code is
 * recorded, so a code that passes here is one the record accepts.
 */

/** A code of the catalogue, with the name the catalogue gives it. */
export interface Cie10Entry {
  conceptId: string;
  code: string;
  display: string;
}

export interface Cie10Lookup {
  /**
   * AS-035. For each written code, in order, its entry, or null when it does
   * not resolve: the exact code with or without its dot, or a three-character
   * category through its `.X` subcategory. Only level-3 codes (four
   * characters) in force on `clinicalDate` (`YYYY-MM-DD`).
   */
  resolveWritten(
    codes: readonly string[],
    clinicalDate: string,
  ): Promise<(Cie10Entry | null)[]>;
}

export const CIE10_LOOKUP = Symbol('CIE10_LOOKUP');

/**
 * AS-035. The forms a written code may take in the catalogue, most exact
 * first: `j029` and `J02.9` → `J02.9`; `I10` → `I10`, `I10.X`. Anything that
 * is not a CIE-10 shape (a letter, two digits, an optional fourth character)
 * yields nothing and so never reaches the catalogue.
 */
export function candidateCodes(written: string): string[] {
  const plain = written.trim().toUpperCase().replace(/[\s.]/g, '');
  const match = /^([A-Z]\d{2})([0-9X]?)$/.exec(plain);
  if (!match) return [];
  const [, category, fourth] = match;
  return fourth ? [`${category}.${fourth}`] : [category!, `${category}.X`];
}
