import { describe, expect, it } from 'vitest';

import {
  confirmationAllowed,
  sameHivTest,
  type HivTestAnswer,
} from './hiv-test';

const NON_REACTIVE: HivTestAnswer = {
  reason: 'VOLUNTARY',
  screening: { device: 'RAPID_FOURTH_GENERATION', result: 'NON_REACTIVE' },
  confirmation: null,
  transmissionRoute: null,
  viralLoad: null,
  cd4: null,
};

describe('EN-094 la prueba de VIH', () => {
  it('EN-094 la segunda prueba y la vía de transmisión sólo tras una primera reactiva', () => {
    const confirmed: HivTestAnswer = {
      ...NON_REACTIVE,
      confirmation: { device: 'ELISA', result: 'REACTIVE' },
    };
    expect(confirmationAllowed(NON_REACTIVE)).toBe(true);
    expect(confirmationAllowed(confirmed)).toBe(false);
    expect(confirmationAllowed({ ...NON_REACTIVE, transmissionRoute: 'SEXUAL' })).toBe(false); // prettier-ignore
    expect(
      confirmationAllowed({
        ...confirmed,
        screening: { device: 'ELISA', result: 'REACTIVE' },
      }),
    ).toBe(true);
  });

  it('EN-249 la misma prueba otra vez no es una corrección; otro CD4 sí', () => {
    expect(sameHivTest(NON_REACTIVE, { ...NON_REACTIVE })).toBe(true);
    expect(sameHivTest(NON_REACTIVE, { ...NON_REACTIVE, cd4: 500 })).toBe(
      false,
    );
    expect(
      sameHivTest(NON_REACTIVE, {
        ...NON_REACTIVE,
        confirmation: { device: 'NAT', result: 'NON_REACTIVE' },
      }),
    ).toBe(false);
  });
});
