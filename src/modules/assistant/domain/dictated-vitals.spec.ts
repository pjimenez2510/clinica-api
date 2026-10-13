import { describe, expect, it } from 'vitest';

import { readDictatedVitals } from './dictated-vitals';

describe('AS-180 AS-183 readDictatedVitals: what was said, in the fields of the taking', () => {
  it('AS-180 names every reading as encounter_vitals does', () => {
    expect(
      readDictatedVitals(
        'Presión 120 sobre 80, pulso 72, frecuencia respiratoria 18, temperatura 36 y medio, saturación 98, peso 70 kilos, talla 1,65',
      ),
    ).toEqual({
      signs: {
        systolicBp: 120,
        diastolicBp: 80,
        heartRate: 72,
        respiratoryRate: 18,
        temperatureC: 36.5,
        oxygenSaturation: 98,
        weightKg: 70,
        heightCm: 165,
      },
      unclear: [],
    });
  });

  it('AS-182 names the pressure as one doubt in both of its fields', () => {
    expect(readDictatedVitals('presión 80 con 120')).toEqual({
      signs: {},
      unclear: ['systolicBp', 'diastolicBp'],
    });
  });

  it('AS-182 leaves an impossible reading out and names it, and does not touch what was not said', () => {
    expect(
      readDictatedVitals('pulso 72, frecuencia respiratoria trescientos'),
    ).toEqual({ signs: { heartRate: 72 }, unclear: ['respiratoryRate'] });
  });

  it('AS-183 takes an axillary or an oral temperature into the only temperature field', () => {
    expect(readDictatedVitals('temperatura axilar 37,2').signs).toEqual({
      temperatureC: 37.2,
    });
    expect(readDictatedVitals('temperatura bucal 38').signs).toEqual({
      temperatureC: 38,
    });
  });

  it('AS-183 keeps the temperature when both sites agree', () => {
    expect(readDictatedVitals('temperatura 37, axilar 37')).toEqual({
      signs: { temperatureC: 37 },
      unclear: [],
    });
  });

  it('AS-183 proposes no temperature when the two sites disagree', () => {
    expect(
      readDictatedVitals('temperatura bucal 38 y medio, axilar 38'),
    ).toEqual({ signs: {}, unclear: ['temperatureC'] });
  });

  it('AS-183 proposes no temperature when one site is clear and the other is in doubt', () => {
    expect(readDictatedVitals('temperatura 37, axilar 365')).toEqual({
      signs: {},
      unclear: ['temperatureC'],
    });
  });

  it('AS-182 fills nothing from a sentence that names no reading', () => {
    expect(readDictatedVitals('buenos días, siéntese')).toEqual({
      signs: {},
      unclear: [],
    });
  });
});

describe('AS-253 readDictatedVitals: the words the author dictated with (13-10-2026)', () => {
  const CONVERSATION = { endAtUnknownWord: true };

  it('AS-253 reads the systolic and the diastolic said apart', () => {
    expect(
      readDictatedVitals('presión sistólica 120, presión diastólica 100'),
    ).toEqual({ signs: { systolicBp: 120, diastolicBp: 100 }, unclear: [] });
    expect(readDictatedVitals('sistólica 130 diastólica 85').signs).toEqual({
      systolicBp: 130,
      diastolicBp: 85,
    });
  });

  it('AS-253 does not propose a diastolic that is not below the systolic said apart', () => {
    expect(
      readDictatedVitals('presión sistólica 90, presión diastólica 100'),
    ).toEqual({ signs: {}, unclear: ['systolicBp', 'diastolicBp'] });
  });

  it('AS-253 reads the height, the head and the abdominal circumferences, each its own number', () => {
    expect(
      readDictatedVitals(
        'talla 160, perímetro cefálico 48, perímetro abdominal 65',
      ),
    ).toEqual({
      signs: {
        heightCm: 160,
        headCircumferenceCm: 48,
        abdominalCircumferenceCm: 65,
      },
      unclear: [],
    });
  });

  it('AS-253 reads the haemoglobin with its decimal and the corrected one', () => {
    expect(readDictatedVitals('hemoglobina 22.5').signs).toEqual({
      hemoglobinGDl: 22.5,
    });
    expect(
      readDictatedVitals('hemoglobina 13 coma 2, hemoglobina corregida 12,1')
        .signs,
    ).toEqual({ hemoglobinGDl: 13.2, hemoglobinCorrectedGDl: 12.1 });
  });

  it('AS-253 does not propose a corrected haemoglobin above the measured one', () => {
    expect(
      readDictatedVitals('hemoglobina 12, hemoglobina corregida 14'),
    ).toEqual({
      signs: { hemoglobinGDl: 12 },
      unclear: ['hemoglobinCorrectedGDl'],
    });
  });

  it('AS-253 takes how the height was measured', () => {
    expect(
      readDictatedVitals('talla 160, se lo midió de pie').heightPosition,
    ).toBe('STANDING');
    expect(
      readDictatedVitals('talla 75 centímetros acostado').heightPosition,
    ).toBe('LYING');
  });

  it('AS-253 says no position without a height, nor when both were said', () => {
    expect(
      readDictatedVitals('peso 70, de pie').heightPosition,
    ).toBeUndefined();
    expect(
      readDictatedVitals('talla 160 de pie, no, acostado').heightPosition,
    ).toBeUndefined();
  });

  it('AS-253 ends a reading at an unknown word after its number, so the next numbers are not glued to it', () => {
    const said =
      'pulso 80, hemoglobina 22.5, se lo midió de pie, acude por dolor a la espalda y en el pecho desde hace 3 días';
    expect(readDictatedVitals(said, CONVERSATION)).toEqual({
      signs: { heartRate: 80, hemoglobinGDl: 22.5 },
      unclear: [],
    });
    // Control: a dictation keeps SigmAI's reading, and the 3 leaves it in doubt.
    expect(readDictatedVitals(said)).toEqual({
      signs: { heartRate: 80 },
      unclear: ['hemoglobinGDl'],
    });
  });

  it('AS-253 the author’s whole dictation', () => {
    const read = readDictatedVitals(
      'presión sistólica 120, presión diastólica 100, talla 160, perímetro cefálico 48, perímetro abdominal 65, hemoglobina 22.5, se lo midió de pie, acude por dolor a la espalda y en el pecho',
    );
    expect(read).toEqual({
      signs: {
        systolicBp: 120,
        diastolicBp: 100,
        heightCm: 160,
        headCircumferenceCm: 48,
        abdominalCircumferenceCm: 65,
        hemoglobinGDl: 22.5,
      },
      unclear: [],
      heightPosition: 'STANDING',
    });
  });

  it('AS-253 does not end a reading at the words that lead to a correction («o mejor dicho»)', () => {
    expect(
      readDictatedVitals(
        'Presión 130 con 85, o mejor dicho, 130 con 80.',
        CONVERSATION,
      ).signs,
    ).toEqual({ systolicBp: 130, diastolicBp: 80 });
    expect(
      readDictatedVitals('sistólica 120, bueno, perdón, 124', CONVERSATION)
        .signs,
    ).toEqual({ systolicBp: 124 });
  });

  it('AS-253 leaves a reading in doubt when a number follows its end closely (a misheard field name)', () => {
    expect(
      readDictatedVitals(
        'Talla uno sesenta y os, hueso sesenta y cinco.',
        CONVERSATION,
      ),
    ).toEqual({ signs: {}, unclear: ['heightCm'] });
  });

  it('AS-253 keeps a word said before the number inside the reading', () => {
    expect(readDictatedVitals('el pulso está en 72').signs).toEqual({
      heartRate: 72,
    });
  });

  it('AS-253 leaves impossible new readings out (the limits of the database)', () => {
    expect(readDictatedVitals('perímetro cefálico 120')).toEqual({
      signs: {},
      unclear: ['headCircumferenceCm'],
    });
    expect(readDictatedVitals('hemoglobina 40').unclear).toEqual([
      'hemoglobinGDl',
    ]);
  });
});
