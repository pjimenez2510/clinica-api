import { inflateRawSync } from 'node:zlib';

import { XMLParser } from 'fast-xml-parser';

/**
 * EN-233, PR-116. A reader for the ministry's `.xlsx` files, with no new
 * dependency.
 *
 * An `.xlsx` is a zip of XML parts. Only what an import needs is read: the
 * sheet names in order, the shared strings and each cell's text. Formulas,
 * styles and dates are not — a catalogue is text — and a cell is returned as
 * the string the file stores.
 *
 * ⚠️ STANDALONE ON PURPOSE. The seeds in `prisma/` import this file under
 * `node --experimental-strip-types`, which cannot resolve extensionless
 * relative imports, so it imports nothing from the rest of `src/`.
 */

export interface Sheet {
  name: string;
  /** Rows in file order; each row indexed by column (A = 0), gaps as ''. */
  rows: string[][];
}

/** The parts of a zip, by path, inflated. */
function unzip(file: Buffer): Map<string, Buffer> {
  // End of central directory: the last record whose signature is 0x06054b50.
  let end = file.length - 22;
  while (end >= 0 && file.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('No es un archivo .xlsx (zip) válido');

  const entries = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const parts = new Map<string, Buffer>();

  for (let i = 0; i < entries; i += 1) {
    if (file.readUInt32LE(at) !== 0x02014b50)
      throw new Error('El directorio del .xlsx está dañado');
    const method = file.readUInt16LE(at + 10);
    const compressed = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const local = file.readUInt32LE(at + 42);
    const name = file.toString('utf8', at + 46, at + 46 + nameLength);

    // The local header repeats name and extra with its own lengths.
    const dataStart =
      local +
      30 +
      file.readUInt16LE(local + 26) +
      file.readUInt16LE(local + 28);
    const data = file.subarray(dataStart, dataStart + compressed);
    parts.set(name, method === 0 ? data : inflateRawSync(data));

    at += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Every element that can repeat comes back as an array, even with one.
  isArray: (name) =>
    ['sheet', 'Relationship', 'si', 'r', 'row', 'c'].includes(name),
  // Codes such as `A000` or `0,55` must stay text.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

/** The text of a `<t>`, which the parser returns bare or with attributes. */
function textOf(node: unknown): string {
  const value =
    typeof node === 'object' && node !== null
      ? (node as { '#text'?: unknown })['#text']
      : node;
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

/** A shared or inline string: one `<t>`, or rich-text runs `<r><t>`. */
interface RichText {
  t?: unknown;
  r?: { t?: unknown }[];
}
function stringOf(item: RichText): string {
  if (item.r) return item.r.map((run) => textOf(run.t)).join('');
  return textOf(item.t);
}

/** `B12` → 1. */
function columnOf(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A';
  return [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1; // prettier-ignore
}

/** The parts read, typed as far as an import uses them. */
interface SharedStringsXml {
  sst?: { si?: RichText[] };
}
interface RelationshipsXml {
  Relationships: { Relationship: { Id: string; Target: string }[] };
}
interface WorkbookXml {
  workbook: { sheets: { sheet: { name: string; 'r:id': string }[] } };
}
interface WorksheetXml {
  worksheet: {
    sheetData?: {
      row?: { c?: { r: string; t?: string; v?: unknown; is?: RichText }[] }[];
    };
  };
}

function xmlOf<T>(parts: Map<string, Buffer>, path: string): T {
  const part = parts.get(path);
  if (!part) throw new Error(`Al .xlsx le falta ${path}`);
  return parser.parse(part.toString('utf8')) as T;
}

/** Every sheet of the workbook, in the order the file lists them. */
export function readWorkbook(file: Buffer): Sheet[] {
  const parts = unzip(file);

  const shared: string[] = parts.has('xl/sharedStrings.xml')
    ? (
        xmlOf<SharedStringsXml>(parts, 'xl/sharedStrings.xml').sst?.si ?? []
      ).map(stringOf)
    : [];

  const targets = new Map<string, string>(
    xmlOf<RelationshipsXml>(
      parts,
      'xl/_rels/workbook.xml.rels',
    ).Relationships.Relationship.map((rel) => [
      rel.Id,
      rel.Target.replace(/^\/?(xl\/)?/, 'xl/'),
    ]),
  );

  const sheets = xmlOf<WorkbookXml>(parts, 'xl/workbook.xml').workbook.sheets
    .sheet;

  return sheets.map((sheet) => {
    const target = targets.get(sheet['r:id']);
    if (!target) throw new Error(`La hoja ${sheet.name} no tiene destino`);
    const rows =
      xmlOf<WorksheetXml>(parts, target).worksheet.sheetData?.row ?? [];

    return {
      name: sheet.name,
      rows: rows.map((row) => {
        const values: string[] = [];
        for (const cell of row.c ?? []) {
          const column = columnOf(cell.r);
          while (values.length < column) values.push('');
          values[column] =
            cell.t === 's'
              ? (shared[Number(textOf(cell.v))] ?? '')
              : cell.t === 'inlineStr'
                ? stringOf(cell.is ?? {})
                : textOf(cell.v);
        }
        return values;
      }),
    };
  });
}
