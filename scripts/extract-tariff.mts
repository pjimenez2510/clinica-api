import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  rowsOfPage,
  type Anomaly,
  type Box,
  type PageState,
  type TariffRow,
  type Word,
} from '../src/modules/catalogs/import/tariff-rows.ts';

/**
 * ORD-133. Extracts the Tarifario de Prestaciones para el SNS 2014 from its
 * PDF into `prisma/catalogs/tarifario-sns-2014.csv`, which the importer reads.
 *
 * Needs poppler (`pdftotext`, `pdftocairo`): the words with their boxes come
 * from `pdftotext -bbox`, and the cell borders from the page drawn as SVG by
 * `pdftocairo`, where each border is a thin filled rectangle. See
 * `tariff-rows.ts` for why the borders and not the text.
 *
 *   node --experimental-strip-types scripts/extract-tariff.mts [pdf]
 *
 * It prints the count per section and every row it could not read, and
 * writes the PDF's SHA-256 in the CSV's first line so the importer records
 * which file the rows came from.
 */

const PDF = resolve(
  process.argv[2] ??
    resolve(import.meta.dirname, '../../clinica-docs/TARIFARIO-PRESTACIONES-SNS-2014.pdf'), // prettier-ignore
);
const OUT = resolve(import.meta.dirname, '../prisma/catalogs/tarifario-sns-2014.csv'); // prettier-ignore

const pdfChecksum = createHash('sha256')
  .update(readFileSync(PDF))
  .digest('hex');
const pages = Number(
  /Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [PDF], { encoding: 'utf8' }))?.[1], // prettier-ignore
);

const decode = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** Every word of every page, from one `pdftotext -bbox` run. */
const wordsByPage = execFileSync('pdftotext', ['-bbox', PDF, '-'], {
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
})
  .split('<page ')
  .slice(1)
  .map((page) =>
    [
      ...page.matchAll(
        /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g,
      ),
    ].map(
      // prettier-ignore
      ([, x0, y0, x1, y1, text]): Word => ({
        x0: Number(x0),
        y0: Number(y0),
        x1: Number(x1),
        y1: Number(y1),
        text: decode(text!),
      }),
    ),
  );

/**
 * The filled rectangles of a page: the black ones are its cell borders, the
 * coloured ones the shading of a heading.
 */
function rectanglesOf(page: number): { rules: Box[]; shades: Box[] } {
  const svg = execFileSync(
    'pdftocairo',
    ['-svg', '-f', String(page), '-l', String(page), PDF, '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const body = svg.slice(svg.indexOf('</defs>') + 1);
  const rules: Box[] = [];
  const shades: Box[] = [];
  for (const match of body.matchAll(
    /<path[^>]*fill="rgb\(([^)]*)\)"[^>]*d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) Z/g,
  )) {
    // prettier-ignore
    const xs = [2, 4, 6, 8].map((k) => Number(match[k]));
    const ys = [3, 5, 7, 9].map((k) => Number(match[k]));
    const box = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
    const colour = match[1]!.replace(/\s/g, '');
    if (colour === '0%,0%,0%') rules.push(box);
    else if (colour !== '100%,100%,100%') shades.push(box);
  }
  return { rules, shades };
}

const rows: TariffRow[] = [];
const anomalies: Anomaly[] = [];
let state: PageState = { section: '', columns: '', last: null };
for (let page = 1; page <= pages; page += 1) {
  const result = rowsOfPage(
    { page, words: wordsByPage[page - 1] ?? [], ...rectanglesOf(page) },
    state,
  );
  rows.push(...result.rows);
  anomalies.push(...result.anomalies);
  state = result.state;
}

const csv = (value: string) => `"${value.replace(/"/g, '""')}"`;
writeFileSync(
  OUT,
  [
    `# sha256 del PDF: ${pdfChecksum}`,
    'code,description,values,section,columns,page',
    ...rows.map((row) =>
      [row.code, row.description, row.values.join(' '), row.section, row.columns, String(row.page)] // prettier-ignore
        .map(csv)
        .join(','),
    ),
  ].join('\n') + '\n',
);

const bySection = new Map<string, number>();
for (const row of rows) bySection.set(row.section, (bySection.get(row.section) ?? 0) + 1); // prettier-ignore
console.log(`${rows.length} filas de ${pages} páginas → ${OUT}`);
console.log(`sha-256 del PDF: ${pdfChecksum}`);
for (const [section, count] of bySection) console.log(`  ${String(count).padStart(5)}  ${section}`); // prettier-ignore
console.log(`\n${anomalies.length} filas sin leer:`);
for (const anomaly of anomalies) console.log(`  p. ${anomaly.page}: ${anomaly.reason} — ${anomaly.text.slice(0, 100)}`); // prettier-ignore
