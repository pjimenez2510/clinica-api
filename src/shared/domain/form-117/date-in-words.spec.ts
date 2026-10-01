import { describe, expect, it } from 'vitest';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import { dateInNumbersAndWords } from './date-in-words';

/**
 * CER-023, CER-026. «Escribir la fecha en letras», as form 117 asks.
 *
 * ⚠️ THE DATES HERE ARE FIXED ON PURPOSE: they are spelling cases of the
 * calendar — the first of a month, a «veintiuno», the last day of a year — and
 * not instants relative to today. Nothing here compares against a clock.
 */
const on = (iso: string) => iso as ClinicalDate;

const TWENTY_FIRST = on('2026-05-21'); // fecha-fija: caso de ortografía
const LAST_OF_YEAR = on('2027-12-31'); // fecha-fija: caso de ortografía
const FIRST_OF_MONTH = on('2026-10-01'); // fecha-fija: caso de ortografía

describe('la fecha en numeros y en letras del formulario 117', () => {
  it('CER-023 separa año, mes y dia en numeros, como las casillas del formulario', () => {
    expect(dateInNumbersAndWords(TWENTY_FIRST)).toMatchObject({
      iso: TWENTY_FIRST,
      year: 2026,
      month: 5,
      day: 21,
    });
  });

  it('CER-023 escribe el dia, el mes y el año en letras', () => {
    expect(dateInNumbersAndWords(TWENTY_FIRST).inWords).toBe(
      'veintiuno de mayo de dos mil veintiséis',
    );
    expect(dateInNumbersAndWords(LAST_OF_YEAR).inWords).toBe(
      'treinta y uno de diciembre de dos mil veintisiete',
    );
  });

  it('CER-026 el primero de mes se escribe «uno», derivado de la cifra como el resto', () => {
    expect(dateInNumbersAndWords(FIRST_OF_MONTH).inWords).toBe(
      'uno de octubre de dos mil veintiséis',
    );
  });
});
