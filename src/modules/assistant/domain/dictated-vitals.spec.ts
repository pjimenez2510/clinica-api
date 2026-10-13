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
