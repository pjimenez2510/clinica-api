/**
 * AS-260 to AS-264. What the conversation said of the patient's chart —
 * «sin alergias conocidas», each allergy, each personal or family history
 * entry —, checked against the line the model cited, and what of it the
 * screen shows against what the chart already has. No model, no database, no
 * clock.
 *
 * D-261 (the author, 13-10-2026, changing D-249 §1): what is said of the
 * chart goes to the chart as records, not to the note as prose. The chart
 * itself still never goes to the model: what it already has is taken out
 * here, afterwards.
 */
import {
  chartRecordText,
  NO_KNOWN_ALLERGIES,
  type ChartHistoryEntry,
} from '../../../shared/clinical/chart-background.port';

import { lineOf, type TranscriptLine } from './note-draft';
import { spokenIn } from './order-reading';
import { foldText } from './problem-coding';

/** AS-262. The relatives a family entry may name: the chart's own words. */
export const RELATIVES = [
  'Madre',
  'Padre',
  'Hermano',
  'Hermana',
  'Hijo',
  'Hija',
  'Abuelo',
  'Abuela',
  'Tío',
  'Tía',
] as const;
export type Relative = (typeof RELATIVES)[number];

/** AS-262. How each relative is said, folded: «mamá» says `Madre`. */
const SAID_AS: Readonly<Record<Relative, RegExp>> = {
  Madre: /\b(?:madre|mama|mami|mamita)s?\b/,
  Padre: /\b(?:padre|papa|papi|papito)s?\b/,
  Hermano: /\bhermanos?\b/,
  Hermana: /\bhermanas?\b/,
  Hijo: /\bhijos?\b/,
  Hija: /\bhijas?\b/,
  Abuelo: /\babuel(?:o|os|ito)\b/,
  Abuela: /\babuel(?:a|as|ita)\b/,
  Tío: /\btios?\b/,
  Tía: /\btias?\b/,
};

/** AS-260. The answer of the model, every text still unchecked. */
export interface ChartAnswer {
  noKnownAllergies: { source: string | null } | null;
  allergies: {
    substance: string;
    reaction: string | null;
    source: string | null;
  }[];
  history: {
    kind: 'PERSONAL' | 'FAMILY';
    description: string;
    relative: string | null;
    source: string | null;
  }[];
}

/** The stretch of the line a proposal comes from (P2): the line is read again, never kept. */
interface Stretch {
  fromMs: number;
  toMs: number;
}

/** AS-260. A proposal of the chart, as `ai_suggestion.proposal` keeps it. */
export type ChartProposal =
  | ({ kind: 'chart-no-allergy'; text: string } & Stretch)
  | ({
      kind: 'chart-allergy';
      text: string;
      substance: string;
      reaction: string | null;
      /**
       * EN-084. The CNMB medicine the substance IS, when it is one: without
       * it the receta cannot check the allergy (PR-064). Null otherwise.
       */
      substanceConceptId?: string | null;
    } & Stretch)
  | ({
      kind: 'chart-history';
      text: string;
      history: 'PERSONAL' | 'FAMILY';
      description: string;
      relative: Relative | null;
    } & Stretch);

/** The limits of the chart's own columns: what does not fit is no proposal. */
const SUBSTANCE_LIMIT = 240;
const REACTION_LIMIT = 512;
const DESCRIPTION_LIMIT = 500;

/** A bidi or zero-width character shows one text and says another (security review of C3). */
const plain = (text: string) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The longest word of a name: what its line has to say. */
function headWord(name: string): string {
  return (
    foldText(name)
      .split(/[^\p{L}]+/u)
      .filter((word) => word.length >= 3)
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}

const says = (line: string, word: string) =>
  word !== '' && new RegExp(`(^|[^\\p{L}])${word}`, 'u').test(foldText(line));

/** The sentences of a line; a question («¿…?») is never what the patient states. */
function statements(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+|(?=¿)/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence !== '' && !sentence.includes('?') && !sentence.startsWith('¿'),
    ) // prettier-ignore
    .map(foldText);
}

/** AS-262. An allergy denied in the sentence: «no soy alérgico», «niega alergias». */
const DENIED_ALLERGY = /\b(?:no|nunca|ni)\s+(?:\p{L}+\s+){0,2}alergi|\bniega/u;
/** AS-262. «Sin alergias» as the patient says it. */
const NO_ALLERGY =
  /\b(?:ningun[ao]?|que yo sepa|no tengo alergi|no soy alergic|sin alergi|niega alergi)/;
/** AS-262. An allergy stated: «soy alérgica a…», «alergia a…». */
const STATED_ALLERGY = /\balergi(?:c[oa]s?|as?)\s+a\b/;

/** AS-262. The first letters of a disease's name: «hipertens» says «Hipertensión». */
function stemOf(description: string): string {
  const head = headWord(description);
  return head.length > 7 ? head.slice(0, 7) : head;
}

/** AS-262. A disease said and not denied right before it («no es hipertensa»). */
function saysDisease(sentence: string, stem: string): boolean {
  if (stem === '' || !says(sentence, stem)) return false;
  return !new RegExp(`\\b(?:no|nunca|niega|nadie|ningun\\p{L}*)\\s+(?:\\p{L}+\\s+)?${stem}`, 'u').test(sentence); // prettier-ignore
}

/**
 * AS-260, AS-262. The proposals the answer backs: each with a line the
 * model was given; an allergy whose substance that line names; a family
 * entry whose relative is of the list and said in that line; and no «sin
 * alergias» beside an allergy of the same reading. Restored (names, dates),
 * each once. `dropped` counts what had nothing behind it.
 */
export function backedChart(input: {
  answer: ChartAnswer;
  markers: ReadonlyMap<string, TranscriptLine>;
  restore: (text: string) => string;
}): { kept: ChartProposal[]; dropped: number } {
  const kept: ChartProposal[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  const keep = (proposal: ChartProposal) => {
    // One allergy per substance, whatever reaction each mention gave it.
    const said =
      proposal.kind === 'chart-allergy' ? proposal.substance : proposal.text;
    const key = `${proposal.kind}\u0000${foldText(said)}`;
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(proposal);
  };
  const restored = (text: string | null) =>
    text === null ? null : plain(input.restore(text)) || null;

  const allergies: ChartProposal[] = [];
  for (const each of input.answer.allergies) {
    const line = lineOf(each.source, input.markers);
    const substance = restored(each.substance);
    const reaction = restored(each.reaction);
    if (
      !line ||
      substance === null ||
      substance.length > SUBSTANCE_LIMIT ||
      (reaction?.length ?? 0) > REACTION_LIMIT ||
      // Stated, not asked and not denied: «¿Es alérgica a la penicilina?» —
      // «No» names the penicillin too (clinical review I2).
      !statements(line.text).some(
        (sentence) =>
          says(sentence, headWord(substance)) && !DENIED_ALLERGY.test(sentence),
      )
    ) {
      dropped += 1;
      continue;
    }
    allergies.push({
      kind: 'chart-allergy',
      text: chartRecordText({ kind: 'allergy', substance, reaction }),
      substance,
      reaction,
      fromMs: line.startMs,
      toMs: line.endMs,
    });
  }

  const none = input.answer.noKnownAllergies;
  if (none) {
    const line = lineOf(none.source, input.markers);
    // P5 (clinical review G1): the line says there is none, and states no
    // allergy; a reading that says both is contradicting itself.
    const sentences = line ? statements(line.text) : [];
    const backed =
      sentences.some((sentence) => NO_ALLERGY.test(sentence)) &&
      !sentences.some(
        (sentence) => STATED_ALLERGY.test(sentence) && !DENIED_ALLERGY.test(sentence), // prettier-ignore
      );
    if (!line || !backed || allergies.length > 0) dropped += 1;
    else {
      keep({ kind: 'chart-no-allergy', text: NO_KNOWN_ALLERGIES, fromMs: line.startMs, toMs: line.endMs }); // prettier-ignore
    }
  }
  allergies.forEach(keep);

  for (const each of input.answer.history) {
    const line = lineOf(each.source, input.markers);
    const description = restored(each.description);
    const relative =
      each.kind === 'FAMILY'
        ? (RELATIVES.find((known) => known === each.relative?.trim()) ?? null)
        : null;
    // The disease said, not denied, in a sentence that is no question; and a
    // family one with its relative in that same sentence (clinical review I2).
    const backed =
      line !== null &&
      description !== null &&
      description.length <= DESCRIPTION_LIMIT &&
      (each.kind === 'PERSONAL' || relative !== null) &&
      statements(line.text).some(
        (sentence) =>
          saysDisease(sentence, stemOf(description)) &&
          (relative === null || SAID_AS[relative].test(sentence)),
      );
    if (!backed) {
      dropped += 1;
      continue;
    }
    keep({
      kind: 'chart-history',
      text: chartRecordText({ kind: 'history', description, relative }),
      history: each.kind,
      description,
      relative,
      fromMs: line.startMs,
      toMs: line.endMs,
    });
  }
  return { kept, dropped };
}

/** A stored proposal of the chart, as this module reads it back. */
export interface StoredChartProposal {
  id: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'DISCARDED';
  proposal: Readonly<Record<string, unknown>>;
}

/** What the chart holds now, as the proposals are compared with it. */
export interface ChartNow {
  /** The substances of the active allergies, as recorded. */
  allergies: readonly string[];
  /** A standing «sin alergias conocidas» (EN-087). */
  absence: boolean;
  history: readonly ChartHistoryEntry[];
}

/** AS-263. A proposal of the chart on screen. */
export type ChartProposalView = ChartProposal & {
  id: string;
  /** AS-263 (P2). Its line, read again from the transcript. */
  quote: string;
  /** AS-264. Why it cannot be recorded as it is. */
  conflict: 'active-allergy' | null;
};

const sameText = (left: string, right: string) =>
  foldText(left).replace(/\s+/g, ' ').trim() ===
  foldText(right).replace(/\s+/g, ' ').trim();

/**
 * AS-263, AS-264. What Antecedentes shows of the current reading: the
 * undecided proposals whose line the transcript still has, less what the
 * chart already has and what was discarded in this attention; «sin
 * alergias» against an active allergy carries its conflict.
 */
export function shownChart(
  stored: readonly StoredChartProposal[],
  discarded: readonly string[],
  chart: ChartNow,
  transcript: readonly TranscriptLine[],
): ChartProposalView[] {
  const views = stored.flatMap((each): ChartProposalView[] => {
    if (each.status !== 'PROPOSED') return [];
    const proposal = each.proposal as unknown as ChartProposal;
    if (typeof proposal.text !== 'string') return [];
    if (discarded.some((text) => sameText(text, proposal.text))) return [];
    let conflict: ChartProposalView['conflict'] = null;
    if (proposal.kind === 'chart-no-allergy') {
      if (chart.absence) return [];
      if (chart.allergies.length > 0) conflict = 'active-allergy';
    }
    if (
      proposal.kind === 'chart-allergy' &&
      chart.allergies.some((substance) => sameText(substance, proposal.substance)) // prettier-ignore
    ) {
      return [];
    }
    if (
      proposal.kind === 'chart-history' &&
      chart.history.some(
        (entry) =>
          entry.kind === proposal.history &&
          sameText(entry.description, proposal.description) &&
          sameText(entry.relative ?? '', proposal.relative ?? ''),
      )
    ) {
      return [];
    }
    const said = spokenIn(proposal, transcript);
    if (said === '') return [];
    return [{ ...proposal, id: each.id, quote: sentenceOf(proposal, said), conflict }]; // prettier-ignore
  });
  // P5 (clinical review G1). An allergy said and not yet decided, of this
  // reading or an earlier one, and «sin alergias» is never offered beside it.
  return views.some((view) => view.kind === 'chart-allergy')
    ? views.filter((view) => view.kind !== 'chart-no-allergy')
    : views;
}

/**
 * AS-263 (clinical review G1). The proposals of the latest reading, and the
 * allergies of an earlier one still undecided: a later reading that missed
 * an allergy said earlier does not make it disappear.
 */
export function currentChartReading<
  S extends StoredChartProposal & {
    aiRunId: string;
    proposedAt: Date;
    kind: string;
  },
>(stored: readonly S[]): S[] {
  const latest = stored.reduce<S | null>(
    (last, each) => (last === null || each.proposedAt > last.proposedAt ? each : last), // prettier-ignore
    null,
  );
  if (!latest) return [];
  const current = stored.filter((each) => each.aiRunId === latest.aiRunId);
  const substances = new Set(
    current.flatMap(
      (each) =>
      typeof each.proposal.substance === 'string' ? [foldText(each.proposal.substance)] : [], // prettier-ignore
    ),
  );
  const earlier = stored.filter(
    (each) =>
      each.aiRunId !== latest.aiRunId &&
      each.kind === 'chart-allergy' &&
      each.status === 'PROPOSED' &&
      typeof each.proposal.substance === 'string' &&
      !substances.has(foldText(each.proposal.substance)),
  );
  return [...current, ...earlier];
}

/** AS-261. What, in a sentence, says the proposal: the words it is checked by. */
function saysIt(proposal: ChartProposal, folded: string): boolean {
  if (proposal.kind === 'chart-no-allergy') {
    return /\b(?:ningun[ao]?|que yo sepa|no tengo alergi|no soy alergic)/.test(folded); // prettier-ignore
  }
  if (proposal.kind === 'chart-allergy') return says(folded, headWord(proposal.substance)); // prettier-ignore
  if (proposal.relative !== null)
    return SAID_AS[proposal.relative].test(folded);
  return says(folded, headWord(proposal.description));
}

/**
 * AS-261 (P2). The sentence of the line that says it: the recogniser cuts
 * the conversation in stretches of up to 20 s, and the whole stretch under a
 * proposal reads as noise. Without a sentence that says it, the stretch.
 */
export function sentenceOf(proposal: ChartProposal, said: string): string {
  const sentences = said
    .split(/(?<=[.!?¿])\s+|(?=¿)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
  const sentence = sentences.find((each) => saysIt(proposal, foldText(each)));
  if (sentence !== undefined && sentence.split(/\s+/).length <= LONGEST_QUOTE) {
    return sentence;
  }
  // Unpunctuated, or one long sentence: the words around what says it.
  const words = (sentence ?? said).split(/\s+/);
  const saysIn = (from: number, to: number) =>
    saysIt(proposal, foldText(words.slice(from, to).join(' ')));
  for (let at = 0; at < words.length; at += 1) {
    if (!saysIn(at, at + WINDOW)) continue;
    let end = at;
    while (end < at + WINDOW && !saysIn(at, end + 1)) end += 1;
    const from = Math.max(0, end - WINDOW);
    const to = Math.min(words.length, end + WINDOW);
    return `${from > 0 ? '…' : ''}${words.slice(from, to).join(' ')}${to < words.length ? '…' : ''}`; // prettier-ignore
  }
  return sentence ?? said;
}

/** AS-261. A quote longer than this many words reads as noise. */
const LONGEST_QUOTE = 16;
/** The words around what says it, when the sentence is too long or missing. */
const WINDOW = 6;
