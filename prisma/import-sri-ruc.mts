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

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Writes one batch of entries, newest file winning on a repeated cedula. */
async function writeBatch(
  tx: Tx,
  importId: string,
  batch: RegistryEntry[],
): Promise<void> {
  if (batch.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO sri_ruc_registry_entry (cedula, registry_name, import_id)
    SELECT cedula, registry_name, ${importId}::uuid
    FROM unnest(${batch.map((e) => e.cedula)}::text[],
                ${batch.map((e) => e.registryName)}::text[])
      AS row(cedula, registry_name)
    ON CONFLICT (cedula) DO UPDATE
      SET registry_name = EXCLUDED.registry_name,
          import_id = EXCLUDED.import_id`;
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

  const encoding = encodingOf(options.file);
  let kept = 0;
  let skipped = 0;
  await prisma.$transaction(
    async (tx) => {
      // The version row first, with a placeholder count updated at the end.
      const version = await tx.sriRucRegistryImport.create({
        data: {
          fileSha256,
          fileName: basename(options.file).slice(0, 255),
          rowsImported: 0,
          importedAt: options.now,
        },
      });

      // STREAMED AND WRITTEN IN BATCHES, so a province's file is never held
      // whole in memory. Deduplication within the file (first row wins) is a
      // `Set` of cedulas — ten characters each — not of whole rows.
      const lines = createInterface({
        input: createReadStream(options.file, { encoding }),
        crlfDelay: Infinity,
      });
      const seen = new Set<string>();
      let batch: RegistryEntry[] = [];
      let columns: ReturnType<typeof readHeader> | null = null;
      for await (const line of lines) {
        if (line.trim() === '') continue;
        if (columns === null) {
          columns = readHeader(line);
          continue;
        }
        const outcome = readRow(
          line,
          columns,
          (d) => cedulaProblem(d) === null,
        );
        if (!('kept' in outcome) || seen.has(outcome.kept.cedula)) {
          skipped++;
          continue;
        }
        seen.add(outcome.kept.cedula);
        batch.push(outcome.kept);
        kept++;
        if (batch.length >= BATCH) {
          await writeBatch(tx, version.id, batch);
          batch = [];
        }
      }
      if (columns === null) readHeader(''); // an empty file: refuse it the same way
      await writeBatch(tx, version.id, batch);
      await tx.sriRucRegistryImport.update({
        where: { id: version.id },
        data: { rowsImported: kept },
      });
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
  return { status: 'imported', kept, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // IL-009: the file is ALWAYS named. The invented sample is loaded only by
  // `db:seed:identity` (prisma/seed-identity.mts), which refuses production:
  // a bare `db:import:sri-ruc` on a real database must never fill it with made
  // up names for real cedulas.
  const argument = process.argv[2];
  if (!argument) {
    console.error(
      'Uso: pnpm db:import:sri-ruc <archivo.csv>\n' +
        'Descargue el catastro de una provincia del sitio del SRI y pase su ruta.',
    );
    process.exit(64);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const result = await importSriRucRegistry(prisma, {
      file: resolve(argument),
      now: new Date(),
    });
    console.log(
      result.status === 'unchanged'
        ? `${basename(argument)} ya estaba importado: no cambió nada.`
        : `Catastro ${basename(argument)}: ${result.kept} personas naturales importadas, ${result.skipped} filas descartadas (sociedades, otros establecimientos, sin nombre o repetidas).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
