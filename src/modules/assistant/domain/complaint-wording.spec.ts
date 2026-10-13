import { describe, expect, it } from 'vitest';

import { groundedWording } from './complaint-wording';

const ROSA =
  'Ay, señorita, tengo un dolor de cabeza muy fuerte desde hace dos días y me siento mareada.';

describe('AS-282 a reason worded only from what the patient said', () => {
  it('AS-282 believes the wording of the nurse when each word, number and negation is in the phrase', () => {
    expect(groundedWording('Dolor de cabeza muy fuerte desde hace dos días, con sensación de mareo', ROSA)).toBe(true); // prettier-ignore
    expect(groundedWording('Dolor en la espalda y el pecho desde ayer.', 'Me duele la espalda y el pecho desde ayer.')).toBe(true); // prettier-ignore
    expect(groundedWording('Sin dolor de pecho; dolor de espalda.', 'No me duele el pecho, me duele la espalda.')).toBe(true); // prettier-ignore
  });

  it('AS-282 a duration, a number or a word the patient did not say is not believed', () => {
    expect(groundedWording('Dolor de cabeza desde hace dos semanas', ROSA)).toBe(false); // prettier-ignore
    expect(groundedWording('Dolor de cabeza desde hace 3 días', ROSA)).toBe(false); // prettier-ignore
    expect(groundedWording('Dolor de cabeza desde hace tres días', ROSA)).toBe(false); // prettier-ignore
    expect(groundedWording('Dolor de cabeza con fiebre', ROSA)).toBe(false);
    expect(groundedWording('Cefalea intensa de dos días', ROSA)).toBe(false);
  });

  it('AS-282 a negation lost or added is not believed', () => {
    const chest = 'No me duele el pecho, me duele la espalda.';
    expect(groundedWording('Dolor de pecho y espalda', chest)).toBe(false);
    expect(groundedWording('Dolor de cabeza, sin mareo', ROSA)).toBe(false);
  });

  it('AS-282 an empty wording, or one longer than the phrase, is not believed', () => {
    expect(groundedWording('', ROSA)).toBe(false);
    expect(groundedWording('   ', ROSA)).toBe(false);
    expect(groundedWording(`${ROSA} ${ROSA}`, ROSA)).toBe(false);
  });
});
