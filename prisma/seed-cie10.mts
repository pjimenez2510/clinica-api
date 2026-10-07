import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import {
  chapterOf,
  proposeEquivalents,
  readWhoCie10,
  WHO_CHAPTERS,
  withDot,
} from '../src/modules/catalogs/import/cie10-who.ts';
import { nextClinicDay } from '../src/modules/catalogs/import/cutover.ts';
import { readWorkbook } from '../src/modules/catalogs/import/xlsx.ts';

/**
 * Importa la CIE-10 de la OMS en español, dejando constancia de CUÁL archivo
 * (EN-233, EN-234).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN CATÁLOGO CLÍNICO NO ES UNA SEMILLA DE DESARROLLO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un diagnóstico registrado hoy tiene que seguir resolviéndose dentro de diez
 * años con el catálogo de SU época, aunque el código haya cambiado de
 * significado o desaparecido. Por eso no se sobrescriben filas: cada
 * importación es una RELEASE, con su versión, su URL de origen y el SHA-256 del
 * archivo, y la anterior se RETIRA, nunca se borra.
 *
 * El checksum no es ceremonia. Los ministerios republican hojas de cálculo bajo
 * el mismo número de versión, y sin él la única forma de saber qué se cargó es
 * la memoria de quien lo cargó.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `catalogs/cie10-oms-deis-2026-08.xlsx` es la lista tabular de la CIE-10 de
 * la OMS en español del Centro FIC de Chile (DEIS, MINSAL), agosto de 2026: la
 * que usa el RDACAA. Ver `catalogs/README.md`. Sustituye a la lista de
 * desarrollo, que venía de la CIE-10-CM estadounidense.
 *
 * `CIE10_FILE`, `CIE10_VERSION` y `CIE10_SOURCE_URL` cargan otra edición;
 * `CIE10_EFFECTIVE_FROM` (AAAA-MM-DD) fija el día de corte.
 */

const SYSTEM_CODE = 'CIE10';

export const CIE10_DEFAULTS = {
  file: resolve(import.meta.dirname, 'catalogs/cie10-oms-deis-2026-08.xlsx'),
  version: 'oms-deis-2026-08',
  sourceUrl: 'https://deis.minsal.cl/centrofic/',
};

/**
 * Desde cuándo rige la edición en una base que no tenía ninguna.
 *
 * La CIE-10 rige en Ecuador desde mucho antes que este sistema, así que una
 * fecha reciente dejaría sin concepto vigente a cualquier atención anterior.
 */
const FIRST_EDITION_FROM = new Date('2019-01-01T00:00:00Z');

/** Nivel de un capítulo, y el de un código de cuatro caracteres (elegible). */
const CHAPTER_LEVEL = 0;
const CODE_LEVEL = 3;

export interface Cie10ImportOptions {
  file?: string;
  version?: string;
  sourceUrl?: string;
  /** El instante de la importación, para el día de corte. */
  now: Date;
  /** Fuerza el día de corte; si no, el siguiente día clínico a `now`. */
  effectiveFrom?: Date;
}

export interface Cie10ImportResult {
  status: 'imported' | 'unchanged';
  inserted: number;
  effectiveFrom: Date | null;
  /** EN-234. Lo registrado que la edición nueva no trae. */
  missing: { code: string; proposals: string[] }[];
}

/**
 * Importa la edición. Idempotente en (sistema, versión): el mismo archivo otra
 * vez no hace nada; otro archivo bajo la misma versión se rechaza para que lo
 * decida una persona.
 */
export async function importCie10(
  prisma: PrismaClient,
  options: Cie10ImportOptions,
): Promise<Cie10ImportResult> {
  const file = options.file ?? CIE10_DEFAULTS.file;
  const version = options.version ?? CIE10_DEFAULTS.version;
  const sourceUrl = options.sourceUrl ?? CIE10_DEFAULTS.sourceUrl;

  const content = readFileSync(file);
  const checksum = createHash('sha256').update(content).digest('hex');
  const rows = readWhoCie10(readWorkbook(content));
  if (rows.length === 0) throw new Error(`${file} no tiene códigos`);

  const system = await prisma.catalogSystem.upsert({
    where: { code: SYSTEM_CODE },
    // `hierarchical` también al actualizar: de esa bandera depende que un
    // capítulo NO sea elegible como diagnóstico.
    update: { hierarchical: true },
    create: {
      code: SYSTEM_CODE,
      name: 'Clasificación Internacional de Enfermedades, 10.ª revisión',
      canonicalUri: 'http://hl7.org/fhir/sid/icd-10',
      hierarchical: true,
    },
  });

  const existing = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: system.id, version } },
  });
  if (existing) {
    if (existing.sourceChecksum === checksum)
      return { status: 'unchanged', inserted: 0, effectiveFrom: null, missing: [] }; // prettier-ignore
    throw new Error(
      `La versión ${version} ya existe con otro checksum.\n` +
        `  importado: ${existing.sourceChecksum}\n` +
        `  archivo:   ${checksum}\n` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  /**
   * EN-234. LO REGISTRADO QUE LA EDICIÓN NO TRAE, antes de tocar nada. Se lee
   * el código congelado del diagnóstico y el del concepto de cada retirada:
   * son los que alguien buscará mañana en el catálogo.
   */
  const registered = await prisma.$queryRaw<{ code: string }[]>`
    SELECT d.cie10_code AS code FROM encounter_diagnosis d
    UNION
    SELECT c.code FROM encounter_diagnosis_retraction r
      JOIN catalog_concept c ON c.id = r.concept_id
  `;
  const missing = proposeEquivalents(
    registered.map((row) => row.code),
    new Set(rows.map((row) => withDot(row.code))),
  );

  const inForce = await prisma.catalogConcept.count({
    where: { systemId: system.id, validTo: null },
  });
  /**
   * EL DÍA DE CORTE. Con una edición vigente, la nueva rige desde el día
   * clínico siguiente (ver `nextClinicDay`); sin ninguna, desde siempre.
   */
  const effectiveFrom =
    options.effectiveFrom ??
    (inForce > 0 ? nextClinicDay(options.now) : FIRST_EDITION_FROM);

  /**
   * TODO DENTRO DE UNA TRANSACCIÓN: un catálogo a medias que se declara
   * completo es peor que uno vacío, porque un diagnóstico simplemente no
   * aparece y nadie sabe por qué.
   */
  const inserted = await prisma.$transaction(
    async (tx) => {
      const release = await tx.catalogRelease.create({
        data: {
          systemId: system.id,
          version,
          effectiveFrom,
          sourceUrl,
          sourceChecksum: checksum,
        },
      });

      // Retirar, no borrar: hay diagnósticos que apuntan a estas filas por id.
      await tx.catalogConcept.updateMany({
        where: { systemId: system.id, validTo: null },
        data: { validTo: effectiveFrom, retiredByReleaseId: release.id },
      });

      await tx.catalogConcept.createMany({
        data: WHO_CHAPTERS.map((chapter) => ({
          systemId: system.id,
          code: chapter.code,
          display: chapter.display,
          validFrom: effectiveFrom,
          introducedByReleaseId: release.id,
          attributes: { level: CHAPTER_LEVEL, chapter: chapter.code },
        })),
      });
      const chapters = new Map(
        (
          await tx.catalogConcept.findMany({
            where: { introducedByReleaseId: release.id },
            select: { id: true, code: true },
          })
        ).map((concept) => [concept.code, concept.id]),
      );

      const { count } = await tx.catalogConcept.createMany({
        data: rows.map((row) => {
          const chapter = chapterOf(row.code)!;
          return {
            systemId: system.id,
            code: withDot(row.code),
            display: row.display,
            parentId: chapters.get(chapter.code),
            validFrom: effectiveFrom,
            introducedByReleaseId: release.id,
            attributes: {
              level: CODE_LEVEL,
              chapter: chapter.code,
              use: row.use,
            },
          };
        }),
      });
      return count + WHO_CHAPTERS.length;
    },
    { timeout: 180_000, maxWait: 30_000 },
  );

  return { status: 'imported', inserted, effectiveFrom, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const version = process.env.CIE10_VERSION ?? CIE10_DEFAULTS.version;
  const result = await importCie10(prisma, {
    file: process.env.CIE10_FILE,
    version,
    sourceUrl: process.env.CIE10_SOURCE_URL,
    now: new Date(),
    effectiveFrom: process.env.CIE10_EFFECTIVE_FROM
      ? new Date(`${process.env.CIE10_EFFECTIVE_FROM}T00:00:00Z`)
      : undefined,
  });

  if (result.status === 'unchanged') {
    console.log(`La versión ${version} ya está importada y el archivo no ha cambiado.`); // prettier-ignore
  } else {
    console.log(
      `Importada la CIE-10 ${version}: ${result.inserted} conceptos, ` +
        `vigentes desde ${result.effectiveFrom!.toISOString().slice(0, 10)}.`,
    );
  }
  if (result.missing.length > 0) {
    console.log('\nCódigos registrados que esta edición no trae (no se ha tocado ninguno):'); // prettier-ignore
    for (const { code, proposals } of result.missing)
      console.log(`  ${code.padEnd(8)} → ${proposals.join(', ') || 'sin equivalente directo'}`); // prettier-ignore
  }
  await prisma.$disconnect();
}
