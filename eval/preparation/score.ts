import type { TranscriptLine } from '../../src/modules/assistant/domain/note-draft.ts';
import type { PreparationProposal } from '../../src/modules/assistant/domain/preparation-reading.ts';
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
  /** AS-284. The reason proposed reads as the nurse writes it; null: none proposed. */
  complaintWorded: boolean | null;
  speakers: { right: number; lines: number };
}

const POUND_KG = 0.45359237;
const near = (a: number, b: number) => Math.abs(a - b) < 0.051;

/**
 * SC-099, checked apart from the barrier — with nothing of its code: the
 * phrase is inside its line, compared folded, and it writes the value, in
 * figures or in words, as said (or in metres for a height, in pounds for a
 * weight).
 */
export function literal(
  field: string,
  value: number,
  quote: string | null,
  line: TranscriptLine | undefined,
): boolean {
  if (quote === null || line === undefined) return false;
  const phrase = fold(quote);
  if (!fold(line.text).includes(phrase)) return false;
  const said = [value];
  if (field === 'heightCm') said.push(value / 100);
  if (field === 'weightKg') {
    const pounds = value / POUND_KG;
    said.push(Math.round(pounds), Math.round(pounds * 2) / 2);
  }
  // A pressure written as one number: «120/80», and «130,80», how the
  // recogniser writes «130 con 80» (AS-181).
  const phrases = PRESSURE.has(field)
    ? [phrase, phrase.replace(/(\d{2,3})[,./](\d{2,3})/g, '$1 $2')]
    : [phrase];
  return said.some((number) =>
    spellings(number).some((written) =>
      phrases.some((each) => ` ${each} `.includes(` ${written} `)),
    ),
  );
}

const PRESSURE = new Set(['systolicBp', 'diastolicBp']);

/** Folded, with a point or a comma kept only between two figures. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/(\d)([.,])(\d)/g, '$1\u0000$2$3')
    .replace(/[.,](?!\d)|(?<!\u0000)[.,]/g, ' ')
    .replace(/\u0000/g, '')
    .replace(/[^a-z0-9.,/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']; // prettier-ignore
const TEENS = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve']; // prettier-ignore
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa']; // prettier-ignore
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos']; // prettier-ignore

/** A whole number from 0 to 499, in words. */
function words(n: number): string[] {
  if (n < 10) return n === 1 ? ['uno', 'un'] : [UNITS[n]!];
  if (n < 30) return [TEENS[n - 10]!];
  if (n < 100) {
    const unit = n % 10;
    return unit === 0 ? [TENS[Math.floor(n / 10)]!] : words(unit).map((u) => `${TENS[Math.floor(n / 10)]} y ${u}`); // prettier-ignore
  }
  if (n === 100) return ['cien'];
  const rest = n % 100;
  const head = HUNDREDS[Math.floor(n / 100)]!;
  return rest === 0 ? [head] : words(rest).map((r) => `${head} ${r}`);
}

/** Every way the harness accepts a number written: «36.5», «36,5», «treinta y seis y medio», «uno sesenta». */
function spellings(n: number): string[] {
  const out: string[] = [];
  const whole = Math.floor(n);
  const tenths = Math.round((n - whole) * 100);
  if (tenths === 0) {
    out.push(String(whole), ...words(whole));
    // AS-284. How whisper writes «ciento cincuenta y ocho»: «150 y 8».
    const unit = whole % 10;
    if (whole > 20 && unit > 0 && (whole - unit) % 100 !== 0) {
      out.push(...[String(unit), ...words(unit)].map((u) => `${whole - unit} y ${u}`)); // prettier-ignore
    }
    return out;
  }
  const two = String(tenths).padStart(2, '0');
  const decimals = two.endsWith('0') ? [two[0]!, two] : [two];
  for (const d of decimals) {
    out.push(`${whole}.${d}`, `${whole},${d}`, `${whole} punto ${d}`, `${whole} coma ${d}`); // prettier-ignore
  }
  if (tenths === 50) out.push(`${whole} y medio`, `${whole} kilos y medio`);
  for (const w of words(whole)) {
    for (const d of decimals) {
      const said = words(Number(d));
      for (const s of said) out.push(`${w} punto ${s}`, `${w} coma ${s}`, `${w} ${s}`); // prettier-ignore
    }
    if (tenths === 50) out.push(`${w} y medio`, `${w} kilos y medio`);
    if (whole <= 2) for (const s of words(tenths)) out.push(`${w} metro ${s}`, `${w} metros ${s}`); // prettier-ignore
  }
  return out;
}

/** AS-284. First person, fillers and whom the patient speaks to: what a worded reason has none of. */
const SPOKEN = /(^| )(me|mi|mis|yo|tengo|estoy|siento|ay|pues|bueno|mire|oiga|senorita|senora|doctora?|doctorita)( |$)/; // prettier-ignore

/** AS-284. Checked apart from the barrier: not the patient's phrase, and none of SPOKEN. */
export function worded(complaint: { text: string; quote: string }): boolean {
  const text = fold(complaint.text);
  return text !== fold(complaint.quote) && !SPOKEN.test(text);
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
    complaintWorded: said ? worded(said) : null,
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
  /** AS-284. Of the reasons proposed, how many read as the nurse writes them. */
  complaintProposed: number;
  complaintWorded: number;
  wordedRate: Interval & { rate: number };
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
  const proposed = answered.filter((each) => each.complaintWorded !== null);
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
    complaintProposed: proposed.length,
    complaintWorded: proposed.filter((each) => each.complaintWorded).length,
    wordedRate: rateOf(proposed.filter((each) => each.complaintWorded).length, proposed.length), // prettier-ignore
    lines,
    speakersRight,
    speakerRate: rateOf(speakersRight, lines),
    p50Ms: latencies.length ? quantile(latencies, 0.5) : null,
    p90Ms: latencies.length ? quantile(latencies, 0.9) : null,
  };
}

/** SC-099 to SC-101: the verdict of one summary. */
export function verdict(summary: Summary) {
  // Revisión I2: a reading that did not answer is not a reading that passed.
  if (summary.answered < summary.cases) {
    return { sc099: false, sc100: false, sc101: false };
  }
  return {
    sc099: summary.notLiteral === 0,
    sc100: summary.correctRate.rate >= 0.95 && summary.serious === 0 && (summary.p90Ms ?? Infinity) <= 5_000, // prettier-ignore
    sc101: (summary.complaintSaid === 0 || summary.complaintRate.rate >= 0.9) && summary.complaintInvented === 0 && summary.speakerRate.rate >= 0.9, // prettier-ignore
  };
}
