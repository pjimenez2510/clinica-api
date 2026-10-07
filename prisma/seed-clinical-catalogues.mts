import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

import { readCnmb } from '../src/modules/catalogs/import/cnmb.ts';
import { nextClinicDay } from '../src/modules/catalogs/import/cutover.ts';
import {
  readTariffCsv,
  tariffConceptsOf,
} from '../src/modules/catalogs/import/tariff-rows.ts';
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
            substances: medicine.substances,
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

const TARIFF_DEFAULTS = {
  file: resolve(import.meta.dirname, 'catalogs/tarifario-sns-2014.csv'),
  version: 'sns-2014',
  sourceUrl:
    'https://www.salud.gob.ec/tarifario-de-prestaciones-para-el-sistema-nacional-de-salud/',
};

/** Desde cuándo rige el tarifario en una base que no tenía ninguno. */
const TARIFF_FIRST_EDITION_FROM = new Date('2014-01-01T00:00:00Z');

export interface TariffImportResult {
  status: 'imported' | 'unchanged';
  inserted: number;
  effectiveFrom: Date | null;
  /** ORD-133. Códigos anteriores que un examen activo nombra: siguen vigentes. */
  kept: { code: string; exams: string[] }[];
}

/**
 * ORD-133. Importa el Tarifario de Prestaciones del SNS 2014 desde el CSV que
 * extrae `scripts/extract-tariff.mts`. La release guarda el SHA-256 del PDF,
 * que es el archivo oficial; el CSV es su lectura reproducible.
 *
 * RETIRA LA EDICIÓN ANTERIOR SALVO LO QUE UN EXAMEN USA. Un examen nombra su
 * prestación por código (`exam_definition.tariff_code`, ORD-004): retirar ese
 * código dejaría de poder pedirse el examen el día de la carga. Se queda
 * vigente, y se informa para que la clínica le ponga el código oficial.
 */
export async function importTariff(
  prisma: PrismaClient,
  options: { file?: string; version?: string; now: Date; effectiveFrom?: Date },
): Promise<TariffImportResult> {
  const file = options.file ?? TARIFF_DEFAULTS.file;
  const version = options.version ?? TARIFF_DEFAULTS.version;
  const { pdfChecksum, rows } = readTariffCsv(readFileSync(file, 'utf8'));
  const concepts = tariffConceptsOf(rows);

  const tariff = await prisma.catalogSystem.upsert({
    where: { code: 'TARIFF' },
    update: { name: 'Tarifario de prestaciones', hierarchical: false },
    create: { code: 'TARIFF', name: 'Tarifario de prestaciones', hierarchical: false }, // prettier-ignore
  });

  const existing = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: tariff.id, version } },
  });
  if (existing) {
    if (existing.sourceChecksum === pdfChecksum)
      return {
        status: 'unchanged',
        inserted: 0,
        effectiveFrom: null,
        kept: [],
      };
    throw new Error(
      `La versión ${version} del tarifario ya existe con otro checksum. ` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  const inForce = await prisma.catalogConcept.findMany({
    where: { systemId: tariff.id, validTo: null },
    select: { code: true },
  });
  const effectiveFrom =
    options.effectiveFrom ??
    (inForce.length > 0
      ? nextClinicDay(options.now)
      : TARIFF_FIRST_EDITION_FROM);

  const official = new Set(concepts.map((concept) => concept.code));
  const exams = await prisma.examDefinition.findMany({
    where: { active: true, tariffCode: { not: null } },
    select: { code: true, tariffCode: true },
  });
  const kept = inForce
    .map((concept) => concept.code)
    .filter((code) => !official.has(code))
    .map((code) => ({
      code,
      exams: exams
        .filter((exam) => exam.tariffCode === code)
        .map((exam) => exam.code),
    }))
    .filter((entry) => entry.exams.length > 0);

  const inserted = await prisma.$transaction(
    async (tx) => {
      const release = await tx.catalogRelease.create({
        data: {
          systemId: tariff.id,
          version,
          publishedOn: TARIFF_FIRST_EDITION_FROM,
          effectiveFrom,
          sourceUrl: TARIFF_DEFAULTS.sourceUrl,
          sourceChecksum: pdfChecksum,
        },
      });
      // Retirar, no borrar: órdenes y procedimientos apuntan a estas filas.
      await tx.catalogConcept.updateMany({
        where: {
          systemId: tariff.id,
          validTo: null,
          code: { notIn: kept.map((entry) => entry.code) },
        },
        data: { validTo: effectiveFrom, retiredByReleaseId: release.id },
      });
      const created = await tx.catalogConcept.createMany({
        data: concepts.map((concept) => ({
          systemId: tariff.id,
          introducedByReleaseId: release.id,
          code: concept.code,
          display: concept.display,
          validFrom: effectiveFrom,
          attributes: {
            ...(concept.description
              ? { description: concept.description }
              : {}),
            section: concept.section,
            columns: concept.columns,
            uvr: concept.values,
            page: concept.page,
            ...(concept.entries.length > 0
              ? { entries: concept.entries as unknown as Prisma.InputJsonArray }
              : {}),
          },
        })),
      });
      return created.count;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  return { status: 'imported', inserted, effectiveFrom, kept };
}

/**
 * Imports the official CNMB and the official tariff. Idempotent: an edition
 * already imported is left as it is.
 */
export async function seedClinicalCatalogues(
  prisma: PrismaClient,
  now = new Date(),
) {
  const cnmbResult = await importCnmb(prisma, { now });
  const tariffResult = await importTariff(prisma, { now });

  const since = (date: Date | null) => date!.toISOString().slice(0, 10);
  console.log('Catálogos clínicos:');
  console.log(
    cnmbResult.status === 'unchanged'
      ? '  CNMB    sin cambios: la versión ya está importada'
      : `  CNMB    ${String(cnmbResult.inserted).padStart(5)}  vigente desde ${since(cnmbResult.effectiveFrom)}`,
  );
  console.log(
    tariffResult.status === 'unchanged'
      ? '  TARIFF  sin cambios: la versión ya está importada'
      : `  TARIFF  ${String(tariffResult.inserted).padStart(5)}  vigente desde ${since(tariffResult.effectiveFrom)}, sólo como nomenclatura`,
  );
  for (const { code, exams } of tariffResult.kept)
    console.log(`  ⚠️  ${code} sigue vigente: lo usa ${exams.join(', ')}. Póngale el código oficial en el catálogo de exámenes.`); // prettier-ignore
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  await seedClinicalCatalogues(prisma);
  await prisma.$disconnect();
}
