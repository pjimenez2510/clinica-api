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

/** A phrase shorter than this matches anything: «sí», «no», «tos». */
const SHORTEST_QUOTE = 4;

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

/**
 * AS-028. Keeps the problems whose phrase is in the cleared text the model
 * read AND, with the placeholders put back, in the note itself, in the
 * section where it is. A problem without its phrase is a problem nobody
 * wrote: it is dropped, and counted.
 */
export function backedProblems(input: {
  named: readonly NamedProblem[];
  cleared: string;
  sections: readonly { key: string; text: string }[];
  restore: (text: string) => string;
}): { kept: BackedProblem[]; dropped: number } {
  const cleared = foldText(input.cleared);
  const sections = input.sections.map((section) => ({
    key: section.key,
    folded: foldText(section.text),
  }));
  const kept: BackedProblem[] = [];

  for (const named of input.named) {
    const asRead = foldText(named.quote);
    if (asRead.length < SHORTEST_QUOTE || !cleared.includes(asRead)) continue;
    const quote = input.restore(named.quote).trim();
    const section = sections.find(({ folded }) =>
      folded.includes(foldText(quote)),
    );
    if (!section) continue;
    kept.push({
      problem: input.restore(named.problem).trim(),
      quote,
      section: section.key,
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
