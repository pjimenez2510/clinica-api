import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Importa la División Política Administrativa del INEC: provincia, cantón y
 * parroquia.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ HACE FALTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El RDACAA exige la residencia del paciente por PARROQUIA (REQ-022), y OR-004
 * pide la parroquia de cada sede. Las dos pantallas existían y no tenían de
 * dónde tirar: `catalogSystemSchema` admitía `DPA`, el combobox se montaba
 * contra él, y la tabla estaba vacía.
 *
 * Misma disciplina que la CIE-10 y por el mismo motivo: cada importación es
 * una RELEASE con su versión, su origen y el SHA-256 del archivo. El INEC
 * reorganiza parroquias —fusiones, cambios de nombre—, y una ficha de hace
 * tres años tiene que seguir resolviendo la parroquia con la que se registró.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA JERARQUÍA SALE DEL CÓDIGO, NO DE LAS COLUMNAS. Y ESO NO ES UNA PREFERENCIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-003 §113 asumió que los códigos del DPA son jerárquicos por prefijo
 * —provincia = 2 dígitos, cantón = 4, parroquia = 6— y lo dejó anotado como
 * **no verificado** contra el catálogo vigente. Este archivo lo verifica, y de
 * la peor manera posible para las columnas: hay DOS filas donde el código y la
 * columna del cantón se contradicen.
 *
 *     09;GUAYAS;0906;DAULE;090701;ELOY ALFARO (DURAN)
 *     09;GUAYAS;0906;DAULE;090702;EL RECREO
 *
 * Esas dos parroquias son de Durán —cantón `0907`, que existe en el archivo con
 * su nombre— y la columna dice Daule. Si la jerarquía se construyera leyendo la
 * columna, dos parroquias de Durán acabarían colgando de Daule, y la
 * residencia de un paciente saldría reportada al ministerio en el cantón
 * equivocado sin que nada fallara: las dos filas son perfectamente válidas.
 *
 * Así que el prefijo manda y las columnas descriptivas solo aportan el NOMBRE.
 * Las discrepancias se cuentan y se dicen al terminar, en vez de corregirse en
 * silencio: es información sobre la calidad del archivo, y quien lo cargue
 * tiene que verla.
 */

const SYSTEM_CODE = 'DPA';

const FILE =
  process.env.DPA_FILE ??
  resolve(import.meta.dirname, 'parroquias/parroquias.csv');
const VERSION = process.env.DPA_VERSION ?? 'inec-2024';
const SOURCE_URL =
  process.env.DPA_SOURCE_URL ??
  'https://www.ecuadorencifras.gob.ec/clasificador-geografico-estadistico-dpa/';

/**
 * Fecha desde la que rige esta edición.
 *
 * Se ancla al inicio del año, no a hoy: una fecha reciente marcaría como «no
 * vigentes» las parroquias de cualquier ficha anterior, y el catálogo se
 * consulta con la fecha del registro.
 */
const EFFECTIVE_FROM = new Date(
  `${process.env.DPA_EFFECTIVE_YEAR ?? '2024'}-01-01T00:00:00Z`,
);

/** Provincia, cantón, parroquia. Es lo que el RDACAA nombra. */
const NIVEL = { provincia: 0, canton: 1, parroquia: 2 } as const;

interface Fila {
  provinciaCodigo: string;
  provinciaNombre: string;
  cantonCodigo: string;
  cantonNombre: string;
  parroquiaCodigo: string;
  parroquiaNombre: string;
}

/**
 * Lee el CSV del INEC.
 *
 * SEPARADOR `;` Y SIN COMILLAS —comprobado sobre el archivo: no contiene una
 * sola—, así que partir por el separador es correcto y no hace falta el lector
 * con estado que sí necesita la CIE-10. Si algún día apareciera una comilla,
 * la comprobación de forma de abajo rechazaría la fila en vez de partirla mal.
 *
 * EL BOM SE QUITA. El archivo viene con marca de orden de bytes, y sin
 * quitarla el primer encabezado se llama `﻿CODIGO PROVINCIA` y la primera
 * columna no se encuentra por su nombre.
 */
function leer(contenido: string): { filas: Fila[]; descartadas: string[] } {
  const lineas = contenido
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const filas: Fila[] = [];
  const descartadas: string[] = [];

  // Se salta la cabecera por posición, pero cualquier OTRA línea que no tenga
  // forma de dato se descarta y se dice: este archivo trae una cabecera
  // repetida a mitad y un título de sección suelto («24  PROVINCIA DE SANTA
  // ELENA»). Aceptarlas produciría conceptos con código vacío.
  for (const linea of lineas.slice(1)) {
    const c = linea.split(';').map((v) => v.trim());

    const tieneForma =
      c.length === 6 &&
      /^\d{2}$/.test(c[0] ?? '') &&
      /^\d{4}$/.test(c[2] ?? '') &&
      /^\d{6}$/.test(c[4] ?? '') &&
      (c[5] ?? '') !== '';

    if (!tieneForma) {
      descartadas.push(linea);
      continue;
    }

    filas.push({
      provinciaCodigo: c[0]!,
      provinciaNombre: c[1]!,
      cantonCodigo: c[2]!,
      cantonNombre: c[3]!,
      parroquiaCodigo: c[4]!,
      parroquiaNombre: c[5]!,
    });
  }

  return { filas, descartadas };
}

interface Concepto {
  codigo: string;
  nombre: string;
  nivel: number;
  padre: string | null;
}

/**
 * Construye los tres niveles A PARTIR DEL CÓDIGO de la parroquia.
 *
 * El nombre de cada provincia y cada cantón se toma de las filas donde el
 * código y la columna COINCIDEN. Una fila incoherente aporta su parroquia
 * —cuyo código sí es fiable— y no aporta el nombre de un cantón que no es el
 * suyo.
 */
function construir(filas: Fila[]): {
  conceptos: Concepto[];
  incoherentes: Fila[];
} {
  const nombreProvincia = new Map<string, string>();
  const nombreCanton = new Map<string, string>();
  const incoherentes: Fila[] = [];

  for (const fila of filas) {
    if (fila.parroquiaCodigo.startsWith(fila.cantonCodigo)) {
      nombreCanton.set(fila.cantonCodigo, fila.cantonNombre);
    } else {
      incoherentes.push(fila);
    }
    if (fila.cantonCodigo.startsWith(fila.provinciaCodigo)) {
      nombreProvincia.set(fila.provinciaCodigo, fila.provinciaNombre);
    }
  }

  const conceptos: Concepto[] = [];
  const vistos = new Set<string>();

  const añadir = (c: Concepto): void => {
    if (vistos.has(c.codigo)) return;
    vistos.add(c.codigo);
    conceptos.push(c);
  };

  for (const fila of filas) {
    const provincia = fila.parroquiaCodigo.slice(0, 2);
    const canton = fila.parroquiaCodigo.slice(0, 4);

    const nombreP = nombreProvincia.get(provincia);
    const nombreC = nombreCanton.get(canton);

    // Sin nombre no se inventa uno: un cantón llamado «0907» en la pantalla de
    // una sede es peor que una importación que se niega a correr.
    if (!nombreP) {
      throw new Error(
        `La provincia ${provincia} no tiene nombre en ninguna fila coherente ` +
          `(la reclama la parroquia ${fila.parroquiaCodigo}).`,
      );
    }
    if (!nombreC) {
      throw new Error(
        `El cantón ${canton} no tiene nombre en ninguna fila coherente ` +
          `(la reclama la parroquia ${fila.parroquiaCodigo}).`,
      );
    }

    añadir({
      codigo: provincia,
      nombre: nombreP,
      nivel: NIVEL.provincia,
      padre: null,
    });
    añadir({
      codigo: canton,
      nombre: nombreC,
      nivel: NIVEL.canton,
      padre: provincia,
    });
    añadir({
      codigo: fila.parroquiaCodigo,
      nombre: fila.parroquiaNombre,
      nivel: NIVEL.parroquia,
      padre: canton,
    });
  }

  return { conceptos, incoherentes };
}

async function main(): Promise<void> {
  const contenido = readFileSync(FILE, 'utf8');
  const checksum = createHash('sha256').update(contenido).digest('hex');
  const { filas, descartadas } = leer(contenido);

  if (filas.length === 0) throw new Error(`${FILE} no tiene filas de datos`);

  const { conceptos, incoherentes } = construir(filas);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const sistema = await prisma.catalogSystem.upsert({
    where: { code: SYSTEM_CODE },
    update: {},
    create: {
      code: SYSTEM_CODE,
      name: 'División Política Administrativa del Ecuador (INEC)',
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
    // Misma versión, archivo distinto: o el INEC republicó, o alguien está
    // cargando otra cosa. Las dos piden una decisión humana.
    throw new Error(
      `La versión ${VERSION} ya existe con otro checksum.\n` +
        `  importado: ${yaImportada.sourceChecksum}\n` +
        `  archivo:   ${checksum}\n` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  // Todo dentro de una transacción: un DPA a medias que se declara completo
  // deja parroquias que simplemente no aparecen, y la siguiente ejecución ve
  // el mismo checksum y no hace nada. Ya pasó con la CIE-10.
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

      const idPorCodigo = new Map<string, string>();
      let total = 0;

      // Por niveles: `parent_id` apunta a una fila que ya tiene que existir.
      for (const nivel of [NIVEL.provincia, NIVEL.canton, NIVEL.parroquia]) {
        const lote = conceptos.filter((c) => c.nivel === nivel);

        const datos = lote.map((c) => ({
          systemId: sistema.id,
          code: c.codigo,
          display: c.nombre,
          parentId: c.padre ? idPorCodigo.get(c.padre) : undefined,
          validFrom: EFFECTIVE_FROM,
          introducedByReleaseId: release.id,
          /**
           * `level` es lo que hace que el combobox ofrezca SOLO parroquias:
           * el repositorio marca `selectable` a partir del nivel 2. Una
           * provincia no es una residencia.
           *
           * `chapter` lleva el código de provincia, que es el agrupador que
           * desambigua dos parroquias con el mismo nombre en el listado —y
           * las hay.
           */
          attributes: { level: nivel, chapter: c.codigo.slice(0, 2) },
        }));

        await tx.catalogConcept.createMany({ data: datos });

        // Se releen: `createMany` no devuelve los ids.
        const creados = await tx.catalogConcept.findMany({
          where: {
            systemId: sistema.id,
            code: { in: datos.map((d) => d.code) },
          },
          select: { id: true, code: true },
        });
        for (const c of creados) idPorCodigo.set(c.code, c.id);

        total += datos.length;
        const etiqueta = ['provincias', 'cantones', 'parroquias'][nivel];
        console.log(`  ${etiqueta}: ${datos.length}`);
      }

      return total;
    },
    { timeout: 180_000, maxWait: 30_000 },
  );

  console.log(
    `Importado el DPA ${VERSION}: ${insertados} conceptos.\n` +
      `  origen:   ${SOURCE_URL}\n` +
      `  sha-256:  ${checksum}`,
  );

  if (descartadas.length > 0) {
    console.log(
      `\n  ${descartadas.length} línea(s) sin forma de dato, descartadas:`,
    );
    for (const d of descartadas) console.log(`    ${d.slice(0, 70)}`);
  }

  if (incoherentes.length > 0) {
    console.log(
      `\n  ⚠️  ${incoherentes.length} fila(s) con la columna del cantón en ` +
        'desacuerdo con el código. Manda el código (ADR-003):',
    );
    for (const f of incoherentes) {
      console.log(
        `    ${f.parroquiaCodigo} ${f.parroquiaNombre} → cantón ` +
          `${f.parroquiaCodigo.slice(0, 4)}, no ${f.cantonCodigo} ${f.cantonNombre}`,
      );
    }
  }

  await prisma.$disconnect();
}

await main();
