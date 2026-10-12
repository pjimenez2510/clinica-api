import { foldText, locateQuote } from './problem-coding';

/**
 * AS-103 to AS-107, AS-109. The rules of «Proponer exámenes» that need no
 * model, no database and no clock: whether an exam's sentence is in the note
 * or in the conversation —and where—, which candidates were offered, and why
 * one cannot be accepted now.
 *
 * Adapted from D1 and D2 (`problem-coding.ts`, `prescription-reading.ts`):
 * the same sentence rule, with the order's own denials, and a catalogue that
 * is the clinic's (ADR-013) instead of the WHO's or the CNMB.
 */

/** AS-104. The physician chooses among five at most (RF-F01 of SigmAI). */
export const MOST_CANDIDATES = 5;

/** ORD-097. The order an exam goes on. */
export type ExamCategory = 'LABORATORY' | 'IMAGING';

/** AS-104. An exam of the clinic's catalogue, as the screen offers it. */
export interface ExamCandidate {
  serviceId: string;
  code: string;
  name: string;
  category: ExamCategory;
}

/** What the model answered for one exam, before anything is checked. */
export interface ReadExam {
  /** The exam as the model names it: kept, never shown (AS-104). */
  requested: string;
  quote: string;
  /** Numbers of the catalogue offered, 1-based. */
  candidates: readonly number[];
}

/** P2. Where the sentence is: a section of the note, or a stretch of talk. */
export type ExamOrigin =
  | { kind: 'note'; section: string }
  | { kind: 'transcript'; fromMs: number; toMs: number };

export interface BackedExam extends ReadExam {
  /** The note's or the conversation's own sentence (P2). */
  quote: string;
  origin: ExamOrigin;
}

/** One segment of the transcript (AS-056), in order of start. */
export interface SpokenSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * AS-103. Words that say the exam is NOT asked for today: a result brought
 * or reported, one done before, one the patient already has. Before the
 * sentence (with the general negations of AS-028) or inside it. Folded.
 */
const NOT_ASKED = new Set([
  'resultado',
  'resultados',
  'reporta',
  'reporte',
  'trae',
  'trajo',
  'previo',
  'previa',
  'previos',
  'previas',
  'realizado',
  'realizada',
  'realizo',
  'ya',
  'tiene',
]);

const words = (text: string) =>
  foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * AS-103. Keeps the exams whose sentence is in the cleared text the model
 * read AND, with the placeholders put back, in the note or in the
 * conversation as whole words, neither denied before it nor said to be a
 * result, a past exam or one the patient has. The note is searched first.
 * What is kept carries its own sentence and where it is; the rest is
 * dropped, and counted.
 */
export function backedExams(input: {
  read: readonly ReadExam[];
  cleared: string;
  sections: readonly { key: string; text: string }[];
  transcript: readonly SpokenSegment[];
  restore: (text: string) => string;
}): { kept: BackedExam[]; dropped: number } {
  const cleared = foldText(input.cleared);
  // Segments joined with spaces: a sentence said across two of them is one.
  const spoken = input.transcript.map((each) => each.text.trim()).join(' ');
  const talk = spoken === '' ? [] : [{ key: 'transcript', text: spoken }];
  const kept: BackedExam[] = [];

  for (const exam of input.read) {
    if (!cleared.includes(foldText(exam.quote))) continue;
    const quote = input.restore(exam.quote).trim();
    if (words(quote).some((word) => NOT_ASKED.has(word))) continue;
    const inNote = locateQuote(quote, input.sections, NOT_ASKED);
    const located = inNote ?? locateQuote(quote, talk, NOT_ASKED);
    if (!located) continue;
    const origin: ExamOrigin | null = inNote
      ? { kind: 'note', section: inNote.section }
      : stretchOf(quote, input.transcript);
    if (!origin) continue;
    kept.push({
      requested: input.restore(exam.requested).trim(),
      quote: located.sentence,
      candidates: exam.candidates,
      origin,
    });
  }

  return { kept, dropped: input.read.length - kept.length };
}

/**
 * AS-103 (AS-020). The stretch of the conversation a phrase was said in:
 * from the start of its first segment to the end of its last.
 */
export function stretchOf(
  quote: string,
  transcript: readonly SpokenSegment[],
): ExamOrigin | null {
  const folded = foldText(quote);
  let text = '';
  const bounds: { from: number; to: number; segment: SpokenSegment }[] = [];
  for (const segment of transcript) {
    const plain = foldText(segment.text);
    if (plain === '') continue;
    if (text !== '') text += ' ';
    bounds.push({ from: text.length, to: text.length + plain.length, segment });
    text += plain;
  }
  const at = text.indexOf(folded);
  if (folded === '' || at < 0) return null;
  const end = at + folded.length;
  const touched = bounds.filter((each) => each.from < end && each.to > at);
  if (touched.length === 0) return null;
  return {
    kind: 'transcript',
    fromMs: touched[0]!.segment.startMs,
    toMs: touched[touched.length - 1]!.segment.endMs,
  };
}

/**
 * AS-104. The candidates the model chose by number: only numbers it was
 * offered, each once, at most five, in its order. A number outside the list
 * is an invention and is dropped.
 */
export function offeredCandidates<T>(
  numbers: readonly number[],
  catalogue: readonly T[],
): T[] {
  const seen = new Set<number>();
  const chosen: T[] = [];
  for (const number of numbers) {
    if (!Number.isInteger(number) || seen.has(number)) continue;
    const exam = catalogue[number - 1];
    if (number < 1 || !exam) continue;
    seen.add(number);
    chosen.push(exam);
    if (chosen.length === MOST_CANDIDATES) break;
  }
  return chosen;
}

/** AS-106. Why a candidate cannot go to an order now. */
export type CandidateBlock = 'in-order';

export function blockOf(
  candidate: { code: string },
  ordered: ReadonlySet<string>,
): CandidateBlock | null {
  return ordered.has(candidate.code) ? 'in-order' : null;
}

/** AS-107. What an `order-item` proposal keeps. */
export interface OrderProposal {
  requested: string;
  quote: string;
  origin: ExamOrigin;
  candidates: ExamCandidate[];
  /** The candidates' codes, in order: what AS-022's distance reads. */
  codes: string[];
  /** AS-029. Written by the fake of the demonstration mode, not by a model. */
  demo: boolean;
}

/**
 * AS-106. Whether the sentence of a proposal is still said: in the note as
 * it is now, or in the conversation. The rule of AS-103, at showing time.
 */
export function stillSaid(
  quote: string,
  sections: readonly { key: string; text: string }[],
  transcript: readonly SpokenSegment[],
): boolean {
  const spoken = transcript.map((each) => each.text.trim()).join(' ');
  const talk = spoken === '' ? [] : [{ key: 'transcript', text: spoken }];
  return (
    locateQuote(quote, sections, NOT_ASKED) !== null ||
    locateQuote(quote, talk, NOT_ASKED) !== null
  );
}
