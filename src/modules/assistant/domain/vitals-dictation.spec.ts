import { describe, expect, it } from 'vitest';

import { interpretDictation } from './vitals-dictation';

describe('AS-181 AS-182 interpretDictation (SigmAI, as is)', () => {
  it('reads a whole dictation said in words', () => {
    expect(
      interpretDictation(
        'Presión ciento treinta y dos con ochenta y uno, frecuencia sesenta y seis, saturación noventa y seis, temperatura treinta y seis y medio, peso setenta y siete, talla uno cincuenta y dos',
      ),
    ).toEqual({
      signs: {
        systolic: 132,
        diastolic: 81,
        heartRate: 66,
        oxygenSaturation: 96,
        temperatureC: 36.5,
        weightKg: 77,
        heightCm: 152,
      },
      unclear: [],
    });
  });

  it('reads the digits whisper writes, including the comma it puts for «con»', () => {
    expect(
      interpretDictation(
        'Presión 100,65. Frecuencia 58. Saturación 99. Temperatura 37,1. Peso 54,5. Talla 1,49.',
      ),
    ).toEqual({
      signs: {
        systolic: 100,
        diastolic: 65,
        heartRate: 58,
        oxygenSaturation: 99,
        temperatureC: 37.1,
        weightKg: 54.5,
        heightCm: 149,
      },
      unclear: [],
    });
  });

  it.each([
    ['tensión arterial 170 sobre 105', 170, 105],
    ['PA 100/60', 100, 60],
    ['la presión anda en ciento quince, setenta y cinco', 115, 75],
    ['presión 128 con 84', 128, 84],
  ])('reads the pressure in «%s»', (said, systolic, diastolic) => {
    expect(interpretDictation(said).signs).toEqual({ systolic, diastolic });
  });

  it('tells the respiratory rate from the heart rate', () => {
    expect(
      interpretDictation(
        'frecuencia respiratoria veintidós, frecuencia cardíaca ciento cuatro, pulso ciento cuatro',
      ).signs,
    ).toEqual({ respiratoryRate: 22, heartRate: 104 });
  });

  it('reads saturation said as «saturando» or with a percent', () => {
    expect(interpretDictation('saturando 91').signs).toEqual({
      oxygenSaturation: 91,
    });
    expect(
      interpretDictation('oxígeno ochenta y nueve por ciento').signs,
    ).toEqual({
      oxygenSaturation: 89,
    });
    expect(interpretDictation('saturación 94%').signs).toEqual({
      oxygenSaturation: 94,
    });
  });

  it('keeps the axillary temperature apart from the oral one and reads spoken decimals', () => {
    expect(
      interpretDictation('temperatura axilar treinta y cinco punto nueve')
        .signs,
    ).toEqual({
      temperatureAxillaryC: 35.9,
    });
    expect(
      interpretDictation('temperatura 38 coma 3, axilar 37 y medio').signs,
    ).toEqual({
      temperatureC: 38.3,
      temperatureAxillaryC: 37.5,
    });
  });

  it('reads the height in metres or centimetres, and the weight in kilos or pounds', () => {
    expect(interpretDictation('estatura un metro sesenta y uno').signs).toEqual(
      { heightCm: 161 },
    );
    expect(interpretDictation('talla 176 cm').signs).toEqual({ heightCm: 176 });
    expect(interpretDictation('mide 1.58 m').signs).toEqual({ heightCm: 158 });
    expect(interpretDictation('peso 200 libras').signs).toEqual({
      weightKg: 90.7,
    });
    expect(interpretDictation('pesa ochenta kilos y medio').signs).toEqual({
      weightKg: 80.5,
    });
  });

  it('keeps what comes after a correction', () => {
    expect(interpretDictation('pulso 70, perdón, 74').signs).toEqual({
      heartRate: 74,
    });
    expect(interpretDictation('talla 1,60, no, 1,65').signs).toEqual({
      heightCm: 165,
    });
    expect(
      interpretDictation('presión 150 con 95, mejor dicho, 150 con 90').signs,
    ).toEqual({
      systolic: 150,
      diastolic: 90,
    });
  });

  it('leaves a field empty and names it when a number is missing, hesitated or impossible', () => {
    expect(interpretDictation('presión alta, saturación buena')).toEqual({
      signs: {},
      unclear: ['systolic', 'diastolic', 'oxygenSaturation'],
    });
    expect(interpretDictation('frecuencia 80... no sé')).toEqual({
      signs: {},
      unclear: ['heartRate'],
    });
    expect(interpretDictation('temperatura 365, peso 900')).toEqual({
      signs: {},
      unclear: ['temperatureC', 'weightKg'],
    });
    expect(interpretDictation('presión 80 con 120').unclear).toEqual([
      'systolic',
      'diastolic',
    ]);
    expect(interpretDictation('frecuencia 80 90').unclear).toEqual([
      'heartRate',
    ]);
  });

  it('does not guess between two different values for the same field', () => {
    expect(
      interpretDictation('pulso 80, saturación 97, frecuencia 88'),
    ).toEqual({
      signs: { oxygenSaturation: 97 },
      unclear: ['heartRate'],
    });
  });

  it('fills nothing from a sentence that names no field', () => {
    expect(interpretDictation('buenos días, ciento veinte')).toEqual({
      signs: {},
      unclear: [],
    });
    expect(interpretDictation('')).toEqual({ signs: {}, unclear: [] });
  });
  it('reads a long dictation taken while measuring, with the small talk in between', () => {
    expect(
      interpretDictation(
        'Peso 58 kilos. Bien, ahora súbase aquí. Talla 160. Ahora siéntese en la silla un momento, deme el brazo, lo voy a apretar un poquito. Presión 120 con 80. Espere que marque. Saturación 98. Temperatura axilar 36.7. Ahora respire normal, no se preocupe. Frecuencia respiratoria 18.',
      ),
    ).toEqual({
      signs: {
        weightKg: 58,
        heightCm: 160,
        systolic: 120,
        diastolic: 80,
        oxygenSaturation: 98,
        temperatureAxillaryC: 36.7,
        respiratoryRate: 18,
      },
      unclear: [],
    });
  });

  it('still reads «un metro» as a number and still doubts «no sé»', () => {
    expect(interpretDictation('talla un metro cincuenta').signs).toEqual({
      heightCm: 150,
    });
    expect(
      interpretDictation('saturación 90 y, no sé, espera').unclear,
    ).toEqual(['oxygenSaturation']);
    expect(interpretDictation('saturación 91, no sé').unclear).toEqual([
      'oxygenSaturation',
    ]);
  });
});
