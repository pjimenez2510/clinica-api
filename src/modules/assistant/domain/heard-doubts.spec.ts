import { describe, expect, it } from 'vitest';

import { readDictatedVitals } from './dictated-vitals';
import { withDoubts } from './heard-doubts';

const word = (text: string, probability = 0.99) => ({ text, probability });

describe('AS-197 withDoubts: a number the recogniser was unsure of is not read', () => {
  it('AS-197 keeps the text as written when every token is sure', () => {
    const words = [word('Pulso'), word(' 72'), word(','), word(' saturación'), word(' 98')]; // prettier-ignore

    expect(withDoubts('Pulso 72, saturación 98', words, 0.75)).toBe('Pulso 72, saturación 98'); // prettier-ignore
  });

  it('AS-197 an unsure number empties its field and names it, and the others are still read', () => {
    // «veintidós» heard as «20» with little confidence (E-055-like clip).
    const words = [word('frecuencia'), word(' respiratoria'), word(' 20', 0.69), word(','), word(' saturación'), word(' 91')]; // prettier-ignore

    const doubted = withDoubts('frecuencia respiratoria 20, saturación 91', words, 0.75); // prettier-ignore

    expect(readDictatedVitals(doubted)).toEqual({
      signs: { oxygenSaturation: 91 },
      unclear: ['respiratoryRate'],
    });
  });

  it('AS-197 an unsure word inside a reading also puts it in doubt («estatura en ochenta»)', () => {
    const words = [word('estatura'), word(' en', 0.23), word(' ochenta'), word(','), word(' peso'), word(' ochenta'), word(' y'), word(' nueve')]; // prettier-ignore

    expect(readDictatedVitals(withDoubts('', words, 0.75))).toEqual({
      signs: { weightKg: 89 },
      unclear: ['heightCm'],
    });
  });

  it('AS-197 control: at the threshold a token is sure', () => {
    expect(withDoubts('Pulso 72', [word('Pulso'), word(' 72', 0.75)], 0.75)).toBe('Pulso 72'); // prettier-ignore
  });

  it('AS-197 without the tokens it fails closed: every reading named is in doubt', () => {
    expect(
      readDictatedVitals(withDoubts('Pulso 72, saturación 98', [], 0.75)),
    ).toEqual({
      signs: {},
      unclear: ['heartRate', 'oxygenSaturation'],
    });
  });
});
