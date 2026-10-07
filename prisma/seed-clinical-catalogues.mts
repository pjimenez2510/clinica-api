import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

import { readCnmb } from '../src/modules/catalogs/import/cnmb.ts';
import { nextClinicDay } from '../src/modules/catalogs/import/cutover.ts';
import { readWorkbook } from '../src/modules/catalogs/import/xlsx.ts';

/**
 * El CNMB oficial y el tarifario de prestaciones.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CNMB (PR-114 a PR-116)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `catalogs/cnmb-2026.xlsx` es el Cuadro Nacional de Medicamentos Básicos que
 * entregó el autor: 890 presentaciones, 528 «Código medicamento». Sustituye al
 * cuadro de desarrollo (`DEV-2026-08`, treinta y tantos principios activos
 * escritos a mano), que se RETIRA, nunca se borra: hay recetas y alergias que
 * apuntan a sus filas por id. Cada medicamento oficial lleva en `replaces` el
 * código de desarrollo que fue, para que esas alergias sigan saltando (PR-114).
 *
 * El cuadro no marca estupefacientes ni psicotrópicos: la marca `controlled`
 * sale de `CONTROLLED_CODES` (D-148), pendiente de un farmacéutico.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL TARIFARIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El Tarifario de Prestaciones del SNS **no fija lo que la clínica cobra a un
 * paciente particular**: su ámbito se redujo en 2017 al relacionamiento dentro
 * de la red pública. Aquí sirve sólo como NOMENCLATURA.
 */

const CNMB_DEFAULTS = {
  file: resolve(import.meta.dirname, 'catalogs/cnmb-2026.xlsx'),
  version: 'cnmb-2026',
  sourceUrl: 'https://www.conasa.gob.ec/biblioteca/',
};

/** Desde cuándo rige el cuadro en una base que no tenía ninguno. */
const CNMB_FIRST_EDITION_FROM = new Date('2026-01-01T00:00:00Z');

export interface CnmbImportOptions {
  file?: string;
  version?: string;
  /** El instante de la importación, para el día de corte. */
  now: Date;
  /** Fuerza el día de corte; si no, el siguiente día clínico a `now`. */
  effectiveFrom?: Date;
}

/**
 * PR-116. Importa el cuadro. Idempotente en (sistema, versión): el mismo
 * archivo otra vez no hace nada; otro bajo la misma versión se rechaza.
 */
export async function importCnmb(
  prisma: PrismaClient,
  options: CnmbImportOptions,
): Promise<{
  status: 'imported' | 'unchanged';
  inserted: number;
  effectiveFrom: Date | null;
}> {
  const file = options.file ?? CNMB_DEFAULTS.file;
  const version = options.version ?? CNMB_DEFAULTS.version;
  const content = readFileSync(file);
  const checksum = createHash('sha256').update(content).digest('hex');
  const [sheet] = readWorkbook(content);
  if (!sheet) throw new Error(`${file} no tiene hojas`);
  const medicines = readCnmb(sheet);

  const cnmb = await prisma.catalogSystem.upsert({
    where: { code: 'CNMB' },
    update: { name: 'Cuadro Nacional de Medicamentos Básicos', hierarchical: false }, // prettier-ignore
    create: { code: 'CNMB', name: 'Cuadro Nacional de Medicamentos Básicos', hierarchical: false }, // prettier-ignore
  });

  const existing = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: cnmb.id, version } },
  });
  if (existing) {
    if (existing.sourceChecksum === checksum)
      return { status: 'unchanged', inserted: 0, effectiveFrom: null };
    throw new Error(
      `La versión ${version} del CNMB ya existe con otro checksum. ` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  const inForce = await prisma.catalogConcept.count({
    where: { systemId: cnmb.id, validTo: null },
  });
  const effectiveFrom =
    options.effectiveFrom ??
    (inForce > 0 ? nextClinicDay(options.now) : CNMB_FIRST_EDITION_FROM);

  const inserted = await prisma.$transaction(
    async (tx) => {
      const release = await tx.catalogRelease.create({
        data: {
          systemId: cnmb.id,
          version,
          publishedOn: effectiveFrom,
          effectiveFrom,
          sourceUrl: CNMB_DEFAULTS.sourceUrl,
          sourceChecksum: checksum,
        },
      });
      // Retirar, no borrar: hay recetas y alergias que apuntan a estas filas.
      await tx.catalogConcept.updateMany({
        where: { systemId: cnmb.id, validTo: null },
        data: { validTo: effectiveFrom, retiredByReleaseId: release.id },
      });
      const created = await tx.catalogConcept.createMany({
        data: medicines.map((medicine) => ({
          systemId: cnmb.id,
          introducedByReleaseId: release.id,
          code: medicine.code,
          display: medicine.display,
          validFrom: effectiveFrom,
          attributes: {
            atc: medicine.atc,
            atcClass: medicine.atcClass,
            // Plain JSON: the interface has no index signature Prisma can see.
            presentations:
              medicine.presentations as unknown as Prisma.InputJsonArray,
            ...(medicine.controlled ? { controlled: true } : {}),
            ...(medicine.replaces.length > 0
              ? { replaces: medicine.replaces }
              : {}),
          },
        })),
      });
      return created.count;
    },
    { timeout: 60_000, maxWait: 30_000 },
  );

  return { status: 'imported', inserted, effectiveFrom };
}

const TARIFF_VERSION = 'DEV-2026-08';
const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00Z');

/**
 * SHA-256 of the fixture as JSON, recorded as the release's `source_checksum`.
 * It is provenance only: whether to seed is decided by the version alone.
 */
function checksumOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Imports the official CNMB and creates the `DEV` release of the tariff,
 * derived from the active `exam_definition` rows (so it needs `seedBilling`
 * first and is skipped when there are none).
 */
export async function seedClinicalCatalogues(
  prisma: PrismaClient,
  now = new Date(),
) {
  const cnmbResult = await importCnmb(prisma, { now });

  // ── Tarifario, derivado de los exámenes que la clínica sabe hacer ───────
  const tariff = await prisma.catalogSystem.upsert({
    where: { code: 'TARIFF' },
    update: { name: 'Tarifario de prestaciones', hierarchical: false },
    create: { code: 'TARIFF', name: 'Tarifario de prestaciones', hierarchical: false }, // prettier-ignore
  });

  const exams = await prisma.examDefinition.findMany({
    where: { active: true },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  });

  let tariffCount = 0;
  if (exams.length > 0) {
    const tariffChecksum = checksumOf(exams);
    const existing = await prisma.catalogRelease.findUnique({
      where: { systemId_version: { systemId: tariff.id, version: TARIFF_VERSION } }, // prettier-ignore
    });
    if (!existing) {
      await prisma.$transaction(async (tx) => {
        const release = await tx.catalogRelease.create({
          data: {
            systemId: tariff.id,
            version: TARIFF_VERSION,
            publishedOn: EFFECTIVE_FROM,
            effectiveFrom: EFFECTIVE_FROM,
            sourceUrl: 'derivado de exam_definition',
            sourceChecksum: tariffChecksum,
          },
        });
        await tx.catalogConcept.updateMany({
          where: { systemId: tariff.id, validTo: null },
          data: { validTo: EFFECTIVE_FROM, retiredByReleaseId: release.id },
        });
        const created = await tx.catalogConcept.createMany({
          data: exams.map((exam) => ({
            systemId: tariff.id,
            introducedByReleaseId: release.id,
            code: exam.code,
            display: exam.name,
            validFrom: EFFECTIVE_FROM,
            attributes: { source: 'DEV FIXTURE — derivado de exam_definition' },
          })),
        });
        tariffCount = created.count;
      });
    } else {
      // An exam added to the seed after the release was published (ORD-101's
      // imaging and procedure examples) joins it; the ones already there are
      // left as they are.
      const live = new Set(
        (
          await prisma.catalogConcept.findMany({
            where: { systemId: tariff.id, validTo: null },
            select: { code: true },
          })
        ).map((concept) => concept.code),
      );
      const missing = exams.filter((exam) => !live.has(exam.code));
      if (missing.length > 0) {
        await prisma.catalogConcept.createMany({
          data: missing.map((exam) => ({
            systemId: tariff.id,
            introducedByReleaseId: existing.id,
            code: exam.code,
            display: exam.name,
            validFrom: EFFECTIVE_FROM,
            attributes: { source: 'DEV FIXTURE — derivado de exam_definition' },
          })),
        });
      }
      tariffCount = live.size + missing.length;
    }
  }

  console.log('Catálogos clínicos:');
  console.log(
    cnmbResult.status === 'unchanged'
      ? '  CNMB    sin cambios: la versión ya está importada'
      : `  CNMB    ${String(cnmbResult.inserted).padStart(4)}  vigente desde ${cnmbResult.effectiveFrom!.toISOString().slice(0, 10)}`,
  );
  console.log(`  TARIFF  ${String(tariffCount).padStart(4)}  derivado de exam_definition, sólo como nomenclatura`); // prettier-ignore
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  await seedClinicalCatalogues(prisma);
  await prisma.$disconnect();
}
