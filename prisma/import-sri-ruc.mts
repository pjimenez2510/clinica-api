import { createHash } from 'node:crypto';
import { createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { cedulaProblem } from '../src/shared/domain/value-objects/cedula-rule.ts';
import {
  detectEncoding,
  readHeader,
  readRow,
  type RegistryEntry,
} from '../src/modules/identity-lookup/import/sri-ruc-registry-file.ts';

/**
 * IL-009 (D-206 §1 b). Imports one file of the SRI RUC registry («catastro»)
 * into `sri_ruc_registry_entry`.
 *
 *   pnpm db:import:sri-ruc <archivo.csv>
 *
 * THE FILE IS DOWNLOADED BY A PERSON from the SRI's open-data page, one per
 * province, and handed to this script. Nothing here talks to the SRI: no
 * request, no scraping, no captcha (D-206, «Decisión»). The real file is
 * personal data of third parties and stays OUT of git (`.gitignore`); the
 * repository carries only `prisma/catastro/sri-ruc-muestra.csv`, invented.
 *
 * IDEMPOTENT: the SHA-256 of the file is unique in `sri_ruc_registry_import`,
 * so the same file twice changes nothing. Another province is another file and
 * adds its people; a cedula that reappears takes the newer file's name.
 *
 * STREAMED, line by line: a province's file is large and the machine is
 * shared. Rows are written in batches inside ONE transaction, so a file
 * either lands whole, with its version row, or not at all.
 */

const BATCH = 2_000;
const SAMPLE_BYTES = 65_536;

export const SAMPLE_REGISTRY_FILE = resolve(
  import.meta.dirname,
  'catastro',
  'sri-ruc-muestra.csv',
);

export interface RegistryImportResult {
  status: 'imported' | 'unchanged';
  kept: number;
  skipped: number;
}

/** Both reads stream: the hash first, so an unchanged file is not parsed. */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function encodingOf(file: string): 'utf8' | 'latin1' {
  const fd = openSync(file, 'r');
  try {
    const sample = Buffer.alloc(SAMPLE_BYTES);
    const read = readSync(fd, sample, 0, SAMPLE_BYTES, 0);
    return detectEncoding(sample.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

/** Every natural person of the file, once per cedula (the first row wins). */
async function entriesOf(
  file: string,
): Promise<{ entries: RegistryEntry[]; skipped: number }> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: encodingOf(file) }),
    crlfDelay: Infinity,
  });
  const byCedula = new Map<string, RegistryEntry>();
  let columns: ReturnType<typeof readHeader> | null = null;
  let skipped = 0;
  for await (const line of lines) {
    if (line.trim() === '') continue;
    if (columns === null) {
      columns = readHeader(line);
      continue;
    }
    const outcome = readRow(line, columns, (digits) => cedulaProblem(digits) === null); // prettier-ignore
    if ('kept' in outcome) {
      if (!byCedula.has(outcome.kept.cedula))
        byCedula.set(outcome.kept.cedula, outcome.kept); // prettier-ignore
      else skipped++;
    } else skipped++;
  }
  if (columns === null) readHeader('');
  return { entries: [...byCedula.values()], skipped };
}

export async function importSriRucRegistry(
  prisma: PrismaClient,
  options: { file: string; now: Date },
): Promise<RegistryImportResult> {
  const fileSha256 = await sha256Of(options.file);
  const existing = await prisma.sriRucRegistryImport.findUnique({
    where: { fileSha256 },
  });
  if (existing) return { status: 'unchanged', kept: 0, skipped: 0 };

  const { entries, skipped } = await entriesOf(options.file);
  await prisma.$transaction(
    async (tx) => {
      const version = await tx.sriRucRegistryImport.create({
        data: {
          fileSha256,
          fileName: basename(options.file).slice(0, 255),
          rowsImported: entries.length,
          importedAt: options.now,
        },
      });
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        await tx.$executeRaw`
          INSERT INTO sri_ruc_registry_entry (cedula, registry_name, import_id)
          SELECT cedula, registry_name, ${version.id}::uuid
          FROM unnest(${batch.map((e) => e.cedula)}::text[],
                      ${batch.map((e) => e.registryName)}::text[])
            AS row(cedula, registry_name)
          ON CONFLICT (cedula) DO UPDATE
            SET registry_name = EXCLUDED.registry_name,
                import_id = EXCLUDED.import_id`;
      }
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
  return { status: 'imported', kept: entries.length, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ? resolve(process.argv[2]) : SAMPLE_REGISTRY_FILE; // prettier-ignore
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const result = await importSriRucRegistry(prisma, { file, now: new Date() }); // prettier-ignore
    console.log(
      result.status === 'unchanged'
        ? `${basename(file)} ya estaba importado: no cambió nada.`
        : `Catastro ${basename(file)}: ${result.kept} personas naturales importadas, ${result.skipped} filas descartadas (sociedades, otros establecimientos, sin nombre o repetidas).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
