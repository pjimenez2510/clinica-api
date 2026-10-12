/**
 * AS-092 (D-247 §4, D-249 §5). What the recogniser heard, corrected against
 * the CNMB before the model reads it — copied from SigmAI
 * `modules/transcription/lexicon.ts`.
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
  /** What a token may become, bucketed by first letter and length. */
  readonly targets: ReadonlyMap<string, readonly string[]>;
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
  const targets = new Map<string, string[]>();
  const spelling = new Map<string, string>();
  for (const name of input.targets) {
    for (const word of wordsOf(name)) {
      const term = fold(word);
      if (term.length < MIN_LENGTH || NOT_VOCABULARY.has(term)) continue;
      if (spelling.has(term)) continue;
      spelling.set(term, word.toLocaleLowerCase('es'));
      const bucket = bucketOf(term);
      targets.set(bucket, [...(targets.get(bucket) ?? []), term]);
    }
  }
  return { protectedWords, targets, spelling };
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
  const rejoined = rejoin(line, lexicon, () => (changes += 1));
  const text = rejoined.replace(/[\p{L}\p{M}]+/gu, (word) => {
    const key = fold(word);
    if (key.length < MIN_LENGTH || lexicon.protectedWords.has(key)) return word;
    if (lexicon.spelling.has(key)) return word;
    const better = nearest(key, lexicon);
    if (!better) return word;
    changes += 1;
    return matchCase(word, lexicon.spelling.get(better) ?? better);
  });
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
    const joined = fold(first + second);
    const better =
      tail.length >= 3 &&
      !lexicon.protectedWords.has(tail) &&
      !lexicon.spelling.has(tail) &&
      joined.length >= MIN_LENGTH
        ? lexicon.spelling.has(joined)
          ? joined
          : nearest(joined, lexicon)
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

/** The one nearest target, within one edit (two from 8 letters); none on a tie. */
function nearest(key: string, lexicon: Lexicon): string | null {
  const allowed = key.length >= 8 ? 2 : 1;
  let best: string | null = null;
  let bestDistance = allowed + 1;
  let tied = false;
  for (let length = key.length - allowed; length <= key.length + allowed; length += 1) {
    for (const candidate of lexicon.targets.get(`${key[0]}${length}`) ?? []) {
      const distance = within(key, candidate, allowed);
      if (distance === null) continue;
      if (distance < bestDistance) {
        [best, bestDistance, tied] = [candidate, distance, false];
      } else if (distance === bestDistance && candidate !== best) {
        tied = true;
      }
    }
  } // prettier-ignore
  return tied ? null : best;
}

/** Levenshtein, abandoned as soon as the words are further than `allowed`. */
function within(a: string, b: string, allowed: number): number | null {
  if (Math.abs(a.length - b.length) > allowed) return null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let least = row;
    for (let column = 1; column <= b.length; column += 1) {
      const value = Math.min(
        previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1),
        previous[column]! + 1,
        current[column - 1]! + 1,
      );
      current.push(value);
      least = Math.min(least, value);
    }
    if (least > allowed) return null;
    previous = current;
  }
  const distance = previous[b.length]!;
  return distance <= allowed ? distance : null;
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

function bucketOf(term: string): string {
  return `${term[0]}${term.length}`;
}
