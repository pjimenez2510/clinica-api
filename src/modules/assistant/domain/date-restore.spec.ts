import { describe, expect, it } from 'vitest';

import { datesNotSaid, unshiftDates } from './date-restore';

/**
 * AS-091, AS-089. `clinica-ai` moves every date of a subject by a fixed
 * number of days (`privacy/dates.py`) in the forms it writes them; what the
 * model answers about the moved text has to say the real date again, and a
 * date that still does not match what was said is not something anybody said.
 */
describe('unshiftDates (AS-091)', () => {
  it.each([
    ['27/03/2026', 12, '15/03/2026'],
    ['27-03-2026', 12, '15-03-2026'],
    ['27.03.2026', 12, '15.03.2026'],
    ['2026-03-27', 12, '2026-03-15'], // fecha-fija: texto que el seudonimizador desplaza, no un instante
    ['el 27 de marzo de 2026', 12, 'el 15 de marzo de 2026'],
    ['el 27 de marzo', 12, 'el 15 de marzo'],
    ['EL 27 DE MARZO', 12, 'EL 15 DE MARZO'],
    ['27-mar-2026', 12, '15-mar-2026'],
    ['FUM: 27/03', 12, 'FUM: 15/03'],
    ['05/01/2026', -20, '25/01/2026'],
    ['FUM 2/4', 12, 'FUM 21/03'],
    ['el 7 de enero del 2026', 18, 'el 20 de diciembre del 2025'],
  ])('moves «%s» back by %d days', (moved, shift, real) => {
    expect(unshiftDates(moved, shift)).toBe(real);
  });

  it('leaves alone what is not a date: a pressure, a dose and an impossible day', () => {
    const text = 'TA 130/80, losartán 50 mg, 31/02/2026';
    expect(unshiftDates(text, 12)).toBe(text);
  });

  it('with no shift returns the text as it was', () => {
    expect(unshiftDates('27/03/2026', 0)).toBe('27/03/2026');
  });
});

describe('datesNotSaid (AS-089)', () => {
  const said = 'La última regla fue el 15 de marzo. Control el 02/04/2026.';

  it('a phrase whose dates were all said has none left over', () => {
    expect(datesNotSaid('Última regla el 15 de marzo.', said)).toEqual([]);
    expect(datesNotSaid('Control el 02/04/2026.', said)).toEqual([]);
  });

  it('a date the conversation never said is left over, so the phrase is unsaid', () => {
    expect(datesNotSaid('Última regla el 16 de marzo.', said)).toEqual([
      '16 de marzo',
    ]);
    expect(datesNotSaid('Control el 03/04/2026.', said)).toEqual([
      '03/04/2026',
    ]);
  });

  it('a phrase without dates has none to check', () => {
    expect(datesNotSaid('Dolor de garganta.', said)).toEqual([]);
  });

  it('a date matches only as a whole: «5 de marzo» is not «15 de marzo», nor 1/03 is 11/03', () => {
    const heard = 'Desde el 15 de marzo. Control el 11/03/2026.';
    expect(datesNotSaid('Desde el 5 de marzo.', heard)).toEqual(['5 de marzo']);
    expect(datesNotSaid('Control el 1/03/2026.', heard)).toEqual(['1/03/2026']);
    // The same date written with or without zeros, or «del», was said.
    expect(datesNotSaid('Control el 11/3/2026.', heard)).toEqual([]);
    expect(datesNotSaid('Desde el 15 de marzo del 2026.', 'el 15 de marzo de 2026')).toEqual([]); // prettier-ignore
  });

  it('every form the pseudonymizer moves is checked: day and month, month and year', () => {
    const heard = 'FUM: 10/2026 y FN 2/4';
    expect(datesNotSaid('FUM: 01/2027.', heard)).toEqual(['01/2027']);
    expect(datesNotSaid('FN 3/4.', heard)).toEqual(['3/4']);
    expect(datesNotSaid('FUM: 10/2026.', heard)).toEqual([]);
    expect(datesNotSaid('FN 2/4.', heard)).toEqual([]);
  });
});
