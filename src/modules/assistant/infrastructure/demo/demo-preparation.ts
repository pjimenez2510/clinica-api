import {
  readDictatedVitals,
  type DictatedVitalField,
} from '../../domain/dictated-vitals';
import type {
  AnsweredPreparation,
  SaidUnit,
  Speaker,
} from '../../domain/preparation-reading';
import { saidIn } from '../../domain/preparation-reading';

const POUND_KG = 0.45359237;

/** A line that tells a complaint, as a patient says it. */
const COMPLAINT = /\b(me duele|dolor|molestia|tengo|me siento|vengo por|acudo)\b/iu; // prettier-ignore
/** A line that names a reading, as whoever prepares says it aloud. */
const READING = /\b(presi[oó]n|talla|peso|pesa|pulso|frecuencia|temperatura|saturaci[oó]n|hemoglobina|per[ií]metro|mide)\b/iu; // prettier-ignore

/**
 * AS-254 (B3). The reading of the demonstration, without a network: the rules
 * of «Dictar» over the whole conversation, each value pointed at the line
 * that says its number, the speaker told by what each line says, and the
 * reason from the patient's first line that tells one. Only plain patterns,
 * as the prompt asks of a model; the barrier believes what the lines back.
 */
export function preparationOf(prompt: string): AnsweredPreparation {
  const lines = [...prompt.matchAll(/^\[(L\d+)\] (.*)$/gm)].map((match) => ({
    line: match[1]!,
    text: match[2]!,
  }));
  const spoken = lines.map(({ line, text }, at) => ({
    line,
    speaker: speakerOf(text, lines[at - 1]?.text),
  }));
  const read = readDictatedVitals(lines.map((line) => line.text).join(' '), {
    endAtUnknownWord: true,
  });

  const values = Object.entries(read.signs).flatMap(([field, value]) => {
    for (const { line, text } of lines) {
      for (const said of saidIn(text, field as DictatedVitalField)) {
        const unit = unitFor(field, value, said, text);
        if (unit) return [{ field, line, quote: text, said, unit }];
      }
    }
    return [];
  }) as AnsweredPreparation['values'][number][];
  // The barrier is seen working: what the rules could not read is pointed at too.
  for (const field of read.unclear) {
    const line = lines.find(({ text }) => saidIn(text).length > 0 && READING.test(text) && named(field, text)); // prettier-ignore
    const said = line ? saidIn(line.text).at(-1) : undefined;
    if (line && said !== undefined) values.push({ field, line: line.line, quote: line.text, said, unit: 'none' }); // prettier-ignore
  }

  const position = lines.find(({ text }) => /\b(de pie|parad[oa]|acostad[oa])\b/iu.test(text)); // prettier-ignore
  const complaint = lines.find(
    ({ text }, at) => spoken[at]!.speaker === 'patient' && COMPLAINT.test(text),
  );
  return {
    lines: spoken,
    values,
    heightPosition: position
      ? {
          position: /acostad/iu.test(position.text) ? 'LYING' : 'STANDING',
          line: position.line,
          quote: /\b(de pie|parad[oa]|acostad[oa])\b/iu.exec(position.text)![0],
        }
      : null,
    complaint: complaint
      ? { line: complaint.line, quote: complaint.text, written: wordingOf(complaint.text) } // prettier-ignore
      : null,
  };
}

/** AS-283. What a patient puts before the reason: fillers and whom they speak to. */
const FILLERS = /^(?:(?:ay|bueno|pues|mire|oiga|este|verá|señorit[ao]|señora?|doctor[a]?|licenciad[ao]|enfermer[ao])[\s,.;:!¡]+)+/iu; // prettier-ignore

/**
 * AS-283. The reason as the nurse writes it, by plain rules: the fillers and a
 * «tengo» at the start dropped, «me duele» as «dolor en» and «me siento» as
 * «se siente». The barrier (AS-282) still decides whether it is believed.
 */
function wordingOf(sentence: string): string {
  const worded = sentence
    .replace(FILLERS, '')
    .replace(/^tengo\s+(?:una?\s+)?/iu, '')
    .replace(/^me\s+duelen?\s+/iu, 'Dolor en ')
    .replace(/\bme\s+siento\b/giu, 'se siente')
    .trim();
  return worded.charAt(0).toUpperCase() + worded.slice(1);
}

/** What whoever prepares says to receive the patient. */
const GREETING = /\b(buenos d[ií]as|buenas tardes|buenas noches|si[eé]ntese|p[aá]sele|pase)\b/iu; // prettier-ignore

/** AS-254. Who says a line: the question and the reading are the nurse's, the answer the patient's. */
function speakerOf(text: string, before: string | undefined): Speaker {
  if (/[¿?]/.test(text) || READING.test(text) || GREETING.test(text)) return 'nursing'; // prettier-ignore
  if (COMPLAINT.test(text) || /[¿?]\s*$/.test(before ?? '')) return 'patient';
  return 'other';
}

/** The unit that turns what a line said into the value the rules read, if any. */
function unitFor(
  field: string,
  value: number,
  said: number,
  text: string,
): SaidUnit | null {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  if (field === 'weightKg' && /libra/iu.test(text)) {
    return near(Math.round(said * POUND_KG * 10) / 10, value) ? 'lb' : null;
  }
  if (near(said, value)) return 'none';
  if (field === 'heightCm' && near(said * 100, value)) return 'm';
  return null;
}

const NAMES: Record<string, RegExp> = {
  respiratoryRate: /respiratoria/iu,
  heartRate: /pulso|card[ií]aca/iu,
  temperatureC: /temperatura/iu,
  oxygenSaturation: /saturaci/iu,
  weightKg: /pes[oa]/iu,
  heightCm: /talla|mide/iu,
};

function named(field: string, text: string): boolean {
  return NAMES[field]?.test(text) ?? false;
}
