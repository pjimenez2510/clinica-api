/**
 * Province and canton, DERIVED from the parish code (PA-028).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEVER COLUMNS. THE CODE IS THE HIERARCHY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The INEC DPA code is six digits: `PPCCPP` — two for the province, two more
 * for the canton, two for the parish. `170150` is parish 50 of canton 01 of
 * province 17.
 *
 * Storing the canton was verified as wrong on 13-08-2026, in the worst
 * possible way for that idea: TWO ROWS OF THE INEC FILE DECLARE A CANTON THEIR
 * OWN CODE CONTRADICTS — two parishes of Durán filed under Daule. With a
 * denormalised column, the residence of those patients would be reported to
 * the ministry in the wrong canton and nothing would fail. Derived from the
 * prefix, the file's own mistake cannot reach the report.
 */

/** Six digits. Anything else is not a DPA parish code. */
const DPA_PARISH_CODE = /^\d{6}$/;

/** PA-028. What the parish code says about province and canton, both derived from its prefix. */
export interface ParishLocation {
  /** Two digits, or `null` when the code is not a DPA parish code. */
  provinceCode: string | null;
  /** Four digits, or `null`. Includes the province: `1701` is Quito. */
  cantonCode: string | null;
}

/**
 * The province and canton a parish code belongs to.
 *
 * ⚠️ `null` RATHER THAN A PREFIX OF WHATEVER ARRIVED. Slicing blindly turns
 * `17` into province `17` and canton `17`, and a four-digit canton code into a
 * parish that does not exist — an invented location that reads exactly like a
 * real one all the way to the ministry. Refusing to answer is the only honest
 * result for a code this function cannot recognise.
 */
export function parishLocationOf(code: string): ParishLocation {
  if (!DPA_PARISH_CODE.test(code)) {
    return { provinceCode: null, cantonCode: null };
  }

  return { provinceCode: code.slice(0, 2), cantonCode: code.slice(0, 4) };
}
