/**
 * B2 (AS-181, AS-182). Copied as is from SigmAI (`sigmai-api` `modules/vitals/dictation.ts`,
 * E-055: 93,9 % of the values without noise, 0 serious errors, no model).
 *
 * B3 (AS-253) widens it with what failed when the author dictated his own way (13-10-2026): the
 * systolic and the diastolic said apart, the circumferences, the haemoglobin, how the height was
 * taken, and an unknown word after a number ending that reading instead of gluing the next numbers
 * to it. SigmAI's own tests still pass untouched.
 */

import { PLAUSIBLE, type VitalSigns } from './vitals-plausibility';

export type VitalField = keyof VitalSigns;

/** What admission said aloud, read into fields. Nothing here is recorded until a person saves. */
export interface DictatedSigns {
  signs: Partial<Record<VitalField, number>>;
  /** Named aloud but not understood well enough to fill: the screen asks for them by hand. */
  unclear: VitalField[];
  /** AS-253. How the height was measured, only when a height was named and one way was said. */
  heightPosition?: HeightPosition;
}

export type HeightPosition = 'STANDING' | 'LYING';

export interface DictationOptions {
  /**
   * AS-253. A conversation, not a dictation: an unknown word after a number ends that reading, so
   * «pesa 70 kilos… desde hace 3 días» does not glue the 3 to the weight. Off for «Dictar»: there it
   * turned a misheard field name into a wrong value (D-260 §8).
   */
  endAtUnknownWord?: boolean;
}

type Topic =
  | 'pressure'
  | 'systolic'
  | 'diastolic'
  | 'headCircumferenceCm'
  | 'abdominalCircumferenceCm'
  | 'hemoglobinGDl'
  | 'hemoglobinCorrectedGDl'
  | 'heartRate'
  | 'respiratoryRate'
  | 'oxygenSaturation'
  | 'temperatureC'
  | 'temperatureAxillaryC'
  | 'weightKg'
  | 'heightCm';

interface NumberToken {
  kind: 'number';
  value: number;
  /** As written by the recogniser, so «110,70» can still be told from 110.7 under a pressure. */
  raw: string;
}

type Token = NumberToken | { kind: 'word'; text: string } | { kind: 'pause' };

const POUND_KG = 0.45359237;

const UNITS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
};

const TEENS: Record<string, number> = {
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};

const TENS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};

const HUNDREDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
};

const CORRECTIONS = new Set(['perdon', 'perdone', 'no', 'digo', 'corrijo']);

/**
 * AS-253. What may follow a number inside its reading: units, links, corrections and doubts. Any
 * other word after the number ends the reading («hemoglobina 22.5, se lo midió de pie…»).
 */
const STAYS_IN_READING = new Set([
  ...CORRECTIONS,
  'mejor',
  'dicho',
  'nose',
  'espera',
  'recuerdo',
  'creo',
  'y',
  'con',
  'sobre',
  '/',
  'de',
  'en',
  'a',
  'el',
  'la',
  'es',
  'esta',
  'son',
  'medio',
  'punto',
  'coma',
  'arterial',
  'cardiaca',
  'cardiaco',
  'respiratoria',
  'oxigeno',
  'axilar',
  'bucal',
  'oral',
  'kilos',
  'kilo',
  'kg',
  'kilogramos',
  'libras',
  'libra',
  'lb',
  'lbs',
  'metros',
  'metro',
  'm',
  'cm',
  'centimetros',
  'grados',
  'centigrados',
  'celsius',
  'por',
  'minuto',
  'latidos',
  'lpm',
  'rpm',
  'respiraciones',
  'mmhg',
  'milimetros',
  'mercurio',
  'gramos',
  'decilitro',
  'g',
  'dl',
  'gdl',
]);

/** AS-253. How the height was taken: «de pie», «parado», «acostado». */
const STANDING = new Set(['parado', 'parada']);
const LYING = new Set(['acostado', 'acostada', 'echado', 'echada', 'decubito']);
const HESITATIONS = [['nose'], ['espera'], ['no', 'recuerdo'], ['creo']];

/**
 * Reads what admission dictates: «presión 120 con 80, frecuencia 72, saturación 98, temperatura
 * 36 y medio, peso 72, talla 1,70». Deterministic and local, because the vocabulary is closed:
 * no cloud, no pseudonymization, no wait (D-065).
 *
 * A field it is not sure about stays empty and is named in `unclear`; it never guesses. A value
 * outside what a person can physically measure is not sure.
 */
export function interpretDictation(
  text: string,
  options: DictationOptions = {},
): DictatedSigns {
  const tokens = tokenize(text);
  const spans = topicsIn(tokens, options.endAtUnknownWord ?? false);
  const found = new Map<VitalField, number[]>();
  const unclear = new Set<VitalField>();

  for (const { topic, body, doubt } of spans) {
    const read = doubt ? null : readTopic(topic, body);
    const fields = fieldsOf(topic);

    if (read === null) {
      fields.forEach((field) => unclear.add(field));
      continue;
    }

    fields.forEach((field, at) =>
      found.set(field, [...(found.get(field) ?? []), read[at]!]),
    );
  }

  const signs: Partial<Record<VitalField, number>> = {};

  for (const [field, values] of found) {
    if (unclear.has(field) || values.some((value) => value !== values[0])) {
      unclear.add(field);
    } else {
      signs[field] = values[0]!;
    }
  }

  // AS-253. Said apart, the pair still obeys the rule a pressure said at once does.
  if (
    signs.systolic !== undefined &&
    signs.diastolic !== undefined &&
    signs.diastolic >= signs.systolic
  ) {
    delete signs.systolic;
    delete signs.diastolic;
    unclear.add('systolic');
    unclear.add('diastolic');
  }
  // AS-248. A correction for altitude lowers the haemoglobin, never raises it.
  if (
    signs.hemoglobinGDl !== undefined &&
    signs.hemoglobinCorrectedGDl !== undefined &&
    signs.hemoglobinCorrectedGDl > signs.hemoglobinGDl
  ) {
    delete signs.hemoglobinCorrectedGDl;
    unclear.add('hemoglobinCorrectedGDl');
  }

  const read: DictatedSigns = { signs, unclear: [...unclear] };
  const position = spans.some((span) => span.topic === 'heightCm')
    ? positionIn(tokens)
    : null;
  if (position) read.heightPosition = position;
  return read;
}

/** AS-253. One way of measuring the height said, or none: both said is no answer. */
function positionIn(tokens: Token[]): HeightPosition | null {
  const said = new Set<HeightPosition>();
  tokens.forEach((_, at) => {
    const word = wordAt(tokens, at);
    if (word === null) return;
    if (STANDING.has(word)) said.add('STANDING');
    if (word === 'pie' && wordAt(tokens, at - 1) === 'de') said.add('STANDING');
    if (LYING.has(word)) said.add('LYING');
  });
  return said.size === 1 ? [...said][0]! : null;
}

/**
 * AS-247 (B3). The numbers a phrase says, as this reader understands them —in figures, in words
 * («ciento veinte»), with «y medio», «punto» or «coma»— in runs of numbers said one right after the
 * other, with nothing between them. Two numbers are only ever read as one when they are in a run.
 */
export function spokenNumberRuns(
  text: string,
): { value: number; raw: string }[][] {
  const runs: { value: number; raw: string }[][] = [];
  let run: { value: number; raw: string }[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === 'number') {
      run.push({ value: token.value, raw: token.raw });
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** AS-247. Two numbers said together, read as one: «uno sesenta» is 1.60, «treinta y seis ocho» 36.8. */
export function joinedNumbers(first: number, second: number): number[] {
  const joined: number[] = [];
  if (
    (first === 1 || first === 2) &&
    Number.isInteger(second) &&
    second < 100
  ) {
    joined.push(first + second / 100);
  }
  if (
    Number.isInteger(first) &&
    first >= 10 &&
    Number.isInteger(second) &&
    second <= 9
  ) {
    joined.push(first + second / 10);
  }
  return joined;
}

/** AS-247. Where a number was said: the field that owns it, and whether a correction came after. */
export interface SaidOwner {
  fields: VitalField[];
  /** «150 con 95, perdón, 130 con 85»: the 150 was taken back. */
  superseded: boolean;
}

/**
 * AS-247 (B3). The readings that own a number in a conversation: each field named aloud owns what
 * is said until the next field is named or an unknown word ends it (AS-253), so «saturación noventa
 * y ocho, pulso ochenta y ocho» gives the 88 to the pulse, never to the saturation.
 */
export function ownersOf(text: string, said: number): SaidOwner[] {
  const near = (value: number) => Math.abs(value - said) < 1e-9;
  const tokens = tokenize(text);
  const owned = topicsIn(tokens, true).flatMap((span) => {
    const body = span.body;
    let last = -1;
    body.forEach((token, at) => {
      if (token.kind !== 'number') return;
      const next = body[at + 1];
      const values = [token.value];
      if (next?.kind === 'number') values.push(...joinedNumbers(token.value, next.value)); // prettier-ignore
      const pair = /^(\d{2,3})[.,](\d{2,3})$/.exec(token.raw);
      if (pair && span.topic === 'pressure') values.push(Number(pair[1]), Number(pair[2])); // prettier-ignore
      if (values.some(near)) last = at;
    });
    if (last < 0) return [];
    const after = body.slice(last + 1);
    const superseded = after.some(
      (token, at) =>
        token.kind === 'word' &&
        (CORRECTIONS.has(token.text) ||
          (token.text === 'dicho' && wordAt(after, at - 1) === 'mejor')) &&
        after.slice(at + 1).some((later) => later.kind === 'number'),
    );
    return [{ fields: fieldsOf(span.topic), superseded }];
  });
  if (owned.length > 0) return owned;
  // «treinta y seis y medio de temperatura», «setenta y ocho de pulso»: the
  // field named right after its number, joined by «de».
  return tokens.flatMap((token, at) => {
    if (token.kind !== 'number' || !near(token.value)) return [];
    if (wordAt(tokens, at + 1) !== 'de') return [];
    const topic = topicAt(tokens, at + 2);
    return topic ? [{ fields: fieldsOf(topic.topic), superseded: false }] : [];
  });
}

/**
 * «No sé» keeps its accent through the fold: whisper writes the doubt with it and the small talk
 * of a long dictation without it («no se preocupe»), and only the doubt empties a field.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[^\p{L}])no,?\s+sé(?!\p{L})/gu, '$1 nose ')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/%/g, ' por ciento ');
}

function tokenize(text: string): Token[] {
  const raw = fold(text).match(/\d+(?:[.,]\d+)?|[a-zñ]+\d*|\.{2,}|…|\//g) ?? [];
  const words: Token[] = raw.map((piece) => {
    if (/^\d/.test(piece)) {
      return {
        kind: 'number',
        value: Number(piece.replace(',', '.')),
        raw: piece,
      };
    }
    if (piece === '…' || piece.startsWith('..')) {
      return { kind: 'pause' };
    }
    return { kind: 'word', text: piece };
  });

  return withDecimals(
    withTensAndUnit(withSpokenNumbers(withoutPercent(words))),
  );
}

function wordAt(tokens: Token[], at: number): string | null {
  const token = tokens[at];
  return token?.kind === 'word' ? token.text : null;
}

/** «por ciento» is a unit, and left alone its «ciento» would read as another hundred. */
function withoutPercent(tokens: Token[]): Token[] {
  return tokens.filter(
    (_, at) =>
      !(wordAt(tokens, at) === 'por' && wordAt(tokens, at + 1) === 'ciento') &&
      !(wordAt(tokens, at) === 'ciento' && wordAt(tokens, at - 1) === 'por'),
  );
}

/** «ciento cuarenta y cinco» → 145. Two numbers said in a row stay two numbers. */
function withSpokenNumbers(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let at = 0;

  while (at < tokens.length) {
    const start = at;
    let value = 0;
    let word = wordAt(tokens, at);

    if (word !== null && word in HUNDREDS) {
      value += HUNDREDS[word]!;
      word = wordAt(tokens, ++at);
    }
    if (word !== null && word in TENS) {
      value += TENS[word]!;
      word = wordAt(tokens, ++at);
      const unit = wordAt(tokens, at + 1);
      if (word === 'y' && unit !== null && unit in UNITS && unit !== 'cero') {
        value += UNITS[unit]!;
        at += 2;
      }
    } else if (word !== null && word in TEENS) {
      value += TEENS[word]!;
      at++;
    } else if (
      word !== null &&
      word in UNITS &&
      (!/^una?$/.test(word) || countsAfter(tokens, at))
    ) {
      value += UNITS[word]!;
      at++;
    }

    if (at === start) {
      out.push(tokens[at]!);
      at++;
      continue;
    }

    const spoken = tokens
      .slice(start, at)
      .map((token) => wordAt([token], 0))
      .join(' ');
    out.push({ kind: 'number', value, raw: spoken });
  }

  return out;
}

/**
 * AS-280. «150 y 8» is 158: whisper writes «ciento cincuenta y ocho» that way. Only a tens or a
 * hundreds in figures (20…90, 110…190, never 100 or 200) and one unit from 1 to 9, so «120 y 80»,
 * «18 y 97» and «36 y medio» stay what they are.
 */
function withTensAndUnit(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    const unit = tokens[at + 2];
    if (
      token.kind === 'number' &&
      /^\d+$/.test(token.raw) &&
      token.value >= 20 &&
      token.value % 10 === 0 &&
      token.value % 100 !== 0 &&
      wordAt(tokens, at + 1) === 'y' &&
      unit?.kind === 'number' &&
      /^([1-9]|[a-z]+)$/.test(unit.raw) &&
      Number.isInteger(unit.value) &&
      unit.value >= 1 &&
      unit.value <= 9
    ) {
      out.push({ kind: 'number', value: token.value + unit.value, raw: `${token.raw} y ${unit.raw}` }); // prettier-ignore
      at += 2;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * «un metro sesenta» is a number and «siéntese un momento» is not: between readings, the small
 * talk of a long dictation would put a 1 beside the height.
 */
function countsAfter(tokens: Token[], at: number): boolean {
  const next = tokens[at + 1];
  const word = wordAt(tokens, at + 1);

  return (
    next?.kind === 'number' ||
    (word !== null &&
      (word in TENS ||
        word in TEENS ||
        word in UNITS ||
        /^metros?$/.test(word)))
  );
}

/** «36 y medio», «67 kilos y medio», «37 punto 4», «36 coma 8». */
function withDecimals(tokens: Token[]): Token[] {
  const out: Token[] = [];

  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind !== 'number') {
      out.push(token);
      continue;
    }

    const unit = /^(kilos?|kg|grados|libras?)$/.test(
      wordAt(tokens, at + 1) ?? '',
    )
      ? 1
      : 0;
    if (
      wordAt(tokens, at + 1 + unit) === 'y' &&
      wordAt(tokens, at + 2 + unit) === 'medio'
    ) {
      out.push({
        ...token,
        value: token.value + 0.5,
        raw: `${token.raw} y medio`,
      });
      if (unit) {
        out.push(tokens[at + 1]!);
      }
      at += 2 + unit;
      continue;
    }

    const separator = wordAt(tokens, at + 1);
    const next = tokens[at + 2];
    if (
      (separator === 'punto' || separator === 'coma') &&
      next?.kind === 'number' &&
      Number.isInteger(token.value) &&
      Number.isInteger(next.value)
    ) {
      const digits = /^\d+$/.test(next.raw) ? next.raw : String(next.value);
      out.push({
        kind: 'number',
        value: Number(`${token.value}.${digits}`),
        raw: `${token.value},${digits}`,
      });
      at += 2;
      continue;
    }

    out.push(token);
  }

  return out;
}

interface TopicSpan {
  topic: Topic;
  body: Token[];
  /** AS-253. A number came right after its end: it may have been part of it. */
  doubt?: boolean;
}

/**
 * AS-253. How many words after the end of a reading a number still casts doubt on it: «talla uno
 * sesenta y os, hueso sesenta y cinco» is a misheard «peso», not the end of the talk about height.
 */
const CLOSE_AFTER_END = 3;

/**
 * Each field named aloud owns what is said until the next field is named — or, since B3 (AS-253),
 * until a word that is not part of a reading follows its number.
 */
function topicsIn(tokens: Token[], endAtUnknownWord: boolean): TopicSpan[] {
  const spans: TopicSpan[] = [];
  let open: TopicSpan | null = null;
  let ended: { span: TopicSpan; words: number } | null = null;

  for (let at = 0; at < tokens.length; at++) {
    const match = topicAt(tokens, at);
    if (match === null) {
      const token = tokens[at]!;
      if (open === null && ended !== null) {
        if (token.kind === 'number') {
          ended.span.doubt = true;
          ended = null;
        } else if (token.kind === 'word' && ++ended.words > CLOSE_AFTER_END) {
          ended = null;
        }
      }
      if (
        endAtUnknownWord &&
        open !== null &&
        token.kind === 'word' &&
        !STAYS_IN_READING.has(token.text) &&
        open.body.some((said) => said.kind === 'number') &&
        !correctionAhead(tokens, at)
      ) {
        ended = { span: open, words: 1 };
        open = null;
      }
      open?.body.push(token);
      continue;
    }
    ended = null;
    open = { topic: match.topic, body: [] };
    spans.push(open);
    at += match.length - 1;
  }

  return spans;
}

/**
 * AS-253. «130 con 85, o mejor dicho, 130 con 80»: words before a correction still belong to the
 * reading they correct, so the cut never hides the value said last.
 */
function correctionAhead(tokens: Token[], from: number): boolean {
  for (let at = from; at < tokens.length; at++) {
    if (tokens[at]!.kind === 'number' || topicAt(tokens, at) !== null) {
      return false;
    }
    const word = wordAt(tokens, at);
    if (
      (word !== null && CORRECTIONS.has(word)) ||
      (word === 'dicho' && wordAt(tokens, at - 1) === 'mejor')
    ) {
      return true;
    }
  }
  return false;
}

function topicAt(
  tokens: Token[],
  at: number,
): { topic: Topic; length: number } | null {
  const word = wordAt(tokens, at);
  const next = wordAt(tokens, at + 1);

  switch (word) {
    case 'presion':
    case 'tension': {
      // AS-253. «presión sistólica 120», «presión arterial diastólica 80».
      const arterial = next === 'arterial' ? 1 : 0;
      const which = wordAt(tokens, at + 1 + arterial);
      if (which === 'sistolica') return { topic: 'systolic', length: 2 + arterial }; // prettier-ignore
      if (which === 'diastolica') return { topic: 'diastolic', length: 2 + arterial }; // prettier-ignore
      return { topic: 'pressure', length: arterial ? 2 : 1 };
    }
    case 'sistolica':
      return { topic: 'systolic', length: 1 };
    case 'diastolica':
      return { topic: 'diastolic', length: 1 };
    case 'perimetro':
    case 'circunferencia':
      if (next === 'cefalico' || next === 'cefalica' || next === 'craneal') {
        return { topic: 'headCircumferenceCm', length: 2 };
      }
      if (next === 'abdominal') {
        return { topic: 'abdominalCircumferenceCm', length: 2 };
      }
      return null;
    case 'hemoglobina':
    case 'hb':
      return next === 'corregida'
        ? { topic: 'hemoglobinCorrectedGDl', length: 2 }
        : { topic: 'hemoglobinGDl', length: 1 };
    case 'pa':
      return { topic: 'pressure', length: 1 };
    case 'frecuencia':
      if (next === 'respiratoria') {
        return { topic: 'respiratoryRate', length: 2 };
      }
      return {
        topic: 'heartRate',
        length: next === 'cardiaca' || next === 'cardiaco' ? 2 : 1,
      };
    case 'fc':
    case 'pulso':
      return { topic: 'heartRate', length: 1 };
    case 'fr':
    case 'respiracion':
      return { topic: 'respiratoryRate', length: 1 };
    case 'saturacion':
    case 'saturando':
    case 'satura':
    case 'sat':
    case 'oxigeno':
    case 'spo2':
      return {
        topic: 'oxygenSaturation',
        length: next === 'de' && wordAt(tokens, at + 2) === 'oxigeno' ? 3 : 1,
      };
    case 'temperatura':
    case 'temp':
      if (next === 'axilar') {
        return { topic: 'temperatureAxillaryC', length: 2 };
      }
      return {
        topic: 'temperatureC',
        length: next === 'bucal' || next === 'oral' ? 2 : 1,
      };
    case 'axilar':
      return { topic: 'temperatureAxillaryC', length: 1 };
    case 'bucal':
      return { topic: 'temperatureC', length: 1 };
    case 'peso':
    case 'pesa':
    case 'pesando':
      return { topic: 'weightKg', length: 1 };
    case 'talla':
    case 'estatura':
    case 'altura':
    case 'mide':
      return { topic: 'heightCm', length: 1 };
    default:
      return null;
  }
}

function fieldsOf(topic: Topic): VitalField[] {
  return topic === 'pressure' ? ['systolic', 'diastolic'] : [topic];
}

/** The values of one field, or `null` when what was said does not settle them. */
function readTopic(topic: Topic, said: Token[]): number[] | null {
  if (hesitates(said)) {
    return null;
  }

  const body = afterLastCorrection(said);
  const numbers = body.filter(
    (token): token is NumberToken => token.kind === 'number',
  );
  const words = new Set(
    body.flatMap((token) => (token.kind === 'word' ? [token.text] : [])),
  );
  const values = valuesOf(topic, numbers, words);

  if (values === null) {
    return null;
  }

  const fields = fieldsOf(topic);
  const plausible = values.every((value, at) => {
    const range = PLAUSIBLE[fields[at]!];
    return Number.isFinite(value) && value >= range.min && value <= range.max;
  });

  if (!plausible || (topic === 'pressure' && values[1]! >= values[0]!)) {
    return null;
  }

  return values;
}

function hesitates(said: Token[]): boolean {
  if (said.some((token) => token.kind === 'pause')) {
    return true;
  }

  return said.some((_, at) =>
    HESITATIONS.some((phrase) =>
      phrase.every((word, offset) => wordAt(said, at + offset) === word),
    ),
  );
}

/** «80, perdón, 84»: what counts is what comes after the last correction that says a number. */
function afterLastCorrection(said: Token[]): Token[] {
  for (let at = said.length - 1; at >= 0; at--) {
    const word = wordAt(said, at);
    const corrects =
      (word !== null && CORRECTIONS.has(word)) ||
      (word === 'dicho' && wordAt(said, at - 1) === 'mejor');

    if (
      corrects &&
      said.slice(at + 1).some((token) => token.kind === 'number')
    ) {
      return said.slice(at + 1);
    }
  }

  return said;
}

function valuesOf(
  topic: Topic,
  numbers: NumberToken[],
  words: Set<string>,
): number[] | null {
  switch (topic) {
    case 'pressure':
      return pressureOf(numbers);
    case 'heartRate':
    case 'respiratoryRate':
    case 'oxygenSaturation':
    case 'systolic':
    case 'diastolic':
      return numbers.length === 1 && Number.isInteger(numbers[0]!.value)
        ? [numbers[0]!.value]
        : null;
    case 'headCircumferenceCm':
    case 'abdominalCircumferenceCm':
    case 'hemoglobinGDl':
    case 'hemoglobinCorrectedGDl':
      return temperatureOf(numbers);
    case 'temperatureC':
    case 'temperatureAxillaryC':
      return temperatureOf(numbers);
    case 'weightKg':
      return weightOf(numbers, words);
    case 'heightCm':
      return heightOf(numbers);
  }
}

/** «120 con 80», «120 sobre 80», «120/80», and «110,70», which is how whisper writes «con». */
function pressureOf(numbers: NumberToken[]): number[] | null {
  if (numbers.length === 2 && numbers.every((n) => Number.isInteger(n.value))) {
    return [numbers[0]!.value, numbers[1]!.value];
  }

  const joined =
    numbers.length === 1
      ? /^(\d{2,3})[.,](\d{2,3})$/.exec(numbers[0]!.raw)
      : null;

  return joined ? [Number(joined[1]), Number(joined[2])] : null;
}

function temperatureOf(numbers: NumberToken[]): number[] | null {
  if (numbers.length === 1) {
    return [round(numbers[0]!.value, 1)];
  }

  const [whole, tenth] = numbers;
  if (
    numbers.length === 2 &&
    Number.isInteger(whole!.value) &&
    Number.isInteger(tenth!.value) &&
    tenth!.value <= 9
  ) {
    return [whole!.value + tenth!.value / 10];
  }

  return null;
}

function weightOf(numbers: NumberToken[], words: Set<string>): number[] | null {
  if (numbers.length !== 1) {
    return null;
  }

  const pounds =
    words.has('libras') ||
    words.has('libra') ||
    words.has('lb') ||
    words.has('lbs');

  return [round(pounds ? numbers[0]!.value * POUND_KG : numbers[0]!.value, 1)];
}

/** «1,70», «170 centímetros», «uno setenta», «un metro setenta». */
function heightOf(numbers: NumberToken[]): number[] | null {
  if (numbers.length === 1) {
    const { value } = numbers[0]!;
    return [Math.round(value < 3 ? value * 100 : value)];
  }

  const [metres, centimetres] = numbers;
  if (
    numbers.length === 2 &&
    (metres!.value === 1 || metres!.value === 2) &&
    Number.isInteger(centimetres!.value) &&
    centimetres!.value < 100
  ) {
    return [metres!.value * 100 + centimetres!.value];
  }

  return null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
