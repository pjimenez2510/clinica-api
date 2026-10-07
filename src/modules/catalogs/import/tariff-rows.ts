/**
 * ORD-133. The rows of the Tarifario de Prestaciones del SNS 2014, rebuilt
 * from one page of the PDF: its words with their boxes and the borders of its
 * table cells.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE BORDERS AND NOT THE TEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The PDF is a Word document of tables. A description that wraps is centred
 * on its code, so half of it sits ABOVE the code's line and half below:
 *
 *               EXAMEN RADIOLÓGICO, CRÁNEO; MENOS DE CUATRO
 *       70250
 *               VISTAS, CON O SIN ESTEREOTÁCTICO              2,80  2,95  3,69
 *
 * Reading lines, the first half belongs to whichever code came before. The
 * cell borders are drawn as thin rectangles, and between two horizontal
 * borders lies exactly one row: what is inside belongs to it, whatever line
 * it is printed on.
 *
 * ⚠️ STANDALONE: imported by `scripts/extract-tariff.mts` under strip-types.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Word extends Box {
  text: string;
}

export interface PageLayout {
  page: number;
  words: Word[];
  /** Thin filled rectangles: the cell borders. */
  rules: Box[];
  /** Coloured fills: the shading of a table's heading. */
  shades?: Box[];
}

export interface TariffRow {
  code: string;
  description: string;
  /** The figures of the row, as decimals with a dot: `['2.80', '2.95']`. */
  values: string[];
  /** The last heading row of the table above it: «RADIOLOGIA CONVENCIONAL». */
  section: string;
  /** The column headings of the table it sits in: «UVR I · UVR II · UVR III». */
  columns: string;
  page: number;
}

/** What could not be read as a row, said rather than guessed. */
export interface Anomaly {
  page: number;
  text: string;
  reason: string;
}

/** Five or six digits; eight for the packages of the last section (`70100002`). */
const CODE = /^\d{5,8}$/;
/** `5,87`, `1.234,99`, and a whole amount with its thousands: `1.190`. */
const FIGURE = /^(\d{1,3}(\.\d{3})*,\d{2}|\d{1,3}(\.\d{3})+)$/;
/**
 * A band of notes inside a table: it neither is a row nor names a section.
 */
const NOTE = /^(NOTA|\(\*|Incluye|INCLUYE|Comprende)/;
/** A table that starts this high on the page is one continued from the last. */
const TOP_OF_PAGE = 75;
/** Borders are under 1.5 pt thick; two within 1 pt are the same line. */
const THIN = 1.5;
const SAME_LINE = 1;

const isHorizontal = (rule: Box) =>
  rule.y1 - rule.y0 < THIN && rule.x1 - rule.x0 > 10;
const isVertical = (rule: Box) =>
  rule.x1 - rule.x0 < THIN && rule.y1 - rule.y0 > 4;

/** `1.234,56` → `1234.56`. */
export function figureOf(text: string): string {
  return text.replace(/\./g, '').replace(',', '.');
}

/** Distinct positions, those within `SAME_LINE` merged. */
function lines(positions: number[]): number[] {
  const sorted = [...positions].sort((a, b) => a - b);
  return sorted.filter(
    (value, index) => index === 0 || value - sorted[index - 1]! > SAME_LINE,
  );
}

/** The words of a cell, in reading order: line by line, left to right. */
function textOf(words: readonly Word[]): string {
  return [...words]
    .sort((a, b) => (Math.abs(a.y0 - b.y0) > 2 ? a.y0 - b.y0 : a.x0 - b.x0))
    .map((word) => word.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PageState {
  section: string;
  columns: string;
  /** The last row read, which a page break may have cut. */
  last: TariffRow | null;
}

/**
 * ORD-133. The rows of one page. `state` carries the section and the column
 * headings across pages, as a table that continues does.
 */
export function rowsOfPage(
  layout: PageLayout,
  state: PageState,
): { rows: TariffRow[]; anomalies: Anomaly[]; state: PageState } {
  const horizontals = layout.rules.filter(isHorizontal);
  const verticals = layout.rules.filter(isVertical);
  const ys = lines(horizontals.map((rule) => rule.y0));

  const rows: TariffRow[] = [];
  const anomalies: Anomaly[] = [];
  let { section, columns, last } = state;
  let headerCells: string[][] = [];
  /** Whether the page's first table is the last page's, carried over. */
  let continued = false;
  /** Whether a data band has been read on this page yet. */
  let seenData = false;
  let seenTable = false;

  /** The table bands of the page: those vertical borders cross. */
  const bands = ys.slice(0, -1).flatMap((top, i) => {
    const bottom = ys[i + 1]!;
    const middle = (top + bottom) / 2;
    const borders = lines(
      verticals
        .filter((rule) => rule.y0 <= middle && rule.y1 >= middle)
        .map((rule) => rule.x0),
    );
    // Fewer than three borders: the paragraph between two tables.
    return borders.length < 3 ? [] : [{ top, bottom, borders }];
  });

  /**
   * THE HEADINGS OUTSIDE THE TABLES. In the professional fees (section D) a
   * section is a line of its own between tables — «SISTEMA RESPIRATORIO»,
   * «NARIZ» — and not a row. A line in capitals, without figures, is one.
   */
  const inTable = (word: Word) => {
    const y = (word.y0 + word.y1) / 2;
    return bands.some((band) => y > band.top && y < band.bottom);
  };
  const outside = new Map<number, Word[]>();
  for (const word of layout.words.filter((w) => !inTable(w))) {
    const y = Math.round(word.y0);
    outside.set(y, [...(outside.get(y) ?? []), word]);
  }
  const headings = [...outside.entries()]
    .map(([y, words]) => ({ y, text: textOf(words) }))
    .filter(
      ({ text }) =>
        /^[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ,;()/–-]{3,79}$/.test(text) &&
        !/\d/.test(text),
    );

  for (const { top, bottom, borders } of bands) {
    for (const heading of headings.filter((h) => h.y < top)) {
      section = heading.text;
      headings.splice(headings.indexOf(heading), 1);
    }
    const middle = (top + bottom) / 2;

    if (!seenTable) {
      seenTable = true;
      continued = top <= TOP_OF_PAGE;
    }

    const words = layout.words.filter((word) => {
      const y = (word.y0 + word.y1) / 2;
      return y > top && y < bottom;
    });
    if (words.length === 0) continue;

    const cells: Word[][] = borders.slice(0, -1).map(() => []);
    for (const word of words) {
      const x = (word.x0 + word.x1) / 2;
      const index = borders.findIndex(
        (left, k) => k + 1 < borders.length && x > left && x < borders[k + 1]!,
      );
      if (index >= 0) cells[index]!.push(word);
    }

    const all = textOf(words);
    const [codeCell = [], descriptionCell = [], ...valueCells] = cells;
    const shaded = (layout.shades ?? []).some(
      (shade) => shade.y0 <= middle && shade.y1 >= middle,
    );
    /**
     * A heading band: it says CÓDIGO or DESCRIPCIÓN, or it is shaded and
     * names columns (`HONORARIOS MEDICOS · ANESTESIA`, `UVR · UVR II`). A
     * shaded band that names neither («INMUNOLOGIA») is a section.
     */
    const heading =
      !codeCell.some((word) => CODE.test(word.text)) &&
      !words.some((word) => FIGURE.test(word.text)) &&
      (/C[OÓ]DIGO|DESCRIPCI[OÓ]N/.test(all) ||
        (shaded && /UVR|NIVEL|HONORARIOS|ANESTESIA|VALOR/.test(all)));
    if (heading) {
      // A heading band of the table: its value cells name the columns.
      headerCells = [...headerCells, valueCells.map(textOf)];
      columns = valueCells
        .map((_, k) =>
          headerCells
            .map((band) => band[k] ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((label) => label !== '')
        .join(' · ');
      continue;
    }
    headerCells = [];
    const firstData = !seenData;
    seenData = true;

    /**
     * The code is in its column. In a merged row («Transporte Aérea …
     * 397270») or a table that puts it elsewhere («1 año a 4 años · 99392 ·
     * …») it is the one code-shaped word of the band.
     */
    let code = codeCell.filter((word) => CODE.test(word.text));
    let description = textOf(descriptionCell);
    let figures = valueCells.flat().filter((word) => FIGURE.test(word.text));
    if (code.length === 0) {
      const anywhere = words.filter((word) => CODE.test(word.text));
      const longest = cells.reduce((a, b) => (b.length > a.length ? b : a));
      // Only with a real description: the worked examples of the anaesthesia
      // rules («74 min · 99291 · 42 · 1,47») are not prestaciones.
      if (anywhere.length === 1 && longest.length >= 3) {
        code = anywhere;
        figures = words.filter(
          (word) => FIGURE.test(word.text) && word !== anywhere[0],
        );
        const rest = cells.map((cell) =>
          cell.filter(
            (word) => word !== anywhere[0] && !FIGURE.test(word.text),
          ),
        );
        description = textOf(
          rest.reduce((longest, cell) =>
            cell.length > longest.length ? cell : longest,
          ),
        );
      }
    }
    const values = [...figures]
      .sort((a, b) => a.x0 - b.x0)
      .map((word) => figureOf(word.text));

    if (code.length > 1) {
      anomalies.push({ page: layout.page, text: all, reason: 'varios códigos en una fila' }); // prettier-ignore
      continue;
    }

    if (code.length === 0) {
      /**
       * THE TAIL OF A ROW A PAGE BREAK CUT. Word lets a row break across
       * pages: the rest of its description, and sometimes its last figure,
       * lands at the top of the next page under the repeated heading, with no
       * code. It belongs to the last row read. A section heading at the top of
       * a page opens a NEW table, lower down, and is never this.
       */
      if (continued && firstData && last !== null && !NOTE.test(all)) {
        last.description = `${last.description} ${description}`.trim();
        last.values = [...last.values, ...values];
      } else if (NOTE.test(all)) {
        // A note inside the table: neither a row nor a section.
      } else if (
        values.length > 0 &&
        last !== null &&
        last.values.length === 0 &&
        last.page === layout.page
      ) {
        // A row drawn in two bands (90840): its figures in the second one.
        last.description = `${last.description} ${description}`.trim();
        last.values = values;
      } else if (values.some((value) => Number(value) !== 0)) {
        anomalies.push({ page: layout.page, text: all, reason: 'cifras sin código' }); // prettier-ignore
      } else if (description !== '') {
        section = description;
      }
      continue;
    }

    const row: TariffRow = {
      code: code[0]!.text,
      description,
      values,
      section,
      columns,
      page: layout.page,
    };
    rows.push(row);
    last = row;
  }

  // A heading under the last table names what the next page continues.
  if (headings.length > 0) section = headings.at(-1)!.text;

  return { rows, anomalies, state: { section, columns, last } };
}

/** ORD-133. One concept of the tariff: a code and every row that names it. */
export interface TariffConcept {
  code: string;
  /** At most `DISPLAY_LENGTH` characters: `catalog_concept.display`. */
  display: string;
  /** The whole description, only when `display` had to be shortened. */
  description: string | null;
  /** The row the name comes from: the first one with figures. */
  section: string;
  columns: string;
  values: string[];
  page: number;
  /**
   * Every row of the code, when there is more than one. Most are the same
   * prestación in two components — institutional by level (section B) and
   * professional fees (section D), as 70250 is.
   */
  entries: Omit<TariffRow, 'code'>[];
}

/** The rows of `tarifario-sns-2014.csv`, and the PDF's checksum it records. */
export function readTariffCsv(content: string): {
  pdfChecksum: string;
  rows: TariffRow[];
} {
  const [first = '', , ...lines] = content.split('\n');
  const pdfChecksum = /sha256 del PDF: ([0-9a-f]{64})/.exec(first)?.[1];
  if (!pdfChecksum)
    throw new Error('El CSV del tarifario no dice de qué PDF sale');

  const rows = lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      // Every field is quoted and a quote inside is doubled.
      const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
        match[1]!.replace(/""/g, '"'),
      );
      if (fields.length !== 6)
        throw new Error(`Fila del tarifario con ${fields.length} campos: ${line.slice(0, 80)}`); // prettier-ignore
      const [code, description, values, section, columns, page] = fields;
      return {
        code: code!,
        description: description!,
        values: values === '' ? [] : values!.split(' '),
        section: section!,
        columns: columns!,
        page: Number(page),
      };
    });
  return { pdfChecksum, rows };
}

/** The width of `catalog_concept.display`. */
export const DISPLAY_LENGTH = 512;

/** Cut at a word, with an ellipsis, so the name never ends mid-word. */
function shortened(text: string): string {
  if (text.length <= DISPLAY_LENGTH) return text;
  const cut = text.slice(0, DISPLAY_LENGTH - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
}

/** ORD-133. One concept per code, in the order the PDF first names them. */
export function tariffConceptsOf(rows: readonly TariffRow[]): TariffConcept[] {
  const byCode = new Map<string, TariffRow[]>();
  for (const row of rows) byCode.set(row.code, [...(byCode.get(row.code) ?? []), row]); // prettier-ignore

  return [...byCode.entries()].map(([code, all]) => {
    const main = all.find((row) => row.values.length > 0) ?? all[0]!;
    return {
      code,
      display: shortened(main.description),
      description:
        main.description.length > DISPLAY_LENGTH ? main.description : null,
      section: main.section,
      columns: main.columns,
      values: main.values,
      page: main.page,
      entries:
        all.length > 1
          ? all.map((row) => ({
              description: row.description,
              values: row.values,
              section: row.section,
              columns: row.columns,
              page: row.page,
            }))
          : [],
    };
  });
}
