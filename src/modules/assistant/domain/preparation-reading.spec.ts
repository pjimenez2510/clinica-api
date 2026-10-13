import { describe, expect, it } from 'vitest';

import { conversationOf, type TranscriptLine } from './note-draft';
import {
  readPreparationAnswer,
  readPreparationByRules,
  saidIn,
  sentencesOf,
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
    expect(saidIn('Mide uno sesenta', 'heightCm')).toContain(1.6);
    expect(saidIn('Presión 120/80')).toEqual(expect.arrayContaining([120, 80]));
    expect(saidIn('temperatura treinta y seis ocho', 'temperatureC')).toContain(
      36.8,
    );
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
      values: [{ field: 'diastolicBp', line: 'L1', quote: 'presión diastólica 100', said: 100, unit: 'none' }], // prettier-ignore
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
    expect(proposal.complaint).toEqual({ text: 'Me duele la espalda y el pecho desde ayer.', quote: 'Me duele la espalda y el pecho desde ayer.', startMs: 3_000 }); // prettier-ignore
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

describe('AS-250 sentencesOf: who speaks changes within a window of the recogniser', () => {
  it('AS-250 splits a line into its sentences, each with a start inside the line, in order', () => {
    const window: TranscriptLine = {
      startMs: 0,
      endMs: 20_000,
      text: 'Buenos días, siéntese por favor. ¿Qué le trae por aquí? Me duele la espalda y el pecho desde ayer. Hemoglobina 22.5, talla 1,60.',
    };
    const sentences = sentencesOf([window, { startMs: 20_000, endMs: 24_000, text: 'Frecuencia respiratoria 18.' }]); // prettier-ignore

    expect(sentences.map((each) => each.text)).toEqual([
      'Buenos días, siéntese por favor.',
      '¿Qué le trae por aquí?',
      'Me duele la espalda y el pecho desde ayer.',
      'Hemoglobina 22.5, talla 1,60.',
      'Frecuencia respiratoria 18.',
    ]);
    const starts = sentences.map((each) => each.startMs);
    expect(starts[0]).toBe(0);
    expect(starts[4]).toBe(20_000);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(new Set(starts).size).toBe(starts.length);
    expect(sentences.every((each) => each.endMs > each.startMs && each.endMs <= (each.startMs < 20_000 ? 20_000 : 24_000))).toBe(true); // prettier-ignore
  });

  it('AS-250 leaves a line of one sentence as it is', () => {
    const line = { startMs: 3_000, endMs: 5_000, text: 'Pulso 72' };
    expect(sentencesOf([line])).toEqual([line]);
  });
});

describe('AS-247 AS-249 the barrier against what the review found (13-10-2026)', () => {
  const one = (
    text: string,
    values: AnsweredPreparation['values'],
    speaker: 'nursing' | 'patient' = 'nursing',
  ) => {
    // prettier-ignore
    const lines = [{ startMs: 0, endMs: 4_000, text }];
    return readPreparationAnswer({
      answer: { lines: [{ line: 'L1', speaker }], values, heightPosition: null, complaint: null }, // prettier-ignore
      lines,
      markers: conversationOf(lines).markers,
      restore: (phrase) => phrase,
    });
  };

  it('AS-247 never joins numbers with words between them', () => {
    expect(saidIn('Desde hace 2 días con fiebre de 38', 'heightCm')).not.toContain(2.38); // prettier-ignore
    expect(saidIn('Tengo 38 de fiebre desde hace 3 días', 'temperatureC')).not.toContain(38.3); // prettier-ignore
    expect(saidIn('tomo 1 pastilla y peso 70 kilos', 'heightCm')).not.toContain(1.7); // prettier-ignore
    expect(one('Temperatura treinta y siete desde hace cinco días.', [{ field: 'temperatureC', line: 'L1', quote: 'Temperatura treinta y siete desde hace cinco', said: 37.5, unit: 'none' }]).unclear).toEqual(['temperatureC']); // prettier-ignore
  });

  it('AS-247 a number goes only to the field named before it (saturation and pulse swapped)', () => {
    const swapped = one('Saturación noventa y ocho, pulso ochenta y ocho.', [
      { field: 'oxygenSaturation', line: 'L1', quote: 'ochenta y ocho', said: 88, unit: 'none' }, // prettier-ignore
      { field: 'heartRate', line: 'L1', quote: 'noventa y ocho', said: 98, unit: 'none' }, // prettier-ignore
    ]);
    expect(swapped.values).toEqual({});
    expect(swapped.unclear.sort()).toEqual(['heartRate', 'oxygenSaturation']);
    // Control: the right fields pass.
    const right = one('Saturación noventa y ocho, pulso ochenta y ocho.', [
      { field: 'oxygenSaturation', line: 'L1', quote: 'Saturación noventa y ocho', said: 98, unit: 'none' }, // prettier-ignore
      { field: 'heartRate', line: 'L1', quote: 'pulso ochenta y ocho', said: 88, unit: 'none' }, // prettier-ignore
    ]);
    expect(right.values).toMatchObject({ oxygenSaturation: { value: 98 }, heartRate: { value: 88 } }); // prettier-ignore
  });

  it('AS-247 the answer to a question belongs to the field the question named', () => {
    const lines = [
      { startMs: 0, endMs: 2_000, text: '¿Cuánto pesa?' },
      { startMs: 2_000, endMs: 4_000, text: 'Setenta kilos.' },
    ];
    const proposal = readPreparationAnswer({
      answer: { lines: [{ line: 'L1', speaker: 'nursing' }, { line: 'L2', speaker: 'nursing' }], values: [{ field: 'weightKg', line: 'L2', quote: 'Setenta kilos', said: 70, unit: 'kg' }], heightPosition: null, complaint: null }, // prettier-ignore
      lines,
      markers: conversationOf(lines).markers,
      restore: (phrase) => phrase,
    });
    expect(proposal.values.weightKg?.value).toBe(70);
  });

  it('AS-247 the unit is the one said: pounds only where pounds were said, never kilos', () => {
    expect(one('Pesa ciento cincuenta libras.', [{ field: 'weightKg', line: 'L1', quote: 'Pesa ciento cincuenta libras', said: 150, unit: 'kg' }]).unclear).toEqual(['weightKg']); // prettier-ignore
    expect(one('Pesa 70 kilos.', [{ field: 'weightKg', line: 'L1', quote: 'Pesa 70 kilos', said: 70, unit: 'lb' }]).unclear).toEqual(['weightKg']); // prettier-ignore
    expect(one('Pulso 72.', [{ field: 'heartRate', line: 'L1', quote: 'Pulso 72', said: 72, unit: 'kg' }]).unclear).toEqual(['heartRate']); // prettier-ignore
  });

  it('AS-247 a value taken back by a correction is not proposed', () => {
    expect(one('Presión 150 con 95, perdón, 130 con 85.', [{ field: 'systolicBp', line: 'L1', quote: 'Presión 150 con 95', said: 150, unit: 'none' }]).unclear).toEqual(['systolicBp']); // prettier-ignore
    expect(one('Presión 150 con 95, perdón, 130 con 85.', [{ field: 'systolicBp', line: 'L1', quote: '130 con 85', said: 130, unit: 'none' }]).values.systolicBp?.value).toBe(130); // prettier-ignore
  });

  it('AS-247 what the patient says was measured elsewhere is not the taking', () => {
    const home = one('En la casa me tomé la presión y tenía ciento sesenta con cien.', [{ field: 'systolicBp', line: 'L1', quote: 'presión y tenía ciento sesenta', said: 160, unit: 'none' }], 'patient'); // prettier-ignore
    expect(home.values).toEqual({});
    expect(home.unclear).toEqual([]);
  });

  it('AS-249 the reason is the whole sentence, so a «no» is never cut off', () => {
    const lines = [{ startMs: 0, endMs: 4_000, text: 'No me duele el pecho, me duele la espalda.' }]; // prettier-ignore
    const proposal = readPreparationAnswer({
      answer: { lines: [{ line: 'L1', speaker: 'patient' }], values: [], heightPosition: null, complaint: { line: 'L1', quote: 'me duele el pecho' } }, // prettier-ignore
      lines,
      markers: conversationOf(lines).markers,
      restore: (phrase) => phrase,
    });
    expect(proposal.complaint?.text).toBe('No me duele el pecho, me duele la espalda.'); // prettier-ignore
  });

  it('AS-251 by the rules, a value no single sentence holds is typed by hand', () => {
    const proposal = readPreparationByRules([
      { startMs: 0, endMs: 2_000, text: 'Pulso 72.' },
      { startMs: 2_000, endMs: 4_000, text: 'Repito, 72.' },
    ]);
    expect(proposal.values.heartRate).toBeUndefined();
    expect(proposal.unclear).toContain('heartRate');
  });
});

describe('AS-280 the height whisper writes «150 y 8»', () => {
  const ROSA: TranscriptLine[] = [
    { startMs: 0, endMs: 6_000, text: 'Ay, señorita, tengo un dolor de cabeza muy fuerte desde hace dos días y me siento mareada.' }, // prettier-ignore
    { startMs: 6_000, endMs: 12_000, text: 'Bueno, pesa 72 kilos y la talla 150 y 8 centímetros un medida de pie.' }, // prettier-ignore
  ];

  it('AS-280 saidIn reads «150 y 8» as 158, and leaves a pressure, a half and a list as they are', () => {
    expect(saidIn('la talla 150 y 8 centímetros', 'heightCm')).toEqual([158]);
    expect(saidIn('saturación 90 y 4', 'oxygenSaturation')).toEqual([94]);
    expect(saidIn('150 y ocho', 'heightCm')).toEqual([158]);
    // Only for the readings said whole: a temperature keeps its tenth.
    expect(saidIn('temperatura 40 y 2', 'temperatureC')).not.toContain(42);
    expect(saidIn('peso 70 y 5', 'weightKg')).not.toContain(75);
    expect(saidIn('150 y 8')).toEqual([150, 8]);
    expect(saidIn('10 y 5', 'heartRate')).toEqual([10, 5]);
    expect(saidIn('saturación 90 y 3 litros', 'oxygenSaturation')).toEqual([
      90, 3,
    ]);
    expect(saidIn('presión 120 y 80')).toEqual([120, 80]);
    expect(saidIn('36 y medio')).toEqual([36.5]);
    expect(saidIn('18 y 97')).toEqual([18, 97]);
    expect(saidIn('100 y 8')).toEqual([100, 8]);
    expect(saidIn('70 y 2.5')).toEqual([70, 2.5]);
  });

  it('AS-280 proposes the height 158 with its phrase as said', () => {
    const proposal = readPreparationAnswer({
      answer: answer({
        lines: [
          { line: 'L1', speaker: 'patient' },
          { line: 'L2', speaker: 'nursing' },
        ],
        values: [{ field: 'heightCm', line: 'L2', quote: 'la talla 150 y 8 centímetros', said: 158, unit: 'cm' }], // prettier-ignore
      }),
      lines: ROSA,
      markers: conversationOf(ROSA).markers,
      restore: (text) => text,
    });
    expect(proposal.values.heightCm).toEqual({ value: 158, startMs: 6_000, quote: 'la talla 150 y 8 centímetros' }); // prettier-ignore
    expect(proposal.unclear).toEqual([]);
  });

  it('AS-280 where «X y U» is not joined, neither of its numbers is a reading: «peso 80 y 3» is no weight of 3', () => {
    const lines = [{ startMs: 0, endMs: 5_000, text: 'Peso 80 y 3 kilos, temperatura 40 y 2.' }]; // prettier-ignore
    const proposal = readPreparationAnswer({
      answer: answer({
        lines: [{ line: 'L1', speaker: 'nursing' }],
        values: [
          { field: 'weightKg', line: 'L1', quote: 'Peso 80 y 3 kilos', said: 3, unit: 'kg' },
          { field: 'temperatureC', line: 'L1', quote: 'temperatura 40 y 2', said: 40, unit: 'none' },
        ],
      }), // prettier-ignore
      lines,
      markers: conversationOf(lines).markers,
      restore: (text) => text,
    });
    expect(proposal.values).toEqual({});
    expect(proposal.unclear).toEqual(['weightKg', 'temperatureC']);
  });

  it('AS-280 by the rules too, the height is 158 from its one sentence', () => {
    const proposal = readPreparationByRules(sentencesOf(ROSA));
    expect(proposal.values.heightCm?.value).toBe(158);
    expect(proposal.values.weightKg?.value).toBe(72);
  });
});

describe('AS-282 the reason worded as the nurse writes it, with the patient’s phrase as its source', () => {
  const ROSA: TranscriptLine[] = [
    { startMs: 7_000, endMs: 13_000, text: 'Ay, señorita, tengo un dolor de cabeza muy fuerte desde hace dos días y me siento mareada.' }, // prettier-ignore
  ];
  const reason = (written: string | undefined) =>
    readPreparationAnswer({
      answer: { lines: [{ line: 'L1', speaker: 'patient' }], values: [], heightPosition: null, complaint: { line: 'L1', quote: 'tengo un dolor de cabeza', written } }, // prettier-ignore
      lines: ROSA,
      markers: conversationOf(ROSA).markers,
      restore: (phrase) => phrase,
    }).complaint;

  it('AS-282 proposes the wording, and keeps the whole phrase as its source', () => {
    expect(
      reason(
        'Dolor de cabeza muy fuerte desde hace dos días, con sensación de mareo',
      ),
    ).toEqual({
      // prettier-ignore
      text: 'Dolor de cabeza muy fuerte desde hace dos días, con sensación de mareo',
      quote: ROSA[0]!.text,
      startMs: 7_000,
    });
  });

  it('AS-282 a wording that names someone, put back from the pseudonymizer, keeps the whole phrase (fifth review)', () => {
    const lines: TranscriptLine[] = [{ startMs: 0, endMs: 5_000, text: 'Juan con fiebre y tengo tos.' }]; // prettier-ignore
    const named = readPreparationAnswer({
      answer: { lines: [{ line: 'L1', speaker: 'patient' }], values: [], heightPosition: null, complaint: { line: 'L1', quote: 'Juan con fiebre', written: '[PERSONA_1] con fiebre y tos' } }, // prettier-ignore
      lines,
      markers: conversationOf(lines).markers,
      restore: (phrase) => phrase.replace('[PERSONA_1]', 'Juan'),
    }).complaint;
    expect(named?.text).toBe(lines[0]!.text);
  });

  it('AS-282 falls back to the whole phrase when the wording adds what was not said, or is missing', () => {
    expect(reason('Dolor de cabeza desde hace dos semanas')?.text).toBe(ROSA[0]!.text); // prettier-ignore
    expect(reason(undefined)?.text).toBe(ROSA[0]!.text);
  });
});
