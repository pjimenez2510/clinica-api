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
 * AS-103 (clinical review of 12-10-2026, G1). What says the exam is NOT
 * asked for today, read over the WHOLE sentence and not only before the
 * phrase: the model may quote «biometría hemática» out of «Biometría
 * hemática previa normal». Folded.
 *
 * In the whole sentence: a condition, a later visit, or that it is not
 * needed — «Si no mejora en 48 horas, radiografía de tórax» asks for nothing
 * today, whatever comma splits it.
 */
const NOT_TODAY: readonly RegExp[] = [
  /\bsi (?:no |persiste|empeora|continua|hay |aparece)/,
  /\b(?:proximo|siguiente|otro) control\b/,
  /\b(?:proxima|proximo|siguiente) (?:consulta|cita|visita)\b/,
  /\bde ser necesario\b/,
  /\ben caso de\b/,
  /\bno (?:requiere|amerita|es necesari[oa]|hace falta|se (?:solicita|pide))\b/,
  /\bsin necesidad de\b/,
];

/**
 * In the clause of the phrase (between commas, colons or semicolons): a
 * result brought or reported, an exam done before, one the patient has.
 * Only the clause, so «Trae EMO normal, se solicita urocultivo» still asks
 * for the urocultivo — and «ya que tiene fiebre» is not «ya tiene» (code
 * review of 12-10-2026, 3).
 */
const NOT_ASKED: readonly RegExp[] = [
  /\b(?:trae|trajo|reporta|reportad[oa]s?|informa)\b/,
  /\bresultados? (?:de|del)\b/,
  /\bprevi[oa]s?\b/,
  /\banterior(?:es)?\b/,
  /\brealizad[oa]s?\b/,
  /\bya (?:tiene|trae|cuenta con|se (?:hizo|realizo|tomo))\b/,
];

/**
 * AS-103. Whether the sentence that holds the phrase says the exam is not
 * asked for today: anywhere in the sentence for a condition or a later
 * visit; in the phrase's own clause for a result or a past exam.
 */
export function deniedIn(sentence: string, quote: string): boolean {
  const folded = foldText(sentence);
  if (NOT_TODAY.some((pattern) => pattern.test(folded))) return true;
  const at = folded.indexOf(foldText(quote));
  const from = at < 0 ? 0 : at;
  const to = at < 0 ? folded.length : at + foldText(quote).length;
  const start = Math.max(...[',', ':', ';'].map((mark) => folded.lastIndexOf(mark, from - 1))) + 1; // prettier-ignore
  const ends = [',', ':', ';']
    .map((mark) => folded.indexOf(mark, to))
    .filter((index) => index >= 0);
  const clause = folded.slice(start, ends.length > 0 ? Math.min(...ends) : undefined); // prettier-ignore
  return NOT_ASKED.some((pattern) => pattern.test(clause));
}

/** The note's sentence, or the conversation's, that holds the phrase and asks. */
function locatedAsking(
  quote: string,
  sections: readonly { key: string; text: string }[],
): ReturnType<typeof locateQuote> {
  const located = locateQuote(quote, sections);
  return located && !deniedIn(located.sentence, quote) ? located : null;
}

/** Segments joined with spaces: a sentence said across two of them is one. */
function talkOf(transcript: readonly SpokenSegment[]) {
  const spoken = transcript.map((each) => each.text.trim()).join(' ');
  return spoken === '' ? [] : [{ key: 'transcript', text: spoken }];
}

/**
 * AS-103. Keeps the exams whose sentence is in the cleared text the model
 * read AND, with the placeholders put back, in the note or in the
 * conversation as whole words, not denied before it (AS-028) nor said in
 * its sentence to be a result, a past exam, a condition or for later
 * (`deniedIn`). The note is searched first. What is kept carries its own
 * sentence and where it is; the rest is dropped, and counted.
 */
export function backedExams(input: {
  read: readonly ReadExam[];
  cleared: string;
  sections: readonly { key: string; text: string }[];
  transcript: readonly SpokenSegment[];
  restore: (text: string) => string;
}): { kept: BackedExam[]; dropped: number } {
  const cleared = foldText(input.cleared);
  const talk = talkOf(input.transcript);
  const kept: BackedExam[] = [];

  for (const exam of input.read) {
    if (!cleared.includes(foldText(exam.quote))) continue;
    const quote = input.restore(exam.quote).trim();
    const inNote = locatedAsking(quote, input.sections);
    const located = inNote ?? locatedAsking(quote, talk);
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

/**
 * AS-107 (clinical review G2, AS-058). What an `order-item` proposal keeps.
 * A sentence of the NOTE is kept, as D1 and D2 keep theirs; one of the
 * CONVERSATION is not — no row outside `transcript_segment` holds its text,
 * which the purge deletes (AS-057) and this table never would. It is read
 * back from its stretch when shown (`spokenIn`). Nor is the exam as the
 * model named it: nobody sees it (AS-104, minimisation).
 */
export interface OrderProposal {
  /** The note's sentence; null when it was said in the conversation. */
  quote: string | null;
  origin: ExamOrigin;
  candidates: ExamCandidate[];
  /** The candidates' codes, in order: what AS-022's distance reads. */
  codes: string[];
  /**
   * AS-109 (review M2). The candidates already on a live order of the
   * attention when it was read: the physician ordered them, not the
   * proposal, so they never link to it.
   */
  orderedAtReading: string[];
  /** AS-029. Written by the fake of the demonstration mode, not by a model. */
  demo: boolean;
}

/**
 * AS-106. The text of the conversation in a stretch, as the transcript holds
 * it now: empty once the purge took it (AS-057).
 */
export function spokenIn(
  origin: { fromMs: number; toMs: number },
  transcript: readonly SpokenSegment[],
): string {
  return transcript
    .filter(
      (each) => each.startMs >= origin.fromMs && each.endMs <= origin.toMs,
    ) // prettier-ignore
    .map((each) => each.text.trim())
    .filter((text) => text !== '')
    .join(' ');
}

/**
 * AS-106. Whether a sentence of the note is still said, and still asks: the
 * rule of AS-103, at showing time.
 */
export function stillAsked(
  quote: string,
  sections: readonly { key: string; text: string }[],
): boolean {
  return locatedAsking(quote, sections) !== null;
}
