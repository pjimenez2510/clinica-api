import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  chapterOf,
  proposeEquivalents,
  readWhoCie10,
  WHO_CHAPTERS,
  withDot,
} from './cie10-who';
import { readWorkbook } from './xlsx';

const official = () =>
  readWhoCie10(
    readWorkbook(
      readFileSync(
        resolve(
          __dirname,
          '../../../../prisma/catalogs/cie10-oms-deis-2026-08.xlsx',
        ),
      ),
    ),
  );

describe('the WHO CIE-10 list (EN-233, EN-234)', () => {
  it('EN-233: reads the 12 548 codes of the three sheets, each with its use', () => {
    const rows = official();

    expect(rows).toHaveLength(12_548);
    const byUse = (use: string) => rows.filter((row) => row.use === use).length;
    expect(byUse('PRINCIPAL')).toBe(8_910);
    expect(byUse('ASTERISK')).toBe(331);
    expect(byUse('EXTERNAL_CAUSE')).toBe(3_307);
    expect(rows.find((row) => row.code === 'J029')).toEqual({
      code: 'J029',
      display: 'Faringitis aguda, no especificada',
      use: 'PRINCIPAL',
    });
  });

  it('EN-233: places every official code in one of the 22 WHO chapters', () => {
    const rows = official();

    expect(WHO_CHAPTERS).toHaveLength(22);
    for (const row of rows) expect(chapterOf(row.code)).not.toBeNull();
    // The borders the clinical-modification ranges move: D48/D50, E90, K93,
    // O99, T98, Y98, and the U codes of chapter XXII.
    expect(chapterOf('D489')?.code).toBe('C00-D48');
    expect(chapterOf('D500')?.code).toBe('D50-D89');
    expect(chapterOf('E90X')?.code).toBe('E00-E90');
    expect(chapterOf('T983')?.code).toBe('S00-T98');
    expect(chapterOf('Y98X')?.code).toBe('V01-Y98');
    expect(chapterOf('U071')?.code).toBe('U00-U85');
  });

  it('EN-233: writes the code as a doctor reads it, keeping the X of the list', () => {
    expect(withDot('J029')).toBe('J02.9');
    expect(withDot('I10X')).toBe('I10.X');
  });

  it('EN-233: refuses a sheet it does not know rather than guessing its use', () => {
    expect(() =>
      readWhoCie10([
        { name: 'Hoja nueva', rows: [[], ['Código'], ['A000', 'x']] },
      ]),
    ).toThrow(/Hoja nueva/);
  });

  it('EN-233: refuses a code that appears twice', () => {
    const sheet = {
      name: 'Códigos, más (cruz o daga)',
      rows: [[], ['Código', 'Descripción'], ['A000', 'a'], ['A000', 'b']],
    };
    expect(() => readWhoCie10([sheet])).toThrow(/A000/);
  });

  it('EN-234: proposes, for a registered code the list lacks, the codes that begin like it', () => {
    const available = new Set(['A00.0', 'A00.1', 'A00.9', 'A01.0', 'E11.6', 'E11.9']); // prettier-ignore

    expect(
      proposeEquivalents(
        ['A00', 'A01.0', 'E11.65', 'E11.18', 'Q99.99X'],
        available,
      ),
    ).toEqual([
      // prettier-ignore
      { code: 'A00', proposals: ['A00.0', 'A00.1', 'A00.9'] },
      // A clinical-modification code: cut to four, then to the category.
      { code: 'E11.18', proposals: ['E11.6', 'E11.9'] },
      { code: 'E11.65', proposals: ['E11.6'] },
      { code: 'Q99.99X', proposals: [] },
    ]);
  });
});
