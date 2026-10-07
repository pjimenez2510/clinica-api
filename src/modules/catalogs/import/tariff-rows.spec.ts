import { describe, expect, it } from 'vitest';

import {
  figureOf,
  DISPLAY_LENGTH,
  readTariffCsv,
  rowsOfPage,
  tariffConceptsOf,
} from './tariff-rows';
import type { Box, PageLayout, Word } from './tariff-rows';

/**
 * ORD-133. Rows rebuilt from the cell borders of a page, on pages drawn here
 * the way the tariff's are: four columns — code, description, two figures —
 * with borders at x = 50, 100, 400, 450, 500.
 */
const COLUMNS = [50, 100, 400, 450, 500];

/** The borders of a table whose horizontal lines are at `ys`. */
function table(ys: number[]): Box[] {
  const top = ys[0]!;
  const bottom = ys.at(-1)!;
  return [
    ...ys.map((y) => ({ x0: 50, y0: y, x1: 500, y1: y + 0.5 })),
    ...COLUMNS.map((x) => ({ x0: x, y0: top, x1: x + 0.5, y1: bottom })),
  ];
}

/** A word at the column's left, on line `y`. */
const word = (text: string, x: number, y: number): Word => ({
  text,
  x0: x,
  y0: y,
  x1: x + text.length * 4,
  y1: y + 8,
});

const fresh = { section: '', columns: '', last: null };

describe('rowsOfPage (ORD-133)', () => {
  it('ORD-133: a description centred on its code is one row, read top to bottom', () => {
    const page: PageLayout = {
      page: 59,
      rules: table([300, 312, 324, 360]),
      words: [
        word('CODIGO', 55, 302),
        word('DESCRIPCION', 110, 302),
        word('UVR', 405, 302),
        word('I', 455, 302),
        word('RADIOLOGIA', 110, 314),
        // The row's description wraps around its code, as the PDF draws it.
        word('EXAMEN', 110, 327),
        word('CRÁNEO;', 160, 327),
        word('70250', 55, 338),
        word('VISTAS', 110, 349),
        word('2,80', 405, 349),
        word('1.234,95', 455, 349),
      ],
    };

    const { rows, anomalies } = rowsOfPage(page, fresh);

    expect(anomalies).toEqual([]);
    expect(rows).toEqual([
      {
        code: '70250',
        description: 'EXAMEN CRÁNEO; VISTAS',
        values: ['2.80', '1234.95'],
        section: 'RADIOLOGIA',
        columns: 'UVR · I',
        page: 59,
      },
    ]);
  });

  it('ORD-133: the top of a continued table finishes the row the page break cut', () => {
    const previous = rowsOfPage(
      {
        page: 115,
        rules: table([700, 740]),
        words: [word('11420', 55, 715), word('Escisión,', 110, 705), word('3,00', 405, 715)], // prettier-ignore
      },
      fresh,
    );

    const next = rowsOfPage(
      {
        page: 116,
        // The repeated heading at the top margin: the table continues.
        rules: table([71, 92, 103, 114, 140]),
        words: [
          word('CODIGO', 55, 75),
          word('UVR', 405, 94),
          word('diámetro', 110, 105),
          word('0,5', 160, 105),
          word('11421', 55, 125),
          word('Escisión', 110, 125),
          word('1,40', 405, 125),
        ],
        shades: [{ x0: 50, y0: 71, x1: 500, y1: 103 }],
      },
      previous.state,
    );

    expect(previous.rows[0]?.description).toBe('Escisión, diámetro 0,5');
    expect(next.rows.map((row) => row.code)).toEqual(['11421']);
    expect(next.state.section).toBe('');
  });

  it('ORD-133: a heading that opens a new table lower on the page is a section, not a tail', () => {
    const { rows, state } = rowsOfPage(
      {
        page: 30,
        rules: table([355, 366, 377, 388]),
        words: [
          word('CODIGO', 55, 357),
          word('HABITACION', 110, 368),
          word('381110', 55, 379),
          word('HABITACION', 110, 379),
          word('5,87', 405, 379),
        ],
      },
      { ...fresh, last: { code: '99100', description: 'Anestesia', values: [], section: '', columns: '', page: 18 } }, // prettier-ignore
    );

    expect(rows[0]).toMatchObject({ code: '381110', section: 'HABITACION' });
    expect(state.last?.code).toBe('381110');
  });

  it('ORD-133: finds the code of a merged row in another cell, but not in a worked example', () => {
    const { rows, anomalies } = rowsOfPage(
      {
        page: 43,
        rules: table([200, 220, 240]),
        words: [
          word('Transporte', 110, 205),
          word('aéreo,', 160, 205),
          word('hora', 200, 205),
          word('397270', 300, 205),
          word('0,25', 405, 205),
          word('74', 55, 225),
          word('min', 70, 225),
          word('99291', 110, 225),
          word('1,47', 405, 225),
        ],
      },
      fresh,
    );

    expect(rows.map((row) => [row.code, row.description])).toEqual([
      ['397270', 'Transporte aéreo, hora'],
    ]);
    expect(anomalies).toHaveLength(1);
  });

  it('ORD-133: reads figures as the decimals of Ecuador write them', () => {
    expect(figureOf('5,87')).toBe('5.87');
    expect(figureOf('1.234,99')).toBe('1234.99');
    expect(figureOf('1.190')).toBe('1190');
  });

  it('ORD-133: one concept per code, named by its first row with figures, keeping every row', () => {
    const csv = [
      `# sha256 del PDF: ${'a'.repeat(64)}`,
      'code,description,values,section,columns,page',
      '"99100","Anestesia, edad extrema","","","","18"',
      '"70250","EXAMEN RADIOLÓGICO, CRÁNEO","2.80 2.95 3.69","RADIOLOGIA","UVR I · UVR II · UVR III","59"',
      '"99100","Anestesia para paciente de edad ""extrema""","1.00","","UVR","109"',
      '"70250","Examen radiológico, cráneo","1.30 7.00","OTROS","HONORARIOS","316"',
    ].join('\n');

    const { pdfChecksum, rows } = readTariffCsv(csv);
    const concepts = tariffConceptsOf(rows);

    expect(pdfChecksum).toBe('a'.repeat(64));
    expect(concepts.map((c) => [c.code, c.display, c.values])).toEqual([
      ['99100', 'Anestesia para paciente de edad "extrema"', ['1.00']],
      ['70250', 'EXAMEN RADIOLÓGICO, CRÁNEO', ['2.80', '2.95', '3.69']],
    ]);
    expect(concepts[1]?.entries.map((e) => e.page)).toEqual([59, 316]);
  });

  it('ORD-133: refuses a CSV that does not say which PDF it came from', () => {
    expect(() => readTariffCsv('code,description\n')).toThrow(/PDF/);
  });

  it('ORD-133: shortens a name longer than the column at a word, and keeps the whole description', () => {
    const long = `Revisión ${'compleja '.repeat(80)}fin`;
    const [concept] = tariffConceptsOf([
      { code: '12345', description: long, values: ['1.00'], section: '', columns: '', page: 1 }, // prettier-ignore
    ]);

    expect(concept!.display.length).toBeLessThanOrEqual(DISPLAY_LENGTH);
    expect(concept!.display.endsWith('compleja…')).toBe(true);
    expect(concept!.description).toBe(long);
  });
});
