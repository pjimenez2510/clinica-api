import type { TranscriptLine } from './note-draft';
import { sentencesOf } from './preparation-reading';

/**
 * AS-299 (D-265 §4). The certificate the physician says aloud, read by rules
 * and never by a model: its type and, for a rest, the days, each with the
 * phrase that says it and the minute. Nothing is issued here: the physician
 * issues it as always.
 */
export type SaidCertificateType = 'MEDICAL_REST' | 'ATTENDANCE';

export interface SaidPart<Value> {
  value: Value;
  quote: string;
  startMs: number;
}

export interface SaidCertificate {
  type: SaidPart<SaidCertificateType>;
  /** Only for a rest, and only when the days were said. */
  days: SaidPart<number> | null;
}

const TYPES: readonly { type: SaidCertificateType; said: RegExp }[] = [
  {
    type: 'MEDICAL_REST',
    said: /certificado\s+(?:m[eé]dico\s+)?(?:de|por)\s+reposo/giu,
  },
  { type: 'ATTENDANCE', said: /certificado\s+de\s+asistencia/giu },
];

/**
 * A «no» or «sin» in the clause right before «certificado», up to seven words
 * back, denies it («No, no le voy a hacer el certificado de reposo»); a
 * comma, «si», «pero» or «y» starts another clause, so Carmen's «no voy a
 * poder ir a trabajar si le hago un certificado…» is not denied.
 */
const DENIED_WITHIN_WORDS = 7;
const DENIAL = /^(?:no|sin|nunca|tampoco)$/iu;
const CLAUSE = /,|;|:|\b(?:si|pero|y)\b/giu;

/** «por un día», «por 3 días», «tres días de reposo»: right after the type. */
const DAYS =
  /^\W*(?:de\s+)?(?:por\s+)?(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+d[ií]as?\b/iu;
const DAYS_FROM_THE_TYPE = 30;
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};
/** The longest rest a phrase can propose; beyond it the physician types it. */
const MOST_DAYS = 30;

/**
 * AS-299. The last certificate said, or null: one denied after it takes it
 * back, and a question —the patient asking for one— says none (revisión M1).
 */
export function readCertificate(
  lines: readonly TranscriptLine[],
): SaidCertificate | null {
  let found: SaidCertificate | null = null;
  for (const sentence of sentencesOf(lines)) {
    if (/[¿?]/u.test(sentence.text)) continue;
    for (const { type, said } of TYPES) {
      for (const match of sentence.text.matchAll(said)) {
        if (denied(sentence.text.slice(0, match.index))) {
          found = null;
          continue;
        }
        found = {
          type: { value: type, quote: match[0], startMs: sentence.startMs },
          days:
            type === 'MEDICAL_REST'
              ? daysAfter(sentence, match.index + match[0].length)
              : null,
        };
      }
    }
  }
  return found;
}

function denied(before: string): boolean {
  const clause = before.split(CLAUSE).at(-1) ?? before;
  const words = clause.split(/[^\p{L}]+/u).filter(Boolean);
  return words.slice(-DENIED_WITHIN_WORDS).some((word) => DENIAL.test(word));
}

function daysAfter(
  sentence: TranscriptLine,
  from: number,
): SaidPart<number> | null {
  const after = sentence.text.slice(from, from + DAYS_FROM_THE_TYPE);
  const match = DAYS.exec(after);
  if (!match) return null;
  const said = match[1]!.toLowerCase();
  const value = NUMBER_WORDS[said] ?? Number(said);
  if (!Number.isInteger(value) || value < 1 || value > MOST_DAYS) return null;
  return {
    value,
    quote: match[0].replace(/^\W+/u, ''),
    startMs: sentence.startMs,
  };
}
