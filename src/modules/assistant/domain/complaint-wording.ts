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
  'a', 'con', 'de', 'del', 'desde', 'e', 'el', 'en', 'hace', 'la', 'las',
  'lo', 'los', 'que', 'se', 'su', 'sus', 'u', 'un', 'una', 'y',
  'acude', 'asociada', 'asociado', 'cuadro', 'paciente', 'presenta',
  'refiere', 'sensacion',
]); // prettier-ignore

/** What the patient says that a nurse leaves out: fillers, whom they speak to, themselves. */
const DROPPABLE = new Set([
  'ay', 'bueno', 'pues', 'mire', 'oiga', 'este', 'senorita', 'senora',
  'senor', 'doctor', 'doctora', 'doctorita', 'licenciada', 'enfermera',
  'mijo', 'mija', 'yo', 'me', 'mi', 'mis', 'tengo', 'siento', 'estoy',
  'es', 'vengo',
  'vine', 'acudo', 'ando', 'da', 'dan', 'hay', 'ya', 'como', 'solo',
  'porque', 'pero', 'eso', 'algo',
]); // prettier-ignore

const DENIAL = new Set(['no', 'sin', 'ni', 'nunca', 'niega', 'niegan', 'tampoco', 'nada', 'ningun', 'ninguna', 'ninguno']); // prettier-ignore

/**
 * Someone else's complaint: a companion or a relative (D-260 §16), with its diminutives and the
 * words of the sierra («guagua»), or what hurts someone else («le duele», «a ella»).
 */
const SOMEONE_ELSE = /(^| )((mi|mis|su|sus) (mam\w*|pap\w*|madre|padre|hij\w*|espos\w*|marido|senor\w*|mujer|pareja|novi\w*|herman\w*|abuel\w*|nin\w*|nen\w*|beb\w*|guagu\w*|wawa\w*|ti[oa]s?|prim\w*|niet\w*|suegr\w*|cunad\w*|vecin\w*|amig\w*)|(el|la|los|las) (nin\w*|guagu\w*|wawa\w*|beb\w*|nen\w*)|le (duele|duelen|dolia|pica|arde)|a (el|ella|ellos|ellas)|les? (da|dio|pasa|paso))( |$)/; // prettier-ignore

/**
 * A verb of someone else said by the patient: «el niño tiene fiebre y yo tengo tos». Which
 * symptom is whose a word-by-word check cannot tell, and the names for someone else never end
 * («ñaño», «guambra», «taita»), so the phrase keeps its own words (third clinical review).
 */
const SOMEONE_ELSE_DOES = /(^|[^\p{L}])(tiene|tienen|está|están|siente|sienten|anda|andan|tenía|tenían)(?!\p{L})/iu; // prettier-ignore

/** How much of a duration: «un día» is not «unos días» (second clinical review). */
const QUANTITY = new Set(['unos', 'unas', 'varios', 'varias', 'algunos', 'algunas', 'pocos', 'pocas', 'muchos', 'muchas']); // prettier-ignore

const DURATION = /^(minutos?|horas?|dias?|semanas?|mes|meses|anos?)$/;

/**
 * «dolor» is how a nurse writes «me duele»; «mareo», «me siento mareada»; «se siente», «me
 * siento». The only words compared other than whole: never by a shared root, which made
 * «estrés» of «estreñimiento» (second clinical review).
 */
const LEMMAS: readonly [RegExp, string][] = [
  // Only the present: «me dolió», «me dolía» stay what they are (third clinical review).
  [/^(duel|dolor)/, 'dolor'],
  [/^mare[oa]/, 'mareo'],
  [/^(sient|senti)/, 'sentir'],
];

const lemmaOf = (word: string) =>
  LEMMAS.find(([pattern]) => pattern.test(word))?.[1] ?? null;

/** A short word with its gender and number taken off: «pies» is «pie», never «piel». */
const bare = (word: string) =>
  word
    .replace(/(?<=[aeiou])s$/, '')
    .replace(/(?<=[^aeiou])es$/, '')
    .replace(/[ao]$/, '');

/** The same word: by its lemma, or whole, or with another gender or number. */
function same(a: string, b: string): boolean {
  const lemma = lemmaOf(a);
  if (lemma !== null || lemmaOf(b) !== null) return lemma === lemmaOf(b);
  if (QUANTITY.has(a) || QUANTITY.has(b)) return a === b;
  return a === b || bare(a) === bare(b);
}

/**
 * The phrase without the «no sé» that hesitates —at an end, or before «qué», «si», «cómo»— and
 * the «¿no?» at its end, which deny nothing; «no sé caminar» does.
 */
function spoken(text: string): string {
  return text
    .replace(
      /(^|[^\p{L}])no,?\s+sé(?=\s*([,.;:!?]|$|qu[eé]\b|por\s+qu[eé]\b|si\b|c[oó]mo\b))/giu,
      '$1 ',
    )
    .replace(/,?\s*¿?\s*no\s*\?[\s.!]*$/iu, '');
}

const wordsOf = (text: string): string[] =>
  foldText(text).match(/\p{L}+/gu) ?? [];

/** «un día», «una semana»: one of it, counted as a number. */
const counted = (text: string) =>
  text.replace(/(^|[^\p{L}])(un|una)\s+(minuto|hora|d[ií]a|semana|mes|año)(?!\p{L})/giu, '$1 1 $3'); // prettier-ignore

const numbersOf = (text: string) =>
  spokenNumberRuns(counted(text))
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
  if (SOMEONE_ELSE_DOES.test(phrase)) return false;
  if (said.some((w) => w.startsWith('derech')) && said.some((w) => w.startsWith('izquierd'))) return false; // prettier-ignore
  if (new Set(said.filter((word) => DURATION.test(word)).map(bare)).size > 1) return false; // prettier-ignore
  if (numbers.length > 1) return false;

  // Nothing the patient did not say, and in the order it was said: an onset,
  // a side or how strong it is stays with its symptom (second clinical review).
  if (words.some((word) => DENIAL.has(word))) return false;
  let at = 0;
  const grounded = words.every((word) => {
    if (LINKING.has(word)) return true;
    const found = said.findIndex((each, index) => index >= at && same(word, each)); // prettier-ignore
    if (found < 0) return false;
    at = found;
    return true;
  });
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
