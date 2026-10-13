import type { TranscriptLine } from '../../src/modules/assistant/domain/note-draft.ts';
import {
  saidIn,
  type PreparationProposal,
} from '../../src/modules/assistant/domain/preparation-reading.ts';
import { foldText } from '../../src/modules/assistant/domain/problem-coding.ts';
import { quantile, wilson, type Interval } from '../stats.ts';

import type { PreparationCase } from './cases.ts';

export type ValueOutcome = 'correct' | 'wrong' | 'empty' | 'invented';
export type ComplaintOutcome = 'correct' | 'wrong' | 'missed' | 'invented' | 'none'; // prettier-ignore

/** One case, one arm, one voice: what reached the screen, against what was said. */
export interface ScoredCase {
  id: string;
  style: string;
  arm: 'escrito' | 'oido';
  voice: string;
  reader: 'assistant' | 'failed';
  latencyMs: number | null;
  values: { field: string; expected: number | string | null; got: number | string | null; outcome: ValueOutcome }[]; // prettier-ignore
  /** SC-099. Values whose number is not in their phrase, or whose phrase is not in its line. */
  notLiteral: number;
  complaint: ComplaintOutcome;
  speakers: { right: number; lines: number };
}

const POUND_KG = 0.45359237;
const near = (a: number, b: number) => Math.abs(a - b) < 0.051;

/**
 * SC-099, checked apart from the barrier: the phrase is inside its line,
 * compared folded, and one number it says is the value — as said, in metres
 * for a height, or in pounds for a weight.
 */
export function literal(
  field: string,
  value: number,
  quote: string | null,
  line: TranscriptLine | undefined,
): boolean {
  if (quote === null || line === undefined) return false;
  if (!foldText(line.text).includes(foldText(quote).replace(/[.,;:!?¿¡]+$/u, ''))) return false; // prettier-ignore
  return saidIn(quote).some(
    (said) =>
      near(said, value) ||
      (field === 'heightCm' && near(said * 100, value)) ||
      (field === 'weightKg' && near(Math.round(said * POUND_KG * 10) / 10, value)), // prettier-ignore
  );
}

/** Where the harness puts each line of a case: ten seconds apart (`main.ts`). */
export const LINE_STRIDE_MS = 10_000;
const caseLineOf = (startMs: number) => Math.floor(startMs / LINE_STRIDE_MS);

/**
 * SC-099 to SC-101 for one reading. `reading` null: the assistant did not
 * answer. `lines` are the sentences it read (AS-250): each knows the line of
 * the case it comes from by its start.
 */
export function scoreCase(input: {
  item: PreparationCase;
  arm: ScoredCase['arm'];
  voice: string;
  lines: readonly TranscriptLine[];
  reading: PreparationProposal | null;
  latencyMs: number | null;
}): ScoredCase {
  const { item, reading, lines } = input;
  const proposed = reading?.values ?? {};
  const fields = new Set([...Object.keys(item.expected), ...Object.keys(proposed)]); // prettier-ignore
  const values: ScoredCase['values'] = [...fields].map((field) => {
    const expected = (item.expected as Record<string, number>)[field] ?? null;
    const got = (proposed as Record<string, { value: number }>)[field]?.value ?? null; // prettier-ignore
    return { field, expected, got, outcome: outcomeOf(expected, got) };
  });
  const position = reading?.heightPosition?.value ?? null;
  if (item.heightPosition !== null || position !== null) {
    values.push({ field: 'heightPosition', expected: item.heightPosition, got: position, outcome: outcomeOf(item.heightPosition, position) }); // prettier-ignore
  }
  const notLiteral = Object.entries(proposed).filter(
    ([field, each]) =>
      !literal(field, each.value, each.quote, lines.find((line) => line.startMs === each.startMs)), // prettier-ignore
  ).length;

  const said = reading?.complaint ?? null;
  const at = said ? caseLineOf(said.startMs) : -1;
  const complaint: ComplaintOutcome =
    item.complaint === null
      ? said ? 'invented' : 'none'
      : !said ? 'missed' : item.complaint.includes(at) ? 'correct' : 'wrong'; // prettier-ignore

  const speakers = reading?.speakers ?? [];
  return {
    id: item.id,
    style: item.style,
    arm: input.arm,
    voice: input.voice,
    reader: reading ? 'assistant' : 'failed',
    latencyMs: input.latencyMs,
    values,
    notLiteral,
    complaint,
    speakers: {
      // A line of the case is right when every sentence read from it is.
      right: item.lines.filter((line, index) => {
        const read = lines.flatMap((sentence, at) => (caseLineOf(sentence.startMs) === index ? [speakers[at]] : [])); // prettier-ignore
        return read.length > 0 && read.every((speaker) => speaker === line.speaker); // prettier-ignore
      }).length,
      lines: item.lines.length,
    },
  };
}

function outcomeOf(
  expected: number | string | null,
  got: number | string | null,
): ValueOutcome {
  if (expected === null) return got === null ? 'empty' : 'invented';
  if (got === null) return 'empty';
  const same = typeof expected === 'number' && typeof got === 'number' ? near(expected, got) : expected === got; // prettier-ignore
  return same ? 'correct' : 'wrong';
}

export interface Summary {
  cases: number;
  answered: number;
  expected: number;
  correct: number;
  correctRate: Interval & { rate: number };
  wrong: number;
  invented: number;
  serious: number;
  notLiteral: number;
  complaintSaid: number;
  complaintRight: number;
  complaintRate: Interval & { rate: number };
  complaintInvented: number;
  lines: number;
  speakersRight: number;
  speakerRate: Interval & { rate: number };
  p50Ms: number | null;
  p90Ms: number | null;
}

const rateOf = (hits: number, n: number) => ({ ...wilson(hits, n), rate: n === 0 ? 0 : hits / n }); // prettier-ignore

/** SC-099 to SC-101 over a set of readings. */
export function summarise(scored: readonly ScoredCase[]): Summary {
  const answered = scored.filter((each) => each.reader === 'assistant');
  const all = answered.flatMap((each) => each.values);
  const expected = all.filter((each) => each.expected !== null).length;
  const correct = all.filter((each) => each.outcome === 'correct').length;
  const wrong = all.filter((each) => each.outcome === 'wrong').length;
  const invented = all.filter((each) => each.outcome === 'invented').length;
  const said = answered.filter((each) => each.complaint !== 'none' && each.complaint !== 'invented'); // prettier-ignore
  const right = said.filter((each) => each.complaint === 'correct').length;
  const lines = answered.reduce((total, each) => total + each.speakers.lines, 0); // prettier-ignore
  const speakersRight = answered.reduce((total, each) => total + each.speakers.right, 0); // prettier-ignore
  const latencies = answered.flatMap((each) => (each.latencyMs === null ? [] : [each.latencyMs])); // prettier-ignore
  return {
    cases: scored.length,
    answered: answered.length,
    expected,
    correct,
    correctRate: rateOf(correct, expected),
    wrong,
    invented,
    serious: wrong + invented,
    notLiteral: answered.reduce((total, each) => total + each.notLiteral, 0),
    complaintSaid: said.length,
    complaintRight: right,
    complaintRate: rateOf(right, said.length),
    complaintInvented: answered.filter((each) => each.complaint === 'invented').length, // prettier-ignore
    lines,
    speakersRight,
    speakerRate: rateOf(speakersRight, lines),
    p50Ms: latencies.length ? quantile(latencies, 0.5) : null,
    p90Ms: latencies.length ? quantile(latencies, 0.9) : null,
  };
}

/** SC-099 to SC-101: the verdict of one summary. */
export function verdict(summary: Summary) {
  return {
    sc099: summary.notLiteral === 0,
    sc100: summary.correctRate.rate >= 0.95 && summary.serious === 0 && (summary.p90Ms ?? Infinity) <= 5_000, // prettier-ignore
    sc101: (summary.complaintSaid === 0 || summary.complaintRate.rate >= 0.9) && summary.complaintInvented === 0 && summary.speakerRate.rate >= 0.9, // prettier-ignore
  };
}
