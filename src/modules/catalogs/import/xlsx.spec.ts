import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readWorkbook } from './xlsx';

/**
 * EN-233, PR-116. The official CIE-10 and CNMB arrive as `.xlsx`, and the
 * importers read them as they came — no conversion step whose output nobody
 * can trace back to the ministry's file.
 */
const catalogs = resolve(__dirname, '../../../../prisma/catalogs');

describe('readWorkbook (EN-233, PR-116)', () => {
  it('EN-233: reads every sheet of the CIE-10 by name, shared strings resolved', () => {
    const book = readWorkbook(
      readFileSync(resolve(catalogs, 'cie10-oms-deis-2026-08.xlsx')),
    );

    expect(book.map((sheet) => sheet.name)).toEqual([
      'Códigos (asterisco)',
      'Códigos, más (cruz o daga)',
      'Códigos (causa externa)',
    ]);
    const principal = book[1]!.rows;
    expect(principal[1]).toEqual(['Código', 'Descripción']);
    expect(principal[2]).toEqual([
      'A000',
      'Cólera debido a Vibrio cholerae O1, biotipo cholerae',
    ]);
  });

  it('PR-116: keeps empty cells in their column, so a row never shifts left', () => {
    const [sheet] = readWorkbook(
      readFileSync(resolve(catalogs, 'cnmb-2026.xlsx')),
    );

    const header = sheet!.rows[0]!;
    expect(header[0]).toBe('Codigo medicamento');
    expect(header[12]).toBe('Riesgo en embarazo');
    // «Uso terapéutico» (column L) is empty for omeprazol, and «Riesgo en
    // embarazo» must still be the thirteenth value.
    const omeprazole = sheet!.rows.find((row) => row[4] === 'Omeprazol 20 mg');
    expect(omeprazole?.[11] ?? '').toBe('');
    expect(omeprazole?.[12]).toBe('C - Categoría C');
  });
});
