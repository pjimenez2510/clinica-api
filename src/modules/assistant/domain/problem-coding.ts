/**
 * AS-027, AS-028, AS-035, AS-036. The rules of «Proponer por problema» that
 * need no model, no database and no clock: whether a problem's phrase is in
 * the note, which baseline codes are offered, and which reading is current.
 *
 * Copied and adapted from SigmAI (`modules/coding/problems.ts` and
 * `coding.service.ts`): there the phrase was checked against the transcript;
 * here, until C1, against the note.
 */

/** The physician gets five per list (RF-F01 of SigmAI). More is a list nobody reads. */
export const PROPOSED = 5;

/** What the model named, before anything is checked. */
export interface NamedProblem {
  problem: string;
  quote: string;
  codes: readonly string[];
}

/** A problem whose phrase the note does contain, with the originals put back. */
export interface BackedProblem {
  problem: string;
  quote: string;
  /** The section of the note the phrase is in (P2: where it comes from). */
  section: string;
  codes: readonly string[];
}

/**
 * A phrase shorter than this, or of one word, matches anything: «sí», «no»,
 * «tos», «de la», «dolor» (review of 11-10-2026: four characters let «de l»
 * through as the source of a problem).
 */
const SHORTEST_QUOTE = 8;
const FEWEST_QUOTE_WORDS = 2;

/**
 * Words that, right before the phrase, say the note DENIES it: «Niega dolor
 * torácico» quoted as «dolor torácico» backs nothing (D-245 §5). Folded, as
 * `foldText` leaves them.
 */
const NEGATIONS = new Set([
  'niega',
  'niegan',
  'sin',
  'no',
  'descarta',
  'descartado',
  'descartada',
  'negativo',
  'negativa',
  'ausencia',
]);
/** How many words before the phrase a negation still governs it. */
const NEGATION_REACH = 3;

/**
 * The comparison form of a text: lowercase, without accents, every run of
 * spaces as one. A model that writes «Odinofagia de 3 días» for «odinofagia
 * de 3  dias» quoted the note; one that paraphrases it did not.
 */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where a phrase is in the note: its section and the sentence that holds it. */
export interface LocatedQuote {
  section: string;
  /** The note's own sentence, as written: what the physician reads (P2). */
  sentence: string;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * AS-028. The sentence of the note that holds the phrase as whole words, or
 * null: not there, too short to mean anything, or right after a negation of
 * the same sentence.
 */
export function locateQuote(
  quote: string,
  sections: readonly { key: string; text: string }[],
): LocatedQuote | null {
  const folded = foldText(quote);
  if (
    folded.length < SHORTEST_QUOTE ||
    folded.split(' ').length < FEWEST_QUOTE_WORDS
  ) {
    return null;
  }
  const whole = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(folded)}($|[^\\p{L}\\p{N}])`,
    'u',
  );
  for (const section of sections) {
    for (const sentence of section.text.split(/(?<=[.;!?\n])/)) {
      const plain = foldText(sentence);
      const match = whole.exec(plain);
      if (!match) continue;
      const before = plain
        .slice(0, match.index + match[1]!.length)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .slice(-NEGATION_REACH);
      if (before.some((word) => NEGATIONS.has(word))) return null;
      return { section: section.key, sentence: sentence.trim() };
    }
  }
  return null;
}

/**
 * AS-025 (P4). What a pseudonymizer must never let through, checked again on
 * its answer: an e-mail, a RUC (13 digits), a mobile (09…), a cedula (10
 * digits) or a chart number (HC and ten digits) — the patterns the log uses.
 */
const IDENTIFIERS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b\d{13}\b/,
  /\b09\d{8}\b/,
  /\b\d{10}\b/,
  /\bHC\d{10}\b/i,
];

export function carriesAnIdentifier(text: string): boolean {
  return IDENTIFIERS.some((pattern) => pattern.test(text));
}

/** A date in a problem's name was moved by the pseudonymizer: never shown. */
const DATE_LIKE = /\d{1,4}\s*[/-]\s*\d{1,2}(\s*[/-]\s*\d{1,4})?/;

/**
 * AS-028. Keeps the problems whose phrase is in the cleared text the model
 * read AND, with the placeholders put back, in the note itself as whole
 * words and not denied there. What is kept carries the note's own sentence.
 * A problem without its phrase is a problem nobody wrote: it is dropped, and
 * counted; so is one whose name carries a date the pseudonymizer moved.
 */
export function backedProblems(input: {
  named: readonly NamedProblem[];
  cleared: string;
  sections: readonly { key: string; text: string }[];
  restore: (text: string) => string;
}): { kept: BackedProblem[]; dropped: number } {
  const cleared = foldText(input.cleared);
  const kept: BackedProblem[] = [];

  for (const named of input.named) {
    if (!cleared.includes(foldText(named.quote))) continue;
    const problem = input.restore(named.problem).trim();
    if (problem === '' || DATE_LIKE.test(problem)) continue;
    const located = locateQuote(input.restore(named.quote).trim(), input.sections); // prettier-ignore
    if (!located) continue;
    kept.push({
      problem,
      quote: located.sentence,
      section: located.section,
      codes: named.codes,
    });
  }

  return { kept, dropped: input.named.length - kept.length };
}

/** A code of the catalogue as the screen offers it. */
export interface OfferedCode {
  conceptId: string;
  code: string;
  display: string;
}

export type BaselineSource = 'history' | 'frequency';

export interface BaselineCode extends OfferedCode {
  source: BaselineSource;
  /** How many attentions recorded it, in the patient's history or the clinic's window. */
  times: number;
  lastUsedOn: string;
}

/**
 * AS-027. The codes offered with nothing read: the patient's own history
 * first, then what the clinic records most, without what this attention
 * already has and without what the catalogue no longer has in force on the
 * clinical date (`resolved` is the lookup of every code, by code).
 */
export function baselineOf(input: {
  history: readonly { code: string; times: number; lastUsedOn: string }[];
  frequency: readonly { code: string; times: number; lastUsedOn: string }[];
  recorded: readonly string[];
  resolved: ReadonlyMap<string, OfferedCode>;
}): BaselineCode[] {
  const seen = new Set(input.recorded);
  const offered: BaselineCode[] = [];
  const add = (
    uses: readonly { code: string; times: number; lastUsedOn: string }[],
    source: BaselineSource,
  ) => {
    for (const use of uses) {
      const entry = input.resolved.get(use.code);
      if (!entry || seen.has(entry.code)) continue;
      seen.add(entry.code);
      offered.push({ ...entry, source, times: use.times, lastUsedOn: use.lastUsedOn }); // prettier-ignore
    }
  };
  add(input.history, 'history');
  add(input.frequency, 'frequency');
  return offered.slice(0, PROPOSED);
}

/** AS-036. What is kept of a problem in `ai_suggestion.proposal`. */
export interface DiagnosisProposal {
  problem: string;
  quote: string;
  section: string;
  /** The resolved codes, in the model's order: what AS-022's distance reads. */
  codes: string[];
  candidates: OfferedCode[];
  /** AS-029. Written by the fake of the demonstration mode, not by a model. */
  demo: boolean;
}

/** The fields of a stored proposal this module reads back. */
export interface StoredProposal {
  id: string;
  aiRunId: string;
  status: string;
  proposedAt: Date;
}

/**
 * AS-036. The proposals on screen are those of the latest reading — the
 * attempt that answered last — less the discarded (AS-038). An older reading
 * stays in the table, undecided or not, and is no longer shown.
 */
export function currentReading<S extends StoredProposal>(
  stored: readonly S[],
): S[] {
  const latest = stored.reduce<S | null>(
    (last, each) =>
      last === null || each.proposedAt > last.proposedAt ? each : last,
    null,
  );
  if (!latest) return [];
  return stored.filter(
    (each) => each.aiRunId === latest.aiRunId && each.status !== 'DISCARDED',
  );
}
