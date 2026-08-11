import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Importa la CIE-10 desde un archivo, dejando constancia de CUÁL archivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN CATÁLOGO CLÍNICO NO ES UNA SEMILLA DE DESARROLLO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un diagnóstico registrado hoy tiene que seguir resolviéndose dentro de diez
 * años con el catálogo de SU época, aunque el código haya cambiado de
 * significado o desaparecido. Por eso no se sobrescriben filas: cada
 * importación es una RELEASE, con su versión, su URL de origen y el SHA-256 del
 * archivo.
 *
 * El checksum no es ceremonia. Los ministerios republican hojas de cálculo bajo
 * el mismo número de versión, y sin él la única forma de saber qué se cargó es
 * la memoria de quien lo cargó.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE NIEGA A CORRER CONTRA PRODUCCIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El archivo que trae el repositorio es de DESARROLLO —ver
 * `prisma/catalogs/README.md`—: viene de un raspado, no de la OPS ni del MSP.
 * Es estructuralmente correcto y sirve para construir la búsqueda; no sirve
 * para reportar. Cargarlo en una instalación real produciría diagnósticos que
 * el ministerio rechaza, así que el guion se niega.
 *
 * Para la edición oficial se pasan `CIE10_FILE`, `CIE10_VERSION` y
 * `CIE10_SOURCE_URL` por entorno.
 */

const SYSTEM_CODE = 'CIE10';

const FILE =
  process.env.CIE10_FILE ??
  resolve(import.meta.dirname, 'catalogs/cie10-desarrollo.csv');
const VERSION = process.env.CIE10_VERSION ?? 'desarrollo-2019';
const SOURCE_URL =
  process.env.CIE10_SOURCE_URL ?? 'https://github.com/verasativa/CIE-10';

/**
 * Fecha desde la que rige esta edición.
 *
 * La CIE-10 rige en Ecuador desde mucho antes que este sistema, así que una
 * fecha reciente marcaría como «no vigentes» los diagnósticos de cualquier
 * historia anterior. Se ancla al inicio del año de la edición.
 */
const EFFECTIVE_FROM = new Date(
  `${process.env.CIE10_EFFECTIVE_YEAR ?? '2019'}-01-01T00:00:00Z`,
);

interface FilaCsv {
  code: string;
  code_0: string;
  code_1: string;
  code_2: string;
  code_3: string;
  code_4: string;
  description: string;
  level: string;
}

/**
 * Lector de CSV con comillas, sin dependencias.
 *
 * Las descripciones traen comas dentro de comillas —«Enfermedades de la sangre,
 * y ciertos trastornos…»— así que partir por comas rompe una de cada veinte
 * filas. Se escribe aquí en vez de añadir una dependencia por cien líneas.
 */
function parseCsv(contenido: string): FilaCsv[] {
  const filas: string[][] = [];
  let campo = '';
  let fila: string[] = [];
  let enComillas = false;

  for (let i = 0; i < contenido.length; i += 1) {
    const c = contenido[i]!;

    if (enComillas) {
      if (c === '"') {
        // Dos comillas seguidas dentro de un campo son una comilla literal.
        if (contenido[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else enComillas = false;
      } else campo += c;
      continue;
    }

    if (c === '"') enComillas = true;
    else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n') {
      fila.push(campo.replace(/\r$/, ''));
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  const [cabecera, ...cuerpo] = filas;
  if (!cabecera) throw new Error('El archivo está vacío');

  return cuerpo
    .filter((f) => f.length === cabecera.length)
    .map(
      (f) =>
        Object.fromEntries(
          cabecera.map((k, i) => [k, f[i] ?? '']),
        ) as unknown as FilaCsv,
    );
}

/**
 * Limpia un código antes de compararlo o guardarlo.
 *
 * EL ARCHIVO MEZCLA GUIONES. Siete rangos del capítulo respiratorio aparecen
 * unas veces con guion normal (`J30-J39`) y otras con guion medio tipográfico
 * (`J30–J39`), y además con un espacio al final. Un hijo declaraba como
 * ancestro la variante que no existía, y el importador —correctamente— se negó
 * a insertarlo con la jerarquía rota.
 *
 * Es exactamente el tipo de suciedad que trae un archivo raspado, y la razón de
 * que la verificación previa mirara sólo los capítulos y no lo detectara.
 */
function limpiar(codigo: string): string {
  // \u2010-\u2015 son los guiones tipográficos: medio, largo y variantes.
  return codigo.trim().replace(/[\u2010-\u2015]/g, '-');
}

/**
 * `T230` → `T23.0`, que es como se lee y se escribe un código CIE-10.
 *
 * El punto separa la categoría de tres caracteres de su subdivisión. Guardarlo
 * sin él obligaría a cada pantalla y cada informe a reinsertarlo, y a la
 * primera que se olvide el código sale mal en un documento impreso.
 *
 * Los rangos de capítulo (`A00-B99`) y las categorías de tres no llevan punto.
 */
function conPunto(codigo: string): string {
  const limpio = limpiar(codigo);
  if (limpio.includes('-') || limpio.length <= 3) return limpio;
  return `${limpio.slice(0, 3)}.${limpio.slice(3)}`;
}

/** El ancestro más profundo declarado en la fila, o `null` si es capítulo. */
function padreDe(fila: FilaCsv): string | null {
  const propio = limpiar(fila.code);
  const cadena = [
    fila.code_4,
    fila.code_3,
    fila.code_2,
    fila.code_1,
    fila.code_0,
  ]
    .map(limpiar)
    .filter((c) => c !== '' && c !== propio);
  return cadena[0] ?? null;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && !process.env.CIE10_FILE) {
    throw new Error(
      'El catálogo que trae el repositorio es de DESARROLLO y no sirve para ' +
        'reportar al MSP. Para producción indique CIE10_FILE con la edición ' +
        'oficial. Ver prisma/catalogs/README.md.',
    );
  }

  const contenido = readFileSync(FILE, 'utf8');
  const checksum = createHash('sha256').update(contenido).digest('hex');
  const filas = parseCsv(contenido);

  if (filas.length === 0) throw new Error(`${FILE} no tiene filas`);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const sistema = await prisma.catalogSystem.upsert({
    where: { code: SYSTEM_CODE },
    update: {},
    create: {
      code: SYSTEM_CODE,
      name: 'Clasificación Internacional de Enfermedades, 10.ª revisión',
      canonicalUri: 'http://hl7.org/fhir/sid/icd-10',
      hierarchical: true,
    },
  });

  const yaImportada = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: sistema.id, version: VERSION } },
  });

  if (yaImportada) {
    if (yaImportada.sourceChecksum === checksum) {
      console.log(
        `La versión ${VERSION} ya está importada y el archivo no ha cambiado.`,
      );
      await prisma.$disconnect();
      return;
    }
    /**
     * MISMA VERSIÓN, ARCHIVO DISTINTO. No se sobrescribe en silencio: o el
     * ministerio republicó bajo el mismo número —que pasa— o alguien está
     * cargando otra cosa. Ambas requieren una decisión humana.
     */
    throw new Error(
      `La versión ${VERSION} ya existe con otro checksum.\n` +
        `  importado: ${yaImportada.sourceChecksum}\n` +
        `  archivo:   ${checksum}\n` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  /**
   * TODO DENTRO DE UNA TRANSACCIÓN, y no es precaución de manual.
   *
   * La primera versión creaba la fila de `catalog_release` y después insertaba
   * los conceptos. Al fallar a mitad —el archivo traía guiones inconsistentes—
   * quedaron 230 conceptos de 14 498 y una release que decía estar completa:
   * la siguiente ejecución vio el mismo checksum y no hizo nada. Un catálogo a
   * medias que se declara correcto es peor que uno vacío, porque un diagnóstico
   * simplemente no aparece y nadie sabe por qué.
   *
   * Con la transacción, o entra el catálogo entero o no entra nada.
   *
   * El tiempo límite se sube: catorce mil inserciones no caben en los cinco
   * segundos por defecto de Prisma.
   */
  const insertados = await prisma.$transaction(
    async (tx) => {
      const release = await tx.catalogRelease.create({
        data: {
          systemId: sistema.id,
          version: VERSION,
          effectiveFrom: EFFECTIVE_FROM,
          sourceUrl: SOURCE_URL,
          sourceChecksum: checksum,
        },
      });

      /**
       * Por NIVELES, de capítulo hacia abajo.
       *
       * `parent_id` apunta a una fila que tiene que existir ya. Insertar en el
       * orden del archivo funcionaría por casualidad —viene ordenado— y fallaría
       * el día que el ministerio publique el suyo en otro orden.
       */
      const porNivel = new Map<number, FilaCsv[]>();
      for (const fila of filas) {
        const nivel = Number(fila.level);
        porNivel.set(nivel, [...(porNivel.get(nivel) ?? []), fila]);
      }

      const idPorCodigo = new Map<string, string>();
      let total = 0;

      for (const nivel of [...porNivel.keys()].sort((a, b) => a - b)) {
        const lote = porNivel.get(nivel)!;

        const datos = lote.map((fila) => {
          const padre = padreDe(fila);
          const parentId = padre ? idPorCodigo.get(padre) : undefined;

          if (padre && !parentId) {
            throw new Error(
              `${fila.code} declara el ancestro ${padre}, que no se ha insertado. ` +
                'El archivo tiene una jerarquía rota.',
            );
          }

          return {
            systemId: sistema.id,
            code: conPunto(fila.code),
            display: fila.description.trim(),
            parentId,
            validFrom: EFFECTIVE_FROM,
            introducedByReleaseId: release.id,
            // El nivel se conserva: distingue un capítulo de una categoría sin
            // tener que recorrer la jerarquía hacia arriba para averiguarlo.
            attributes: { level: nivel, chapter: fila.code_0 || fila.code },
          };
        });

        await tx.catalogConcept.createMany({ data: datos });

        // Se releen los ids en lugar de suponerlos: `createMany` no los
        // devuelve.
        const creados = await tx.catalogConcept.findMany({
          where: {
            systemId: sistema.id,
            code: { in: datos.map((d) => d.code) },
          },
          select: { id: true, code: true },
        });
        for (const c of creados) idPorCodigo.set(c.code.replace('.', ''), c.id);

        total += datos.length;
        console.log(`  nivel ${nivel}: ${datos.length} conceptos`);
      }

      return total;
    },
    { timeout: 180_000, maxWait: 30_000 },
  );

  console.log(
    `Importada la CIE-10 ${VERSION}: ${insertados} conceptos.\n` +
      `  origen:   ${SOURCE_URL}\n` +
      `  sha-256:  ${checksum}`,
  );

  if (VERSION.startsWith('desarrollo')) {
    console.log(
      '\n  ⚠️  Catálogo de DESARROLLO. No sirve para reportar al MSP.\n' +
        '      Ver prisma/catalogs/README.md.',
    );
  }

  await prisma.$disconnect();
}

await main();
