import { foldText } from './problem-coding';
import { spokenNumberRuns } from './vitals-dictation';

/**
 * AS-282 (D-263). The reason as the nurse writes it is the model's wording of
 * the patient's phrase: believed only when it adds nothing the phrase does not
 * say (P2). Each word is in the phrase by its root, each number is said in
 * it, and it denies something only when the phrase does. A wording that fails
 * leaves the phrase itself, which can never be invented.
 */

/** What a wording may add to tie the patient's words: never a finding of its own. */
const LINKING = new Set([
  'a', 'al', 'con', 'de', 'del', 'desde', 'e', 'el', 'en', 'hace', 'hasta',
  'la', 'las', 'le', 'les', 'lo', 'los', 'mas', 'muy', 'o', 'para', 'por',
  'que', 'se', 'su', 'sus', 'u', 'un', 'una', 'unas', 'unos', 'y',
  'acude', 'asociado', 'asociada', 'cuadro', 'paciente', 'presenta',
  'refiere', 'sensacion',
]); // prettier-ignore

/** Words that deny: the wording must deny exactly when the phrase does. */
const DENIAL = new Set(['no', 'sin', 'ni', 'nunca', 'niega', 'niegan', 'tampoco', 'nada', 'ningun', 'ninguna', 'ninguno']); // prettier-ignore

/** «dolor» is how a nurse writes «me duele» or «me dolía». */
const SAID_AS: Readonly<Record<string, RegExp>> = { dolo: /^(duel|dol)/ };

const wordsOf = (text: string): string[] =>
  foldText(text).match(/\p{L}+/gu) ?? [];

const numbersOf = (text: string) =>
  spokenNumberRuns(text).flatMap((run) => run.map((number) => number.value));

/** The first five letters, or all but the last of a shorter word; a short word whole. */
function rootOf(word: string): string {
  if (word.length >= 6) return word.slice(0, 5);
  return word.length > 3 ? word.slice(0, -1) : word;
}

export function groundedWording(written: string, source: string): boolean {
  const wording = written.trim();
  if (wording === '' || wording.length > source.trim().length) return false;

  const said = wordsOf(source);
  const denies = (words: string[]) => words.some((word) => DENIAL.has(word));
  const words = wordsOf(wording);
  if (denies(words) !== denies(said)) return false;

  const grounded = words.every((word) => {
    if (LINKING.has(word) || DENIAL.has(word)) return true;
    const root = rootOf(word);
    if (word.length <= 3) return said.includes(word);
    return said.some(
      (each) => each.startsWith(root) || (SAID_AS[root]?.test(each) ?? false),
    );
  });
  if (!grounded) return false;

  const numbers = numbersOf(source);
  return numbersOf(wording).every((number) =>
    numbers.some((each) => Math.abs(each - number) < 1e-9),
  );
}
