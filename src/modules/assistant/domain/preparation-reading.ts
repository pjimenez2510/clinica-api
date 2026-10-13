import type { DictatedVitalField } from './dictated-vitals';
import { readDictatedVitals } from './dictated-vitals';
import { lineOf, type TranscriptLine } from './note-draft';
import { foldText } from './problem-coding';
import { spokenNumbers, type HeightPosition } from './vitals-dictation';
import { PLAUSIBLE, type PlausibleRange } from './vitals-plausibility';

/**
 * B3 (AS-245 to AS-251). The preparation listened to, read into a proposal for
 * the taking's form: each value with the line it comes from and the phrase
 * that says it, who said each line, and the reason in the patient's words.
 *
 * The model only points: which field, which line, which phrase, which number
 * as it was said. Everything it points at is checked here against the
 * transcript as it was kept (P5): a number the phrase does not say, a phrase
 * the line does not hold, a reading no person could have — never proposed.
 */

/** AS-250. Who said a line, told by what it says, never by the voice. */
export type Speaker = 'nursing' | 'patient' | 'other';

export const SPEAKERS = ['nursing', 'patient', 'other'] as const;

/** AS-246. The readings of a taking the preparation can propose. */
export const PREPARATION_FIELDS = [
  'weightKg',
  'heightCm',
  'headCircumferenceCm',
  'abdominalCircumferenceCm',
  'systolicBp',
  'diastolicBp',
  'heartRate',
  'respiratoryRate',
  'temperatureC',
  'oxygenSaturation',
  'hemoglobinGDl',
  'hemoglobinCorrectedGDl',
] as const satisfies readonly DictatedVitalField[];

/** AS-247. The unit a number was said in; converting it is this code's job. */
export const SAID_UNITS = ['kg', 'lb', 'cm', 'm', 'none'] as const;
export type SaidUnit = (typeof SAID_UNITS)[number];

/** What the model answered, before anything of it is believed. */
export interface AnsweredPreparation {
  lines: readonly { line: string; speaker: Speaker }[];
  values: readonly {
    field: DictatedVitalField;
    line: string;
    quote: string;
    said: number;
    unit: SaidUnit;
  }[];
  heightPosition: {
    position: HeightPosition;
    line: string;
    quote: string;
  } | null;
  complaint: { line: string; quote: string } | null;
}

/** AS-246. One value proposed, with where it was said (null when no single line holds it). */
export interface Provenanced<Value> {
  value: Value;
  startMs: number | null;
  quote: string | null;
}

export interface PreparationProposal {
  values: Partial<Record<DictatedVitalField, Provenanced<number>>>;
  heightPosition: Provenanced<HeightPosition> | null;
  /** Named, but not proposed: typed by hand (AS-247, AS-248). */
  unclear: DictatedVitalField[];
  /** AS-249. The patient's own phrase. */
  complaint: { text: string; startMs: number } | null;
  /** AS-250. By line, in the order of the transcript; null when the rules read it. */
  speakers: (Speaker | null)[];
}

/** AS-249. What the taking keeps of the reason (`presenting_complaint`). */
export const LONGEST_COMPLAINT = 500;

const POUND_KG = 0.45359237;

/** AS-247. Readings that are whole numbers: a decimal said for them is not them. */
const WHOLE = new Set<DictatedVitalField>([
  'systolicBp',
  'diastolicBp',
  'heartRate',
  'respiratoryRate',
  'oxygenSaturation',
]);

/** AS-248. The limits of B2, by the name of the taking's field. */
const RANGE: Readonly<Record<DictatedVitalField, PlausibleRange>> = {
  weightKg: PLAUSIBLE.weightKg,
  heightCm: PLAUSIBLE.heightCm,
  headCircumferenceCm: PLAUSIBLE.headCircumferenceCm,
  abdominalCircumferenceCm: PLAUSIBLE.abdominalCircumferenceCm,
  systolicBp: PLAUSIBLE.systolic,
  diastolicBp: PLAUSIBLE.diastolic,
  heartRate: PLAUSIBLE.heartRate,
  respiratoryRate: PLAUSIBLE.respiratoryRate,
  temperatureC: PLAUSIBLE.temperatureC,
  oxygenSaturation: PLAUSIBLE.oxygenSaturation,
  hemoglobinGDl: PLAUSIBLE.hemoglobinGDl,
  hemoglobinCorrectedGDl: PLAUSIBLE.hemoglobinCorrectedGDl,
};

/** AS-248. The words that say how a height was taken. */
const POSITION_WORDS: Readonly<Record<HeightPosition, RegExp>> = {
  STANDING: /(^|[^\p{L}])(de pie|parad[oa])($|[^\p{L}])/u,
  LYING: /(^|[^\p{L}])(acostad[oa]|echad[oa]|decubito)($|[^\p{L}])/u,
};

/**
 * AS-247. The numbers a phrase says, and the readings two numbers said
 * together have: a height in metres («uno sesenta» is 1.60), a tenth after its
 * whole («treinta y seis ocho» is 36.8) and a pressure written as one number
 * («110,70»).
 */
export function saidIn(phrase: string): number[] {
  const numbers = spokenNumbers(phrase);
  const said = [...numbers];
  numbers.forEach((first, at) => {
    const second = numbers[at + 1];
    if (
      (first === 1 || first === 2) &&
      second !== undefined &&
      Number.isInteger(second) &&
      second < 100
    ) {
      said.push(first + second / 100);
    }
    // «treinta y seis ocho»: a tenth said after its whole.
    if (
      Number.isInteger(first) &&
      first >= 10 &&
      second !== undefined &&
      Number.isInteger(second) &&
      second <= 9
    ) {
      said.push(first + second / 10);
    }
  });
  for (const pair of phrase.matchAll(/\b(\d{2,3})[.,](\d{2,3})\b/g)) {
    said.push(Number(pair[1]), Number(pair[2]));
  }
  return said;
}

/**
 * AS-245 to AS-250. The model's answer, believed only where the transcript
 * backs it. `restore` puts back the names the pseudonymizer took out of the
 * phrases before they are compared with the transcript as kept.
 */
export function readPreparationAnswer(input: {
  answer: AnsweredPreparation;
  lines: readonly TranscriptLine[];
  markers: ReadonlyMap<string, TranscriptLine>;
  restore: (text: string) => string;
}): PreparationProposal {
  const { answer, markers, restore } = input;
  const unclear = new Set<DictatedVitalField>();
  const found = new Map<DictatedVitalField, Provenanced<number>[]>();

  for (const answered of answer.values) {
    const line = lineOf(answered.line, markers);
    const quote = restore(answered.quote).trim();
    const value =
      line !== null && holds(line.text, quote) && says(quote, answered.said)
        ? measured(answered.field, answered.said, answered.unit)
        : null;
    if (value === null) {
      unclear.add(answered.field);
      continue;
    }
    found.set(answered.field, [
      ...(found.get(answered.field) ?? []),
      { value, startMs: line!.startMs, quote },
    ]);
  }

  const values = settled(found, unclear);
  const heightPosition = positionOf(answer, values, markers, restore);
  const speakerOf = new Map(
    answer.lines.map((each) => [each.line.trim().replace(/^\[|\]$/g, '').toUpperCase(), each.speaker]), // prettier-ignore
  );
  const speakers = input.lines.map(
    (_, at) => speakerOf.get(`L${at + 1}`) ?? 'other',
  );

  return {
    values,
    heightPosition,
    unclear: [...unclear],
    complaint: complaintOf(answer, markers, speakers, input.lines, restore),
    speakers,
  };
}

/**
 * AS-251, AS-253. Without the assistant: the rules of «Dictar» over the whole
 * conversation, each value with the one line that says it, if only one does.
 * No speakers and no reason: the rules cannot tell who speaks.
 */
export function readPreparationByRules(
  lines: readonly TranscriptLine[],
): PreparationProposal {
  // Each sentence, so a value's phrase is the sentence that says it (AS-251).
  const read = readDictatedVitals(lines.map((line) => line.text).join(' '), {
    endAtUnknownWord: true,
  });
  const values: PreparationProposal['values'] = {};
  for (const [field, value] of Object.entries(read.signs) as [
    DictatedVitalField,
    number,
  ][]) {
    const saying = lines.filter((line) =>
      saidIn(line.text).some((said) => sameAsSaid(field, value, said)),
    );
    const only = saying.length === 1 ? saying[0]! : null;
    values[field] = {
      value,
      startMs: only?.startMs ?? null,
      quote: only?.text ?? null,
    };
  }
  return {
    values,
    heightPosition: read.heightPosition
      ? { value: read.heightPosition, startMs: null, quote: null }
      : null,
    unclear: read.unclear,
    complaint: null,
    speakers: lines.map(() => null),
  };
}

/** AS-247. The phrase is in its line, as whole words, compared folded. */
function holds(line: string, quote: string): boolean {
  const phrase = plain(quote);
  return phrase !== '' && ` ${plain(line)} `.includes(` ${phrase} `);
}

/** Folded, and without the punctuation a model may drop or add. */
function plain(text: string): string {
  return foldText(text)
    .replace(/(\d)[.,](\d)/g, '$1‧$2')
    .replace(/[^\p{L}\p{N}‧/]+/gu, ' ')
    .trim();
}

/** AS-247. The number the model says was said is one the phrase says. */
function says(quote: string, said: number): boolean {
  return (
    Number.isFinite(said) &&
    saidIn(quote).some((number) => Math.abs(number - said) < 1e-9)
  );
}

/** AS-251. A value read by the rules, against a number a line says. */
function sameAsSaid(field: DictatedVitalField, value: number, said: number) {
  if (Math.abs(said - value) < 1e-9) return true;
  return field === 'heightCm' && Math.abs(said * 100 - value) < 1e-6;
}

/**
 * AS-247, AS-248. The number as the taking keeps it, converted here and never
 * by the model; null when it is not a reading of that field a person could have.
 */
function measured(
  field: DictatedVitalField,
  said: number,
  unit: SaidUnit,
): number | null {
  let value: number | null = said;
  if (field === 'weightKg') {
    value = unit === 'lb' ? said * POUND_KG : unit === 'kg' || unit === 'none' ? said : null; // prettier-ignore
  } else if (
    field === 'heightCm' ||
    field === 'headCircumferenceCm' ||
    field === 'abdominalCircumferenceCm'
  ) {
    // prettier-ignore
    const metres = unit === 'm' || (unit === 'none' && field === 'heightCm' && said < 3); // prettier-ignore
    value = unit === 'kg' || unit === 'lb' ? null : metres ? said * 100 : said;
  } else if (WHOLE.has(field) && !Number.isInteger(said)) {
    value = null;
  }
  if (value === null) return null;
  const rounded = WHOLE.has(field) ? value : Math.round(value * 10) / 10;
  const range = RANGE[field];
  return rounded >= range.min && rounded <= range.max ? rounded : null;
}

/** AS-248. One value per field, and the pairs that must agree. */
function settled(
  found: ReadonlyMap<DictatedVitalField, Provenanced<number>[]>,
  unclear: Set<DictatedVitalField>,
): PreparationProposal['values'] {
  const values: PreparationProposal['values'] = {};
  for (const [field, proposed] of found) {
    const differ = proposed.some((each) => each.value !== proposed[0]!.value);
    if (differ || unclear.has(field)) unclear.add(field);
    else values[field] = proposed[0]!;
  }
  const { systolicBp, diastolicBp, hemoglobinGDl, hemoglobinCorrectedGDl } = values; // prettier-ignore
  if (systolicBp && diastolicBp && diastolicBp.value >= systolicBp.value) {
    delete values.systolicBp;
    delete values.diastolicBp;
    unclear.add('systolicBp').add('diastolicBp');
  }
  if (
    hemoglobinGDl &&
    hemoglobinCorrectedGDl &&
    hemoglobinCorrectedGDl.value > hemoglobinGDl.value
  ) {
    delete values.hemoglobinCorrectedGDl;
    unclear.add('hemoglobinCorrectedGDl');
  }
  return values;
}

/** AS-248. How the height was taken: its words in its phrase, and a height beside it. */
function positionOf(
  answer: AnsweredPreparation,
  values: PreparationProposal['values'],
  markers: ReadonlyMap<string, TranscriptLine>,
  restore: (text: string) => string,
): Provenanced<HeightPosition> | null {
  const said = answer.heightPosition;
  if (!said || !values.heightCm) return null;
  const line = lineOf(said.line, markers);
  const quote = restore(said.quote).trim();
  if (line === null || !holds(line.text, quote)) return null;
  if (!POSITION_WORDS[said.position].test(plain(quote))) return null;
  return { value: said.position, startMs: line.startMs, quote };
}

/** AS-249. The patient's own phrase, as it is in a line the patient said. */
function complaintOf(
  answer: AnsweredPreparation,
  markers: ReadonlyMap<string, TranscriptLine>,
  speakers: readonly (Speaker | null)[],
  lines: readonly TranscriptLine[],
  restore: (text: string) => string,
): PreparationProposal['complaint'] {
  const said = answer.complaint;
  if (!said) return null;
  const line = lineOf(said.line, markers);
  if (line === null || speakers[lines.indexOf(line)] !== 'patient') return null;
  const text = restore(said.quote).trim();
  if (text.length > LONGEST_COMPLAINT || !holds(line.text, text)) return null;
  return { text, startMs: line.startMs };
}

/**
 * AS-250. The recogniser cuts by silences, not by turns: one line of the
 * listening can hold the nurse's question and the patient's answer. What is
 * read is each sentence — after a full stop, a question or an exclamation,
 * and before an opening «¿» or «¡» — with a start estimated by where it falls
 * in its line, so every sentence has its own minute and its own speaker. A
 * point between figures («22.5») is not the end of a sentence.
 */
export function sentencesOf(
  lines: readonly TranscriptLine[],
): TranscriptLine[] {
  return lines.flatMap((line) => {
    const pieces = line.text
      .split(/(?<=[.?!…])\s+|\s+(?=[¿¡])/u)
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '');
    if (pieces.length <= 1) return [line];
    const span = line.endMs - line.startMs;
    let from = 0;
    const starts = pieces.map((piece) => {
      const at = line.text.indexOf(piece, from);
      from = at + piece.length;
      return line.startMs + Math.floor((span * at) / line.text.length);
    });
    // Strictly increasing, and inside the line, however the letters fall.
    for (let at = 1; at < starts.length; at++) {
      starts[at] = Math.min(Math.max(starts[at]!, starts[at - 1]! + 1), line.endMs - (starts.length - at)); // prettier-ignore
    }
    return pieces.map((text, at) => ({
      startMs: starts[at]!,
      endMs: starts[at + 1] ?? line.endMs,
      text,
    }));
  });
}
