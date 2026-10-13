import {
  FIELD_OF,
  readDictatedVitals,
  type DictatedVitalField,
} from './dictated-vitals';
import { lineOf, type TranscriptLine } from './note-draft';
import { foldText } from './problem-coding';
import {
  joinedNumbers,
  ownersOf,
  spokenNumberRuns,
  type HeightPosition,
} from './vitals-dictation';
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
 * AS-247. The numbers a phrase says, and, for the field they are read for,
 * the readings two numbers said ONE RIGHT AFTER THE OTHER have: a height in
 * metres («uno sesenta» is 1.60), a tenth after its whole for a temperature
 * or a haemoglobin («treinta y seis ocho» is 36.8), and a pressure written as
 * one number («110,70»). Numbers with words between them never join: «desde
 * hace 2 días con fiebre de 38» says 2 and 38, never 2.38 (revisión).
 */
export function saidIn(phrase: string, field?: DictatedVitalField): number[] {
  const said: number[] = [];
  for (const run of spokenNumberRuns(phrase)) {
    run.forEach((number, at) => {
      said.push(number.value);
      const pair = /^(\d{2,3})[.,](\d{2,3})$/.exec(number.raw);
      if (pair && (field === 'systolicBp' || field === 'diastolicBp')) {
        said.push(Number(pair[1]), Number(pair[2]));
      }
      const next = run[at + 1];
      if (!next) return;
      for (const joined of joinedNumbers(number.value, next.value)) {
        const metres = joined < 3;
        if (metres ? field === 'heightCm' : TENTHS.has(field))
          said.push(joined);
      }
    });
  }
  return said;
}

/** AS-247. The readings a tenth said after its whole belongs to. */
const TENTHS = new Set<DictatedVitalField | undefined>([
  'temperatureC',
  'hemoglobinGDl',
  'hemoglobinCorrectedGDl',
]);

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
  const { answer, markers, restore, lines } = input;
  const unclear = new Set<DictatedVitalField>();
  const found = new Map<DictatedVitalField, Provenanced<number>[]>();
  const speakerOf = new Map(
    answer.lines.map((each) => [each.line.trim().replace(/^\[|\]$/g, '').toUpperCase(), each.speaker]), // prettier-ignore
  );
  const speakers = lines.map((_, at) => speakerOf.get(`L${at + 1}`) ?? 'other');

  for (const answered of answer.values) {
    const line = lineOf(answered.line, markers);
    const at = line ? lines.indexOf(line) : -1;
    const quote = restore(answered.quote).trim();
    // AS-247 (revisión M3). What the patient says («en la casa me tomé…»,
    // «peso como setenta») is not the taking: left out, so it neither fills a
    // box nor casts doubt on what whoever prepares measured and said.
    if (line !== null && speakers[at] === 'patient') continue;
    const value =
      line !== null &&
      holds(line.text, quote) &&
      says(quote, answered.said, answered.field) &&
      ownedBy(answered.field, answered.said, quote, line, lines[at - 1]) &&
      unitSaid(answered.field, answered.said, answered.unit, line.text)
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

  return {
    values,
    heightPosition,
    unclear: [...unclear],
    complaint: complaintOf(answer, markers, speakers, lines, restore),
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
  const unclear = new Set(read.unclear);
  for (const [field, value] of Object.entries(read.signs) as [
    DictatedVitalField,
    number,
  ][]) {
    const saying = lines.filter((line) =>
      saidIn(line.text, field).some((said) => sameAsSaid(field, value, said)),
    );
    // REQ-187 (revisión M3): every value cites its phrase; one no single
    // sentence holds is typed by hand.
    if (saying.length !== 1) {
      unclear.add(field);
      continue;
    }
    values[field] = { value, startMs: saying[0]!.startMs, quote: saying[0]!.text }; // prettier-ignore
  }
  return {
    values,
    heightPosition: read.heightPosition
      ? { value: read.heightPosition, startMs: null, quote: null }
      : null,
    unclear: [...unclear],
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
function says(quote: string, said: number, field: DictatedVitalField): boolean {
  return (
    Number.isFinite(said) &&
    saidIn(quote, field).some((number) => Math.abs(number - said) < 1e-9)
  );
}

/**
 * AS-247 (revisión G1). The number belongs to the field: in the sentence, up
 * to the end of the phrase —and the sentence before, the question it may
 * answer («¿Cuánto pesa?» «Setenta kilos»)— the field named last before the
 * number is this one, and nothing corrected it after.
 */
function ownedBy(
  field: DictatedVitalField,
  said: number,
  quote: string,
  line: TranscriptLine,
  before: TranscriptLine | undefined,
): boolean {
  const at = line.text.toLowerCase().indexOf(quote.toLowerCase());
  const upTo = at < 0 ? line.text : line.text.slice(0, at + quote.length);
  const owners = ownersOf(`${before?.text ?? ''} ${upTo}`, said);
  const owner = owners.at(-1);
  if (!owner || !owner.fields.some((each) => FIELD_OF[each] === field)) {
    return false;
  }
  // A correction said after it, anywhere in the sentence, takes it back.
  const whole = ownersOf(`${before?.text ?? ''} ${line.text}`, said).at(-1);
  return !owner.superseded && !whole?.superseded;
}

/**
 * AS-247 (revisión G2). The unit is the one said: pounds only where the
 * sentence says pounds, kilos never where it says pounds, metres only for a
 * number below three, and no unit at all for what has none.
 */
function unitSaid(
  field: DictatedVitalField,
  said: number,
  unit: SaidUnit,
  sentence: string,
): boolean {
  const words = plain(sentence);
  const pounds = /(^| )(libras?|lbs?)( |$)/.test(words);
  const kilos = /(^| )(kilos?|kilogramos?|kg)( |$)/.test(words);
  if (field === 'weightKg') {
    if (unit === 'lb') return pounds && !kilos;
    return (unit === 'kg' || unit === 'none') && !pounds;
  }
  if (LENGTHS.has(field)) {
    if (unit === 'm') return said < 3;
    return (unit === 'cm' || unit === 'none') && (said >= 3 || field === 'heightCm'); // prettier-ignore
  }
  return unit === 'none';
}

const LENGTHS = new Set<DictatedVitalField>([
  'heightCm',
  'headCircumferenceCm',
  'abdominalCircumferenceCm',
]);

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
  const quote = restore(said.quote).trim();
  // Revisión G3: the whole sentence, so a «no» before the phrase is never cut off.
  const text = line.text.trim();
  if (text.length > LONGEST_COMPLAINT || !holds(text, quote)) return null;
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
    // Strictly increasing, however the letters fall (revisión M3): a line too
    // short for its sentences spills past its end rather than repeat a start.
    for (let at = 1; at < starts.length; at++) {
      starts[at] = Math.max(starts[at]!, starts[at - 1]! + 1);
    }
    return pieces.map((text, at) => ({
      startMs: starts[at]!,
      endMs: starts[at + 1] ?? Math.max(line.endMs, starts[at]! + 1),
      text,
    }));
  });
}
