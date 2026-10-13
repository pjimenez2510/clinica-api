import { foldText } from './problem-coding';
import { spokenNumberRuns } from './vitals-dictation';

/**
 * AS-282 (D-263). The reason as the nurse writes it is the model's wording of
 * the patient's phrase: believed only when it says all the patient said and
 * nothing else (P2). Each word of the wording is one the patient said, each
 * word the patient said that carries meaning is in the wording, and both say
 * the same numbers. Where a word-by-word check cannot tell a change of sense
 * —a denial, someone else, both sides, two durations or two numbers— it is
 * not believed at all (revisión clínica G2, G3). A wording that fails leaves
 * the phrase itself, which can never be invented.
 */

/** What a wording may add to tie the patient's words: never a finding of its own. */
const LINKING = new Set([
  'a', 'al', 'con', 'de', 'del', 'desde', 'e', 'el', 'en', 'hace', 'la',
  'las', 'lo', 'los', 'para', 'por', 'que', 'se', 'su', 'sus', 'u', 'un',
  'una', 'unas', 'unos', 'y',
  'acude', 'asociada', 'asociado', 'cuadro', 'paciente', 'presenta',
  'refiere', 'sensacion',
]); // prettier-ignore

/** What the patient says that a nurse leaves out: fillers, whom they speak to, themselves. */
const DROPPABLE = new Set([
  'ay', 'bueno', 'pues', 'mire', 'oiga', 'este', 'senorita', 'senora',
  'senor', 'doctor', 'doctora', 'doctorita', 'licenciada', 'enfermera',
  'mijo', 'mija', 'yo', 'me', 'mi', 'mis', 'tengo', 'tenia', 'tiene',
  'siento', 'sentia', 'siente', 'estoy', 'estaba', 'esta', 'es', 'vengo',
  'vine', 'acudo', 'ando', 'da', 'dan', 'hay', 'ya', 'como', 'solo',
  'porque', 'pero', 'eso', 'algo',
]); // prettier-ignore

const DENIAL = new Set(['no', 'sin', 'ni', 'nunca', 'niega', 'niegan', 'tampoco', 'nada', 'ningun', 'ninguna', 'ninguno']); // prettier-ignore

/** Someone else's complaint: a companion or a relative (D-260 §16). */
const SOMEONE_ELSE = /(^| )(mi|mis|su|sus) (mama|papa|madre|padre|hij[oa]s?|espos[oa]|marido|herman[oa]s?|abuel[oa]s?|nin[oa]s?|bebe|ti[oa]|prim[oa]|niet[oa]s?|suegr[oa])( |$)/; // prettier-ignore

const DURATION = /^(minutos?|horas?|dias?|semanas?|mes|meses|anos?)$/;

/** «dolor» is how a nurse writes «me duele»; «mareo», «me siento mareada». */
const LEMMAS: readonly [RegExp, string][] = [
  [/^(duel|dol)/, 'dolor'],
  [/^mare[oa]/, 'mareo'],
];

const lemmaOf = (word: string) =>
  LEMMAS.find(([pattern]) => pattern.test(word))?.[1] ?? null;

/** A short word with its gender and number taken off: «pies» is «pie», never «piel». */
const bare = (word: string) =>
  word
    .replace(/(?<=[aeiou])s$/, '')
    .replace(/(?<=[^aeiou])es$/, '')
    .replace(/[ao]$/, '');

/** The same word: by its lemma, whole or with another gender or number, or a long one by its root. */
function same(a: string, b: string): boolean {
  const lemma = lemmaOf(a);
  if (lemma !== null || lemmaOf(b) !== null) return lemma === lemmaOf(b);
  if (a === b) return true;
  if (Math.min(a.length, b.length) <= 5) return bare(a) === bare(b);
  return a.slice(0, 5) === b.slice(0, 5);
}

/** The phrase without the «no sé» and the «¿no?» at its end, which deny nothing. */
function spoken(text: string): string {
  return text
    .replace(/(^|[^\p{L}])no,?\s+sé(?!\p{L})/giu, '$1 ')
    .replace(/,?\s*¿?\s*no\s*\?[\s.!]*$/iu, '');
}

const wordsOf = (text: string): string[] =>
  foldText(text).match(/\p{L}+/gu) ?? [];

const numbersOf = (text: string) =>
  spokenNumberRuns(text)
    .flatMap((run) => run.map((number) => number.value))
    .sort((a, b) => a - b);

export function groundedWording(written: string, source: string): boolean {
  const wording = written.trim();
  const phrase = spoken(source).trim();
  if (wording === '' || wording.length > source.trim().length) return false;

  const said = wordsOf(phrase);
  const words = wordsOf(wording);
  const numbers = numbersOf(phrase);
  // What a word-by-word check cannot tell: keep the patient's own words.
  if (said.some((word) => DENIAL.has(word))) return false;
  if (SOMEONE_ELSE.test(said.join(' '))) return false;
  if (said.some((w) => w.startsWith('derech')) && said.some((w) => w.startsWith('izquierd'))) return false; // prettier-ignore
  if (new Set(said.filter((word) => DURATION.test(word)).map(bare)).size > 1) return false; // prettier-ignore
  if (numbers.length > 1) return false;

  // Nothing the patient did not say.
  if (words.some((word) => DENIAL.has(word))) return false;
  const grounded = words.every(
    (word) => LINKING.has(word) || said.some((each) => same(word, each)),
  );
  // And nothing the patient said left out.
  const covered = said.every(
    (each) =>
      LINKING.has(each) ||
      DROPPABLE.has(each) ||
      words.some((word) => same(word, each)),
  );
  const wordingNumbers = numbersOf(wording);
  return (
    grounded &&
    covered &&
    wordingNumbers.length === numbers.length &&
    wordingNumbers.every((number, at) => Math.abs(number - numbers[at]!) < 1e-9)
  );
}
