import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readWhoCie10 } from '../src/modules/catalogs/import/cie10-who.ts';
import {
  type CnmbMedicine,
  readCnmb,
} from '../src/modules/catalogs/import/cnmb.ts';
import { readWorkbook } from '../src/modules/catalogs/import/xlsx.ts';

/**
 * The two catalogues of arm D, read from the same files the seeds import
 * (`prisma/catalogs/`), with the same readers, so the harness and the
 * database see one catalogue. Each carries its SHA-256 (EV-7).
 */
export const CATALOGUE_DIR = join(process.cwd(), 'prisma', 'catalogs');
const CIE10_FILE = 'cie10-oms-deis-2026-08.xlsx';
const CNMB_FILE = 'cnmb-2026.xlsx';

export interface Catalogues {
  /** WHO CIE-10, 4 characters with a dot (`J02.9`, `I10.X`) → its name. */
  cie10: ReadonlyMap<string, string>;
  cnmb: readonly CnmbMedicine[];
  versions: { file: string; sha256: string }[];
}

const sha256 = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex');

export function loadCatalogues(dir = CATALOGUE_DIR): Catalogues {
  const cie10File = readFileSync(join(dir, CIE10_FILE));
  const cnmbFile = readFileSync(join(dir, CNMB_FILE));
  const cie10 = new Map(
    readWhoCie10(readWorkbook(cie10File)).map((row) => [
      `${row.code.slice(0, 3)}.${row.code.slice(3)}`,
      row.display,
    ]),
  );
  const [sheet] = readWorkbook(cnmbFile);
  if (!sheet) throw new Error(`${CNMB_FILE} no tiene hojas`);
  return {
    cie10,
    cnmb: readCnmb(sheet),
    versions: [
      { file: CIE10_FILE, sha256: sha256(cie10File) },
      { file: CNMB_FILE, sha256: sha256(cnmbFile) },
    ],
  };
}

/**
 * How a code is written, without asking any catalogue: upper case, and the
 * dot after the category (`j029` → `J02.9`, `i10` → `I10`). What arm A shows.
 */
export function formatCode(code: string): string {
  const bare = code.trim().replace(/\./g, '').toUpperCase();
  return bare.length > 3 ? `${bare.slice(0, 3)}.${bare.slice(3)}` : bare;
}

/**
 * EV-5. A code resolved against the WHO CIE-10 of 4 characters: its first
 * four characters, else its category written as the list writes one without
 * subdivisions (`I10` → `I10.X`). Null when the catalogue has neither.
 *
 * It maps CodiEsp's CIE-10-ES (built on ICD-10-CM: `n28.89`, `q62.11`) onto
 * the WHO list (`N28.8`, `Q62.1`), and it is the barrier of arm D: a code that
 * resolves to nothing is not shown.
 */
export function toWhoCode(
  code: string,
  cie10: ReadonlyMap<string, string>,
): string | null {
  const bare = code.trim().replace(/\./g, '').toUpperCase();
  if (!/^[A-Z]\d{2}/.test(bare)) return null;
  for (const candidate of [bare.slice(0, 4), `${bare.slice(0, 3)}X`]) {
    if (candidate.length !== 4) continue;
    const dotted = `${candidate.slice(0, 3)}.${candidate.slice(3)}`;
    if (cie10.has(dotted)) return dotted;
  }
  return null;
}

/** Lower case, no accents: how words are compared. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * What physicians in Ecuador abbreviate in a problem list, spelled out for
 * the search only (the prompt keeps the physician's words).
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  hta: 'hipertension arterial',
  dm: 'diabetes mellitus',
  dm2: 'diabetes mellitus tipo 2',
  ivu: 'infeccion vias urinarias',
  itu: 'infeccion tracto urinario',
  eda: 'enfermedad diarreica aguda gastroenteritis',
  ira: 'infeccion respiratoria aguda',
  erge: 'enfermedad reflujo gastroesofagico',
  epoc: 'enfermedad pulmonar obstructiva cronica',
  icc: 'insuficiencia cardiaca',
  fa: 'fibrilacion auricular',
  hpb: 'hiperplasia prostata',
};

const STOPWORDS = new Set([
  'del',
  'las',
  'los',
  'por',
  'con',
  'sin',
  'una',
  'que',
  'para',
  'otro',
  'otros',
  'otras',
  'especificado',
  'especificada',
  'especificacion',
]);

export function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .flatMap((word) => (ABBREVIATIONS[word] ?? word).split(' '))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** Two words are the same word when they share their first five letters (or are equal). */
const same = (a: string, b: string) =>
  a === b ||
  (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

/** The words of every name, once per catalogue: a run searches it hundreds of times. */
const INDEX = new WeakMap<
  ReadonlyMap<string, string>,
  { code: string; name: string; words: string[] }[]
>();
function indexed(cie10: ReadonlyMap<string, string>) {
  let index = INDEX.get(cie10);
  if (!index) {
    index = [...cie10].map(([code, name]) => ({
      code,
      name,
      words: wordsOf(name),
    }));
    INDEX.set(cie10, index);
  }
  return index;
}

/**
 * The candidates of arm D for a problem: the codes whose name shares the most
 * words with it, then the shortest name (the general code before the
 * specific). A plain lexical search, on purpose: D measures what a catalogue
 * checked by code adds, not a better search engine.
 */
export function searchCie10(
  phrase: string,
  cie10: ReadonlyMap<string, string>,
  limit = 20,
): { code: string; name: string }[] {
  const wanted = [...new Set(wordsOf(phrase))];
  if (wanted.length === 0) return [];
  const scored: { code: string; name: string; score: number }[] = [];
  for (const { code, name, words } of indexed(cie10)) {
    const score = wanted.filter((w) => words.some((n) => same(w, n))).length;
    if (score > 0) scored.push({ code, name, score });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.name.length - b.name.length ||
        a.code.localeCompare(b.code),
    )
    .slice(0, limit)
    .map(({ code, name }) => ({ code, name }));
}

/**
 * The candidates of arm D for a dictated prescription: the CNMB medicines
 * whose name appears in it, every word of the name (`amoxicilina + ácido
 * clavulánico` needs both). Longest names first, so the combination comes
 * before the single substance.
 */
export function searchCnmb(
  dictation: string,
  cnmb: readonly CnmbMedicine[],
  limit = 6,
): CnmbMedicine[] {
  const said = wordsOf(dictation);
  return cnmb
    .filter((medicine) => {
      const words = wordsOf(medicine.display).filter((w) => w.length >= 4);
      return (
        words.length > 0 && words.every((w) => said.some((s) => same(w, s)))
      );
    })
    .sort((a, b) => b.display.length - a.display.length)
    .slice(0, limit);
}
