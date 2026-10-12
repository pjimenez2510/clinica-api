/**
 * AS-092 (D-247 §4, D-249 §5). What the recogniser heard, corrected against
 * the CNMB before the model reads it — adapted from SigmAI
 * `modules/transcription/lexicon.ts`, and narrowed after the clinical review
 * of 12-10-2026: ONLY A WORD THE RECOGNISER SPLIT IN TWO IS JOINED, and only
 * when the joined word IS an active principle of the CNMB, letter for letter
 * (a letter repeated at the seam counts once: «para acetamol» → «paracetamol»).
 *
 * SigmAI also corrected a word one or two edits away from a principle. Against
 * the real CNMB that turned «metamizol» into «metimazol», «cefixima» into
 * «cefepima» and «un litro» into «un litio»: a drug said right became another
 * drug, and the draft wrote it as said. A wrong word left alone is something
 * the physician reads and fixes; a right word changed is not.
 *
 * Speech recognition turns a word it does not know into words it does:
 * whisper wrote «para acetamol» in E-031, SigmAI saw «los artán» and
 * «en april». The draft would copy them, and a drug name misheard is exactly
 * what must not reach the note.
 *
 * Two rules keep it safe. **It only ever corrects TOWARDS an active principle
 * of the CNMB**, so a correction can produce a drug and nothing else — «sarna»
 * never becomes «asma». And **a protected word is never touched**: the words
 * of the CIE-10 and those the clinic writes in its notes. A word equally close
 * to two principles is left alone: guessing between «amlodipino» and
 * «amilorida» is how a correction becomes a different drug.
 *
 * Pure: the vocabulary is read elsewhere and handed in.
 */

/** Below this a word is too short for an edit to be evidence of anything. */
const MIN_LENGTH = 5;

/**
 * Presentation noise of drug names and ordinary words that a catalogue name
 * carries: never something to correct towards.
 */
const NOT_VOCABULARY = new Set([
  'capsulas',
  'tabletas',
  'grageas',
  'ampolla',
  'jarabe',
  'frasco',
  'crema',
  'gotas',
  'sobre',
  'caja',
  'para',
  'control',
  'dosis',
  'fuerte',
  'oral',
  'solucion',
  'suspension',
  'liquido',
  'solido',
  'polvo',
  'otros',
  'otras',
]);

export interface Lexicon {
  /** Never corrected, whatever they look like. */
  readonly protectedWords: ReadonlySet<string>;
  /** The CNMB's spelling of each target, accents included. */
  readonly spelling: ReadonlyMap<string, string>;
}

export function buildLexicon(input: {
  /** The active principles of the CNMB, as the catalogue writes them. */
  targets: Iterable<string>;
  protectedWords: Iterable<string>;
}): Lexicon {
  const protectedWords = new Set<string>();
  for (const word of input.protectedWords) {
    for (const each of wordsOf(word)) protectedWords.add(fold(each));
  }
  const spelling = new Map<string, string>();
  for (const name of input.targets) {
    for (const word of wordsOf(name)) {
      const term = fold(word);
      if (term.length < MIN_LENGTH || NOT_VOCABULARY.has(term)) continue;
      if (spelling.has(term)) continue;
      spelling.set(term, word.toLocaleLowerCase('es'));
    }
  }
  return { protectedWords, spelling };
}

/**
 * AS-092. A line of recognised speech, corrected; and how many words changed
 * — a count, never the words, which are what the patient said (AS-095).
 */
export function correctLine(
  line: string,
  lexicon: Lexicon,
): { text: string; changes: number } {
  let changes = 0;
  const text = rejoin(line, lexicon, () => (changes += 1));
  return { text, changes };
}

/**
 * A word the recogniser split in two, put back together («para acetamol»,
 * «los artán») — only when the second half is not a protected word, so
 * «los pacientes» is never joined.
 */
function rejoin(line: string, lexicon: Lexicon, changed: () => void): string {
  // A sliding window and not a global replace: in «con los artán» the pair
  // «con los» would eat «los» and the pair that matters is never seen.
  const pieces = line.split(/(\s+)/);
  const out: string[] = [];
  for (let at = 0; at < pieces.length; at += 1) {
    const first = pieces[at]!;
    const second = pieces[at + 2];
    if (second === undefined || !isWord(first) || !isWord(second)) {
      out.push(first);
      continue;
    }
    const tail = fold(second);
    const joined = seamless(fold(first), tail);
    const better =
      tail.length >= 3 &&
      !lexicon.protectedWords.has(tail) &&
      !lexicon.spelling.has(tail) &&
      joined.length >= MIN_LENGTH &&
      lexicon.spelling.has(joined)
        ? joined
        : null;
    if (better) {
      changed();
      out.push(matchCase(first, lexicon.spelling.get(better) ?? better));
      at += 2;
    } else {
      out.push(first);
    }
  }
  return out.join('');
}

/** Two halves as one word, the letter repeated at the seam once. */
function seamless(first: string, second: string): string {
  return first.at(-1) === second[0] ? first + second.slice(1) : first + second;
}

function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{M}]+/gu) ?? [];
}

function isWord(piece: string | undefined): piece is string {
  return piece !== undefined && /^[\p{L}\p{M}]+$/u.test(piece);
}

/** The recogniser capitalises after a full stop; a correction keeps it. */
function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toLocaleUpperCase('es')) {
    return replacement.toLocaleUpperCase('es');
  }
  if (original[0] === original[0]?.toLocaleUpperCase('es')) {
    return replacement.charAt(0).toLocaleUpperCase('es') + replacement.slice(1);
  }
  return replacement;
}

function fold(value: string): string {
  return value.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
