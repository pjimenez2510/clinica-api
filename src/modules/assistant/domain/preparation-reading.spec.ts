import { describe, expect, it } from 'vitest';

import { conversationOf, type TranscriptLine } from './note-draft';
import {
  readPreparationAnswer,
  readPreparationByRules,
  saidIn,
  type AnsweredPreparation,
} from './preparation-reading';

/** An invented preparation: the nurse asks, the patient answers. */
const LINES: TranscriptLine[] = [
  { startMs: 0, endMs: 3_000, text: 'Buenos días, ¿qué le trae por aquí?' },
  { startMs: 3_000, endMs: 7_000, text: 'Me duele la espalda y el pecho desde ayer.' }, // prettier-ignore
  { startMs: 7_000, endMs: 12_000, text: 'Presión sistólica ciento veinte, presión diastólica 100.' }, // prettier-ignore
  {
    startMs: 12_000,
    endMs: 16_000,
    text: 'Mide uno sesenta, se lo midió de pie.',
  },
  { startMs: 16_000, endMs: 20_000, text: 'Pesa ciento cincuenta libras y tiene treinta y seis y medio de temperatura.' }, // prettier-ignore
  { startMs: 20_000, endMs: 24_000, text: 'Hemoglobina 22.5, frecuencia respiratoria 92,5.' }, // prettier-ignore
];

const { markers } = conversationOf(LINES);

function answer(over: Partial<AnsweredPreparation> = {}): AnsweredPreparation {
  return {
    lines: [
      { line: 'L1', speaker: 'nursing' },
      { line: 'L2', speaker: 'patient' },
      { line: 'L3', speaker: 'nursing' },
    ],
    values: [],
    heightPosition: null,
    complaint: null,
    ...over,
  };
}

const read = (over: Partial<AnsweredPreparation>) =>
  readPreparationAnswer({
    answer: answer(over),
    lines: LINES,
    markers,
    restore: (text) => text,
  });

describe('AS-247 saidIn: the numbers a phrase says', () => {
  it('AS-247 reads figures, decimals and numbers said in words', () => {
    expect(saidIn('Presión sistólica ciento veinte')).toContain(120);
    expect(saidIn('treinta y seis y medio de temperatura')).toContain(36.5);
    expect(saidIn('Hemoglobina 22.5')).toContain(22.5);
    expect(saidIn('frecuencia respiratoria 92,5')).toContain(92.5);
    expect(saidIn('Mide uno sesenta')).toContain(1.6);
    expect(saidIn('Presión 120/80')).toEqual(expect.arrayContaining([120, 80]));
  });

  it('AS-247 says no number where there is none', () => {
    expect(saidIn('Me duele la espalda')).toEqual([]);
  });
});

describe('AS-246 AS-247 readPreparationAnswer: the number comes from the phrase', () => {
  it('AS-246 proposes a value with the start of its line and its phrase', () => {
    const proposal = read({
      values: [{ field: 'systolicBp', line: 'L3', quote: 'Presión sistólica ciento veinte', said: 120, unit: 'none' }], // prettier-ignore
    });
    expect(proposal.values.systolicBp).toEqual({
      value: 120,
      startMs: 7_000,
      quote: 'Presión sistólica ciento veinte',
    });
    expect(proposal.unclear).toEqual([]);
  });

  it('AS-247 never proposes a number the phrase does not say: the field is named unclear', () => {
    const proposal = read({
      values: [{ field: 'systolicBp', line: 'L3', quote: 'Presión sistólica ciento veinte', said: 130, unit: 'none' }], // prettier-ignore
    });
    expect(proposal.values).toEqual({});
    expect(proposal.unclear).toEqual(['systolicBp']);
  });

  it('AS-247 refuses a phrase that is not in its line, and a line it was never given', () => {
    const elsewhere = read({
      values: [{ field: 'diastolicBp', line: 'L2', quote: 'presión diastólica 100', said: 100, unit: 'none' }], // prettier-ignore
    });
    expect(elsewhere.unclear).toEqual(['diastolicBp']);
    const unknown = read({
      values: [{ field: 'diastolicBp', line: 'L9', quote: 'presión diastólica 100', said: 100, unit: 'none' }], // prettier-ignore
    });
    expect(unknown.unclear).toEqual(['diastolicBp']);
  });

  it('AS-247 compares the phrase without case, accents or punctuation', () => {
    const proposal = read({
      values: [{ field: 'diastolicBp', line: 'L3', quote: 'presion DIASTOLICA 100', said: 100, unit: 'none' }], // prettier-ignore
    });
    expect(proposal.values.diastolicBp?.value).toBe(100);
  });

  it('AS-247 converts pounds and metres in code, never trusting a converted number from the model', () => {
    const proposal = read({
      values: [
        { field: 'weightKg', line: 'L5', quote: 'Pesa ciento cincuenta libras', said: 150, unit: 'lb' }, // prettier-ignore
        { field: 'heightCm', line: 'L4', quote: 'Mide uno sesenta', said: 1.6, unit: 'm' }, // prettier-ignore
        { field: 'temperatureC', line: 'L5', quote: 'treinta y seis y medio de temperatura', said: 36.5, unit: 'none' }, // prettier-ignore
      ],
    });
    expect(proposal.values.weightKg?.value).toBe(68);
    expect(proposal.values.heightCm?.value).toBe(160);
    expect(proposal.values.temperatureC?.value).toBe(36.5);

    const converted = read({
      values: [{ field: 'weightKg', line: 'L5', quote: 'Pesa ciento cincuenta libras', said: 68, unit: 'kg' }], // prettier-ignore
    });
    expect(converted.unclear).toEqual(['weightKg']);
  });

  it('AS-247 refuses a decimal in a reading that is a whole number', () => {
    const proposal = read({
      values: [{ field: 'respiratoryRate', line: 'L6', quote: 'frecuencia respiratoria 92,5', said: 92.5, unit: 'none' }], // prettier-ignore
    });
    expect(proposal.unclear).toEqual(['respiratoryRate']);
  });
});

describe('AS-248 readPreparationAnswer: what a person can measure', () => {
  it('AS-248 leaves out what is beyond the limits, and keeps the haemoglobin the database admits', () => {
    const proposal = read({
      values: [
        { field: 'temperatureC', line: 'L6', quote: 'frecuencia respiratoria 92,5', said: 92.5, unit: 'none' }, // prettier-ignore
        { field: 'hemoglobinGDl', line: 'L6', quote: 'Hemoglobina 22.5', said: 22.5, unit: 'none' }, // prettier-ignore
      ],
    });
    expect(proposal.unclear).toEqual(['temperatureC']);
    expect(proposal.values.hemoglobinGDl?.value).toBe(22.5);
  });

  it('AS-248 a diastolic not below the systolic leaves both out', () => {
    const lines = [{ startMs: 0, endMs: 3_000, text: 'Sistólica 90, diastólica 100.' }]; // prettier-ignore
    const proposal = readPreparationAnswer({
      answer: answer({
        values: [
          { field: 'systolicBp', line: 'L1', quote: 'Sistólica 90', said: 90, unit: 'none' }, // prettier-ignore
          { field: 'diastolicBp', line: 'L1', quote: 'diastólica 100', said: 100, unit: 'none' }, // prettier-ignore
        ],
      }),
      lines,
      markers: conversationOf(lines).markers,
      restore: (text) => text,
    });
    expect(proposal.values).toEqual({});
    expect(proposal.unclear.sort()).toEqual(['diastolicBp', 'systolicBp']);
  });

  it('AS-248 two different values for one field leave it out', () => {
    const lines = [{ startMs: 0, endMs: 3_000, text: 'Pulso 80, no, pulso 84.' }]; // prettier-ignore
    const proposal = readPreparationAnswer({
      answer: answer({
        values: [
          { field: 'heartRate', line: 'L1', quote: 'Pulso 80', said: 80, unit: 'none' }, // prettier-ignore
          { field: 'heartRate', line: 'L1', quote: 'pulso 84', said: 84, unit: 'none' }, // prettier-ignore
        ],
      }),
      lines,
      markers: conversationOf(lines).markers,
      restore: (text) => text,
    });
    expect(proposal.unclear).toEqual(['heartRate']);
  });

  it('AS-248 a corrected haemoglobin above the measured one is left out', () => {
    const lines = [{ startMs: 0, endMs: 3_000, text: 'Hemoglobina 12, corregida 14.' }]; // prettier-ignore
    const proposal = readPreparationAnswer({
      answer: answer({
        values: [
          { field: 'hemoglobinGDl', line: 'L1', quote: 'Hemoglobina 12', said: 12, unit: 'none' }, // prettier-ignore
          { field: 'hemoglobinCorrectedGDl', line: 'L1', quote: 'corregida 14', said: 14, unit: 'none' }, // prettier-ignore
        ],
      }),
      lines,
      markers: conversationOf(lines).markers,
      restore: (text) => text,
    });
    expect(proposal.values.hemoglobinGDl?.value).toBe(12);
    expect(proposal.unclear).toEqual(['hemoglobinCorrectedGDl']);
  });

  it('AS-248 proposes how the height was taken only when its words are in the phrase and a height is proposed', () => {
    const height = { field: 'heightCm' as const, line: 'L4', quote: 'Mide uno sesenta', said: 1.6, unit: 'm' as const }; // prettier-ignore
    const standing = read({
      values: [height],
      heightPosition: { position: 'STANDING', line: 'L4', quote: 'se lo midió de pie' }, // prettier-ignore
    });
    expect(standing.heightPosition).toEqual({ value: 'STANDING', startMs: 12_000, quote: 'se lo midió de pie' }); // prettier-ignore

    const wrongWord = read({
      values: [height],
      heightPosition: { position: 'LYING', line: 'L4', quote: 'se lo midió de pie' }, // prettier-ignore
    });
    expect(wrongWord.heightPosition).toBeNull();
    const withoutHeight = read({
      heightPosition: { position: 'STANDING', line: 'L4', quote: 'se lo midió de pie' }, // prettier-ignore
    });
    expect(withoutHeight.heightPosition).toBeNull();
  });
});

describe('AS-249 AS-250 readPreparationAnswer: the reason, and who said each line', () => {
  it('AS-249 proposes the reason as the patient’s own phrase', () => {
    const proposal = read({
      complaint: { line: 'L2', quote: 'Me duele la espalda y el pecho' },
    });
    expect(proposal.complaint).toEqual({ text: 'Me duele la espalda y el pecho', startMs: 3_000 }); // prettier-ignore
  });

  it('AS-249 proposes no reason from a line of the nurse, nor one that is not in its line', () => {
    expect(read({ complaint: { line: 'L1', quote: '¿qué le trae por aquí?' } }).complaint).toBeNull(); // prettier-ignore
    expect(read({ complaint: { line: 'L2', quote: 'Tengo fiebre' } }).complaint).toBeNull(); // prettier-ignore
  });

  it('AS-250 says who said each line, and «other» for a line the reader did not label', () => {
    expect(read({}).speakers).toEqual(['nursing', 'patient', 'nursing', 'other', 'other', 'other']); // prettier-ignore
  });
});

describe('AS-251 readPreparationByRules: without the assistant', () => {
  it('AS-251 reads the conversation with the rules, with the phrase of a value when one line holds it', () => {
    const lines: TranscriptLine[] = [
      { startMs: 0, endMs: 2_000, text: '¿Cuánto pesa?' },
      { startMs: 2_000, endMs: 4_000, text: 'Setenta kilos.' },
      { startMs: 4_000, endMs: 8_000, text: 'Hemoglobina 22.5, se lo midió de pie, desde hace 3 días.' }, // prettier-ignore
      { startMs: 8_000, endMs: 10_000, text: 'Talla 160 y de pie.' },
    ];
    const proposal = readPreparationByRules(lines);
    expect(proposal.values).toEqual({
      weightKg: { value: 70, startMs: 2_000, quote: 'Setenta kilos.' },
      hemoglobinGDl: { value: 22.5, startMs: 4_000, quote: 'Hemoglobina 22.5, se lo midió de pie, desde hace 3 días.' }, // prettier-ignore
      heightCm: { value: 160, startMs: 8_000, quote: 'Talla 160 y de pie.' },
    });
    expect(proposal.heightPosition).toEqual({ value: 'STANDING', startMs: null, quote: null }); // prettier-ignore
    expect(proposal.complaint).toBeNull();
    expect(proposal.speakers).toEqual([null, null, null, null]);
  });
});
