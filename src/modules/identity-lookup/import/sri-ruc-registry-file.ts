/**
 * IL-009. Reading one file of the SRI RUC registry («catastro»), line by line.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BY HEADER, NOT BY POSITION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The official data dictionary (SRI_RUC_DD) was NOT read when this was built:
 * this branch does not enter the SRI's site, by D-206. So nothing assumes a
 * column order. The columns are found by name, with the spellings the
 * registry is known to use, and a file without them is refused whole —
 * importing names from the wrong column would propose a company's name as a
 * person's. Whoever imports the first real file checks it against SRI_RUC_DD.
 *
 * WHAT IS KEPT (LOPDP, minimisation): the cedula and the name of NATURAL
 * PERSONS, and nothing else. Activity, address, establishment and tax status
 * are in the file and are dropped here, before they reach the database.
 *
 * PURE AND A LEAF: no I/O and no imports. The importer
 * (`prisma/import-sri-ruc.mts`) runs on Node's type stripping, which only
 * loads a file whose imports carry their extension, and the build forbids
 * that extension; so the cedula rule arrives as an argument (`isCedula`,
 * which the importer takes from `cedula-rule.ts`, the one definition).
 */

const RUC_COLUMNS = ['NUMERO_RUC', 'RUC'];
const NAME_COLUMNS = [
  'RAZON_SOCIAL',
  'APELLIDOS_NOMBRES',
  'APELLIDOS_Y_NOMBRES',
];
const TYPE_COLUMNS = ['TIPO_CONTRIBUYENTE'];
const DELIMITERS = ['|', ';', '\t', ','] as const;

/** `sri_ruc_registry_entry.registry_name` is a varchar(300). */
const MAX_NAME_LENGTH = 300;

/**
 * IL-009. A name is letters (any script, with their combining marks), spaces
 * and the few marks a name carries: apostrophe, hyphen, period. A row with a
 * control character, a digit or markup is not a name — it is a malformed line
 * or the wrong column — and is dropped.
 */
const NAME_CHARACTERS = /^[-\p{L}\p{M} '.·’]+$/u;

export interface RegistryColumns {
  delimiter: string;
  ruc: number;
  name: number;
  /** Absent in some exports: then the RUC alone says natural person. */
  type: number | null;
}

export interface RegistryEntry {
  cedula: string;
  registryName: string;
}

export type RowOutcome =
  | { kept: RegistryEntry }
  | { skipped: 'NOT_A_NATURAL_PERSON' | 'INVALID_RUC' | 'NO_NAME' };

/** The file's header does not name the columns this importer needs. */
export class RegistryHeaderError extends Error {
  override readonly name = 'RegistryHeaderError';
}

/** `Razón social` and `RAZON SOCIAL` are the same column. */
function columnName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/^"|"$/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

/**
 * Splits one line, honouring double quotes (`""` is a quote). A quoted field
 * spanning lines is not supported: the registry writes one record per line.
 */
export function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"' && current === '') quoted = true;
    else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields;
}

/** The delimiter that splits the header into the most columns. */
function detectDelimiter(header: string): string {
  let best: string = DELIMITERS[0];
  let most = 0;
  for (const delimiter of DELIMITERS) {
    const count = splitLine(header, delimiter).length;
    if (count > most) {
      best = delimiter;
      most = count;
    }
  }
  return best;
}

/** IL-009. Finds the columns, or refuses the file. */
export function readHeader(header: string): RegistryColumns {
  const line = header.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(line);
  const names = splitLine(line, delimiter).map(columnName);
  const find = (aliases: string[]) => {
    const index = names.findIndex((name) => aliases.includes(name));
    return index === -1 ? null : index;
  };
  const ruc = find(RUC_COLUMNS);
  const name = find(NAME_COLUMNS);
  if (ruc === null || name === null) {
    throw new RegistryHeaderError(
      `El archivo no tiene las columnas del catastro: hace falta ${RUC_COLUMNS.join(' o ')} y ${NAME_COLUMNS.join(' o ')}`,
    );
  }
  return { delimiter, ruc, name, type: find(TYPE_COLUMNS) };
}

/**
 * IL-009. One row: kept only for a natural person whose RUC is a valid
 * cedula followed by `001`.
 */
export function readRow(
  line: string,
  columns: RegistryColumns,
  isCedula: (digits: string) => boolean,
): RowOutcome {
  const fields = splitLine(line, columns.delimiter);
  if (columns.type !== null) {
    const type = columnName(fields[columns.type] ?? '');
    if (!type.includes('PERSONA_NATURAL')) return { skipped: 'NOT_A_NATURAL_PERSON' }; // prettier-ignore
  }
  const ruc = (fields[columns.ruc] ?? '').trim();
  if (!/^\d{13}$/.test(ruc) || !ruc.endsWith('001')) return { skipped: 'INVALID_RUC' }; // prettier-ignore
  const cedula = ruc.slice(0, 10);
  // A company's RUC (third digit 6 or 9) is never a cedula, so this also
  // drops every legal person that slipped past a missing type column.
  if (!isCedula(cedula)) return { skipped: 'INVALID_RUC' };

  const registryName = (fields[columns.name] ?? '').trim().replace(/\s+/g, ' ');
  if (
    registryName === '' ||
    registryName.length > MAX_NAME_LENGTH ||
    !NAME_CHARACTERS.test(registryName)
  ) {
    // A control character or markup means a malformed row or the wrong column,
    // not a name: dropped before it reaches the table (and, later, a chart).
    return { skipped: 'NO_NAME' };
  }
  return { kept: { cedula, registryName } };
}

/**
 * The text of the file: UTF-8 when the bytes are valid UTF-8, Latin-1
 * otherwise. Decided on a sample, before streaming the whole file.
 */
export function detectEncoding(sample: Uint8Array): 'utf8' | 'latin1' {
  // `stream`: a multi-byte character cut at the end of the sample is not an
  // error, it is the rest of the file.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return 'utf8';
  } catch {
    return 'latin1';
  }
}
