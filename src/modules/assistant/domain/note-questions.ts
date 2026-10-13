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
 * AS-276. Words that say nothing of WHAT is asked: articles, prepositions,
 * pronouns and the verbs a question is asked with («presenta», «tiene», «ha
 * tenido»). Folded.
 */
const EMPTY_WORDS = new Set(
  (
    'a al algo alguien algun alguna alguno algunas algunos con de del desde el ella en es esta este esto ' +
    'e ha han hay he la las le les lo los me mi mis o otra otro otras otros para por que se si su sus ' +
    'te tu u un una unas uno unos usted y ya ' +
    'presenta presentado presentas tiene tienes tenido tenia tuvo siente sentido sintio nota notado ' +
    'noto sufre sufrido padece padecido refiere'
  ).split(' '),
);

/** AS-276. What a question asks about: its content words, folded, without a plural «s». */
export function questionWords(text: string): Set<string> {
  return new Set(
    questionKey(text)
      .split(' ')
      .filter((word) => word.length > 1 && !EMPTY_WORDS.has(word))
      .map((word) => (word.length > 4 ? word.replace(/(?<=[aeiou])s$/, '') : word)), // prettier-ignore
  );
}

/** AS-276. How much of the content two questions share for them to be one. */
export const SAME_QUESTION = 0.75;

/**
 * AS-276. Two questions are one when they ask about the same: the same
 * content words in any order («tos, congestión nasal o mocos» and «tos, mocos
 * o congestión nasal»), or nearly all of them.
 */
export function sameQuestion(left: string, right: string): boolean {
  const a = questionWords(left);
  const b = questionWords(right);
  if (a.size === 0 || b.size === 0) return questionKey(left) === questionKey(right); // prettier-ignore
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared) >= SAME_QUESTION;
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
  /** AS-276. The questions proposed earlier in this attention, oldest first. */
  earlier?: readonly string[];
  restore: (text: string) => string;
}): { kept: BackedQuestion[]; dropped: number } {
  const sections = new Set(input.textSections);
  const kept: BackedQuestion[] = [];
  let dropped = 0;

  for (const answered of input.answered) {
    // Security review: a bidi or zero-width character shows one question and says another.
    const text = input.restore(answered.text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim(); // prettier-ignore
    const line = lineOf(answered.source, input.markers);
    if (text === '' || !line) {
      dropped += 1;
      continue;
    }
    if (questionKey(text) === '') continue;
    // AS-276. Put away in any wording, put away; asked before, asked as before.
    if (input.discarded.some((each) => sameQuestion(each, text))) continue;
    const worded = input.earlier?.find((each) => sameQuestion(each, text)) ?? text; // prettier-ignore
    if (kept.some((each) => sameQuestion(each.text, worded))) continue;
    kept.push({
      text: worded,
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
 * trimmed, in the template's order, and the prompt that reads it. The same
 * writing gives the same digest; a new word, another.
 */
export function noteDigestInput(
  sections: readonly { key: string; text: string }[],
  /** A new prompt reads the same note again (code review, nit 14). */
  promptVersion: string,
): string {
  return [
    promptVersion,
    ...sections.map((section) => `${section.key}\u0000${section.text.trim()}`),
  ].join('\u0001');
}

/**
 * AS-124. The marks of the data broken where the text says them, also with an
 * accent or in full width: the data cannot close its own block (AS-095).
 */
function withoutMarks(text: string): string {
  const mark = /<\s*(\/?)\s*(nota|conversaci[oó]n)\s*>/giu;
  // Invisible format characters first: «</no\u200Bta>» is a mark too
  // (security review of 12-10-2026).
  const visible = text.replace(/\p{Cf}/gu, '');
  // Only a text that says a mark is folded: «m²» or «½» stay as written.
  const folded = visible.normalize('NFKC');
  const unmarked = mark.test(folded) ? folded.replace(mark, '‹$1$2›') : visible;
  // The heading of the template that follows the data (AS-095, C2's rule).
  return unmarked.replace(/secciones de la nota/giu, 'secciones');
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
 * AS-122, AS-123, AS-125. The questions on screen: those of the latest
 * review (`runId`, null when there is none), less any the professional put
 * away in this attention, each with its line
 * read again — and not one whose line the purge already took.
 */
export function currentQuestions(
  runId: string | null,
  stored: readonly StoredQuestion[],
  transcript: readonly TranscriptLine[],
): QuestionView[] {
  if (runId === null) return [];
  // AS-125. Put away once, put away in this attention: also when the review
  // that brings it again was already on its way when it was discarded.
  const discarded = stored.flatMap((each) =>
    each.status === 'DISCARDED' && typeof each.proposal.text === 'string'
      ? [each.proposal.text]
      : [],
  );
  return stored.flatMap((each) => {
    if (each.aiRunId !== runId || each.status === 'DISCARDED') return [];
    const { text, section, fromMs, toMs, demo } = each.proposal;
    if (typeof text === 'string' && discarded.some((each) => sameQuestion(each, text))) return []; // prettier-ignore
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
