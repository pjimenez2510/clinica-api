import { datesNotSaid } from './date-restore';
import type { SuggestionSource, SuggestionStatus } from './suggestion';

/**
 * AS-087 to AS-090, AS-095. The draft of the consultation note, without any
 * model: how the transcript is put to it, what backs each phrase it writes,
 * what nobody said, which sections are on screen, and when the listening asks
 * for the next draft. Adapted from SigmAI `note-writer.adapter.ts`
 * (`sourceRefOf`, `withoutLabel`, `closed`) and `drafting.service.ts`.
 */

/** AS-087. A new draft every three minutes of conversation (D-249 §3). */
export const REDRAFT_EVERY_MS = 180_000;

/** The states of `note_draft.status`. */
export type NoteDraftStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export interface TranscriptLine {
  startMs: number;
  endMs: number;
  text: string;
}

/** One phrase of a proposed section and the line that backs it, if any. */
export interface DraftPhrase {
  text: string;
  /** The stretch of the line that backs it; null when nothing does. */
  fromMs: number | null;
  toMs: number | null;
  /** AS-089. «Nadie lo dijo»: shown marked, never hidden. */
  unsaid: boolean;
}

/** A section of the draft, as it is kept in `ai_suggestion.proposal`. */
export interface DraftSection {
  section: string;
  title: string;
  /** What «Aceptar» writes into the note: the phrases, one after another. */
  text: string;
  phrases: DraftPhrase[];
  sources: SuggestionSource[];
}

/** What the model answers for one section (`note-draft.prompts.ts`). */
export interface AnsweredSection {
  section: string;
  segments: { text: string; source: string | null }[];
}

/**
 * AS-095. The transcript as the model reads it: each line behind a marker it
 * copies (`[L3]`), the whole between the marks of the data. Markers are line
 * numbers and not milliseconds: a seven-digit number in brackets could read
 * as a telephone to the pseudonymizer. A transcript that says the marks
 * itself has them broken, so the data cannot close its own delimiter.
 */
export function conversationOf(lines: readonly TranscriptLine[]): {
  text: string;
  markers: ReadonlyMap<string, TranscriptLine>;
} {
  const markers = new Map<string, TranscriptLine>();
  const body = lines.map((line, index) => {
    const marker = `L${index + 1}`;
    markers.set(marker, line);
    const text = line.text
      .replace(/[\r\n]+/g, ' ')
      .replace(/<\s*\/?\s*conversacion\s*>/gi, '‹conversacion›');
    return `[${marker}] ${text}`;
  });
  return {
    text: ['<conversacion>', ...body, '</conversacion>'].join('\n'),
    markers,
  };
}

/**
 * AS-088, AS-089, AS-091. The sections of the answer as the physician will
 * see them: in the template's order, a section named twice merged, every
 * phrase restored (names, dates), closed, without the label the model copied,
 * and backed only by a line it was given — or marked «Nadie lo dijo».
 */
export function readDraft(input: {
  sections: readonly AnsweredSection[];
  markers: ReadonlyMap<string, TranscriptLine>;
  template: readonly { key: string; title: string }[];
  /** Names and dates back, as the pseudonymizer took them out. */
  restore: (text: string) => string;
  /** What was said, to check the dates of each phrase against. */
  said: string;
}): DraftSection[] {
  return input.template.flatMap(({ key, title }) => {
    const phrases = input.sections
      .filter((answered) => answered.section === key)
      .flatMap((answered) => answered.segments)
      .map((segment): DraftPhrase | null => {
        const text = closed(withoutLabel(input.restore(segment.text), title));
        if (text === '') return null;
        const line = lineOf(segment.source, input.markers);
        const unsaid = !line || datesNotSaid(text, input.said).length > 0;
        return unsaid
          ? { text, fromMs: null, toMs: null, unsaid: true }
          : { text, fromMs: line.startMs, toMs: line.endMs, unsaid: false };
      })
      .filter((phrase): phrase is DraftPhrase => phrase !== null);
    if (phrases.length === 0) return [];
    return [
      {
        section: key,
        title,
        text: phrases.map((phrase) => phrase.text).join(' '),
        phrases,
        sources: sourcesOf(phrases),
      },
    ];
  });
}

/** SC-091. A section none of whose phrases anybody said. */
export function inventedSection(section: DraftSection): boolean {
  return section.phrases.every((phrase) => phrase.unsaid);
}

/** AS-087. Whether the transcript passed the last draft asked for by 3 min. */
export function draftDue(
  transcriptUpToMs: number,
  lastRequestedUpToMs: number | null,
): boolean {
  return transcriptUpToMs - (lastRequestedUpToMs ?? 0) >= REDRAFT_EVERY_MS;
}

/** A section of a draft as it was kept, with what the physician did with it. */
export interface StoredDraftSection {
  id: string;
  draftId: string;
  section: string;
  text: string;
  status: SuggestionStatus;
  proposedAt: Date;
}

/**
 * AS-090. What the screen shows: the sections of the latest finished draft,
 * not discarded, and not equal to one the physician already accepted or
 * discarded from an earlier draft — the same words three minutes later are
 * not a new proposal.
 */
export function shownSections<S extends StoredDraftSection>(
  stored: readonly S[],
  latestDraftId: string | null,
): S[] {
  if (latestDraftId === null) return [];
  const decided = new Set(
    stored
      .filter(
        (each) => each.draftId !== latestDraftId && each.status !== 'PROPOSED',
      ) // prettier-ignore
      .map((each) => `${each.section}\u0000${each.text}`),
  );
  return stored.filter(
    (each) =>
      each.draftId === latestDraftId &&
      each.status !== 'DISCARDED' &&
      !decided.has(`${each.section}\u0000${each.text}`),
  );
}

/** A marker the model was never given is not a citation (SigmAI `sourceRefOf`). */
function lineOf(
  source: string | null,
  markers: ReadonlyMap<string, TranscriptLine>,
): TranscriptLine | null {
  if (source === null) return null;
  const marker = source
    .trim()
    .replace(/^\[|\]$/g, '')
    .toUpperCase();
  return markers.get(marker) ?? null;
}

/** Each line cited once, in order of the conversation. */
function sourcesOf(phrases: readonly DraftPhrase[]): SuggestionSource[] {
  const seen = new Map<number, SuggestionSource>();
  for (const phrase of phrases) {
    if (phrase.fromMs === null || phrase.toMs === null) continue;
    if (!seen.has(phrase.fromMs)) {
      seen.set(phrase.fromMs, { kind: 'transcript', fromMs: phrase.fromMs, toMs: phrase.toMs }); // prettier-ignore
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.kind === 'transcript' && b.kind === 'transcript'
      ? a.fromMs - b.fromMs
      : 0,
  );
}

/**
 * A sentence ends in a full stop: the phrases are joined with a space, and an
 * open one would run into the next.
 */
function closed(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return '';
  const capital = trimmed.charAt(0).toLocaleUpperCase('es') + trimmed.slice(1);
  return /[.?!:;]$/.test(capital) ? capital : `${capital}.`;
}

/** The screen writes the label; a model that copied it would have it twice. */
function withoutLabel(text: string, title: string): string {
  const folded = (value: string) =>
    value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const prefix = `${folded(title)}:`;
  return folded(text).trimStart().startsWith(prefix)
    ? text.trimStart().slice(prefix.length).trim()
    : text.trim();
}
