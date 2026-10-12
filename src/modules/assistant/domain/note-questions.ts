import { conversationOf, lineOf, type TranscriptLine } from './note-draft';
import { spokenIn } from './order-reading';
import type { SuggestionStatus } from './suggestion';

/**
 * AS-119 to AS-124. The questions «Para completar la nota», without any
 * model: what the model reads, which of its questions may be shown, and which
 * are on screen. Adapted from SigmAI `modules/drafting/questions.ts`
 * (`backedQuestions`): a question with nothing behind it is dropped, not shown
 * without it — here the line of the conversation its marker points at, as the
 * phrases of the draft (AS-089), instead of a quote looked for in the text.
 */

/** AS-120. Five at most: a longer list is the one that stops being read (P8). */
export const MOST_QUESTIONS = 5;

/** A question as the model answers it (`note-questions.prompts.ts`). */
export interface AnsweredQuestion {
  text: string;
  source: string | null;
  section: string | null;
}

/** A question that may be shown, as it is kept in `ai_suggestion.proposal`. */
export interface BackedQuestion {
  text: string;
  /** A prose section of the note's template, or null. */
  section: string | null;
  /** AS-121. The stretch of its line: the line itself is read back, never kept. */
  fromMs: number;
  toMs: number;
}

/**
 * AS-120. Whether two questions say the same: without case, accents, signs
 * or extra spaces. A question the professional put away does not come back
 * worded with a capital letter.
 */
export function questionKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * AS-120. The questions that may be shown: backed by a line the model was
 * given, five at most, none twice and none the professional discarded, each
 * restored (names, dates) and with a section only when it is one of the
 * template's prose sections. `dropped` counts those that had no line.
 */
export function backedQuestions(input: {
  answered: readonly AnsweredQuestion[];
  markers: ReadonlyMap<string, TranscriptLine>;
  /** The keys of the template's `TEXT` sections. */
  textSections: readonly string[];
  /** The text of the questions discarded in this attention. */
  discarded: readonly string[];
  restore: (text: string) => string;
}): { kept: BackedQuestion[]; dropped: number } {
  const seen = new Set(input.discarded.map(questionKey));
  const sections = new Set(input.textSections);
  const kept: BackedQuestion[] = [];
  let dropped = 0;

  for (const answered of input.answered) {
    const text = input.restore(answered.text).replace(/\s+/g, ' ').trim();
    const line = lineOf(answered.source, input.markers);
    if (text === '' || !line) {
      dropped += 1;
      continue;
    }
    const key = questionKey(text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    kept.push({
      text,
      section:
        answered.section !== null && sections.has(answered.section)
          ? answered.section
          : null,
      fromMs: line.startMs,
      toMs: line.endMs,
    });
    if (kept.length === MOST_QUESTIONS) break;
  }
  return { kept, dropped };
}

/** One section of the note as it reads now. */
export interface WrittenSection {
  key: string;
  title: string;
  text: string;
}

/**
 * AS-119, AS-124. The conversation as the model reads it: C2's lines with
 * their markers, with the marks of the note's block broken too.
 */
export function questionsConversation(lines: readonly TranscriptLine[]) {
  return conversationOf(
    lines.map((line) => ({ ...line, text: withoutMarks(line.text) })),
  );
}

/**
 * AS-119, AS-124. What the note has written, section by section, after the
 * conversation and between its own marks. A note with nothing says so: the
 * model is not left to guess whether it was sent.
 */
export function noteBlock(sections: readonly WrittenSection[]): string {
  const flat = (text: string) =>
    withoutMarks(text)
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const written = sections
    .map((section) => ({ ...section, text: flat(section.text) }))
    .filter((section) => section.text !== '')
    .map((section) => `- ${section.key} · ${flat(section.title)}: ${section.text}`); // prettier-ignore
  return ['<nota>', ...(written.length > 0 ? written : ['(sin nada escrito)']), '</nota>'].join('\n'); // prettier-ignore
}

/**
 * AS-123. What the digest of the note is taken over: each section's text,
 * trimmed, in the template's order. The same writing gives the same digest;
 * a new word, another.
 */
export function noteDigestInput(
  sections: readonly { key: string; text: string }[],
): string {
  return sections
    .map((section) => `${section.key}\u0000${section.text.trim()}`)
    .join('\u0001');
}

/**
 * AS-124. The marks of the data broken where the text says them, also with an
 * accent or in full width: the data cannot close its own block (AS-095).
 */
function withoutMarks(text: string): string {
  const mark = /<\s*(\/?)\s*(nota|conversaci[oó]n)\s*>/giu;
  // Only a text that says a mark is folded: «m²» or «½» stay as written.
  const folded = text.normalize('NFKC');
  return mark.test(folded) ? folded.replace(mark, '‹$1$2›') : text;
}

/** A question as `ai_suggestion` keeps it. */
export interface StoredQuestion {
  id: string;
  aiRunId: string;
  status: SuggestionStatus;
  proposedAt: Date;
  proposal: Readonly<Record<string, unknown>>;
}

/** A question on screen. */
export interface QuestionView {
  id: string;
  text: string;
  section: string | null;
  fromMs: number;
  toMs: number;
  /** AS-122. Its line, read again from the transcript. */
  quote: string;
  demo: boolean;
}

/**
 * AS-122, AS-123. The questions on screen: those of the latest review
 * (`runId`, null when there is none), less the discarded, each with its line
 * read again — and not one whose line the purge already took.
 */
export function currentQuestions(
  runId: string | null,
  stored: readonly StoredQuestion[],
  transcript: readonly TranscriptLine[],
): QuestionView[] {
  if (runId === null) return [];
  return stored.flatMap((each) => {
    if (each.aiRunId !== runId || each.status === 'DISCARDED') return [];
    const { text, section, fromMs, toMs, demo } = each.proposal;
    if (typeof text !== 'string' || typeof fromMs !== 'number' || typeof toMs !== 'number') return []; // prettier-ignore
    const quote = spokenIn({ fromMs, toMs }, transcript);
    if (quote === '') return [];
    return [
      {
        id: each.id,
        text,
        section: typeof section === 'string' ? section : null,
        fromMs,
        toMs,
        quote,
        demo: demo === true,
      },
    ];
  });
}
