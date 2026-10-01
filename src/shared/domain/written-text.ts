/**
 * D-099 §5, D-085 §5. «¿Hay algo escrito?» — ONE answer, asked in two places.
 *
 * Interrupting signs only the drafts with something written
 * (`hasWrittenContent`, in TypeScript) and decides whether the patient was
 * attended by asking the database for a note with something written
 * (`hasClinicalAct`, in SQL). When the two disagreed — PostgreSQL's `btrim`
 * strips only the space, JavaScript's `trim` every whitespace and line
 * terminator — a note holding a single Enter left the appointment «Atendida»
 * with nothing signed (3.ª revisión, G1).
 *
 * So the blank characters are written out once, here: exactly what
 * ECMAScript's `String.prototype.trim` removes (WhiteSpace and
 * LineTerminator, ECMA-262 §12.2 and §12.3), and the SQL pattern is built
 * from the same list. `written-text.spec.ts` checks the list against `trim`,
 * and the integration test checks the SQL against this function.
 */
const BLANK_CODE_POINTS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000,
  0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
] as const;

/** The code points `trim` removes, for the check that keeps the list honest. */
export const BLANK_CHARACTERS: readonly string[] = BLANK_CODE_POINTS.map(
  (point) => String.fromCodePoint(point),
);

/** Whether a text has anything besides blanks. */
export function isWritten(text: string): boolean {
  return text.trim() !== '';
}

/**
 * The same question as a PostgreSQL regular expression: a text MATCHES it
 * when it has a character outside the blank list. Passed as a bound
 * parameter, so the `\uXXXX` escapes reach the regex engine untouched.
 */
export const WRITTEN_TEXT_PATTERN = `[^${BLANK_CODE_POINTS.map(
  (point) => `\\u${point.toString(16).padStart(4, '0')}`,
).join('')}]`;
