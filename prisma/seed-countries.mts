import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Importa la lista de países: código `ISO 3166-1 alpha-3` y nombre en español.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ HACE FALTA: NADIE EN EL MOSTRADOR SABE QUE VENEZUELA ES «VEN»
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patient_identifier.issuing_country` es alpha-3 y lo seguirá siendo: es el
 * código que viaja al RDACAA y a cualquier interoperación. Lo que no puede ser
 * alpha-3 es la PREGUNTA. El formulario de alta pedía «país emisor: código de
 * tres letras: ECU, COL, VEN», y esta clínica atiende a diario a pacientes
 * venezolanos, colombianos y peruanos con pasaporte en la mano.
 *
 * Pedirle a recepción el ISO de un pasaporte tiene dos desenlaces y los dos son
 * malos: se lo inventa —`VZL`, `PER` por `PRI`— o registra a la persona como
 * PROVISIONAL para poder seguir atendiendo. Ese segundo es exactamente el
 * duplicado que PA-015 existe para evitar: la misma persona vuelve el mes
 * siguiente, nadie encuentra la ficha anterior porque el documento no está, y
 * la historia clínica queda partida en dos.
 *
 * Con este catálogo la pantalla ofrece «Venezuela (República Bolivariana de)» y
 * guarda `VEN`. El dato almacenado no cambia; cambia quién tiene que saberse el
 * código, que pasa a ser nadie.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DE DÓNDE SALEN LOS NOMBRES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Del UNTERM, la base terminológica del Servicio de Protocolo y Enlace de las
 * Naciones Unidas, y donde falta, del nombre oficial en español de la
 * clasificación M49 de la División de Estadística de la ONU. Y no de una
 * traducción cualquiera: es la misma familia de fuentes de la que sale el
 * alpha-3, así que código y nombre se refieren con seguridad al mismo país.
 *
 * ⚠️ SE QUITA EL ARTÍCULO PROTOCOLARIO ENTRE PARÉNTESIS, Y SÓLO ÉSE.
 * «Ecuador (el)» se guarda «Ecuador», porque ese paréntesis es gramática de
 * documento diplomático y en un desplegable ordenado por nombre sólo estorba.
 * «Venezuela (República Bolivariana de)» se queda entero: eso NO es un
 * artículo, es el nombre del país, y recortarlo sería inventarse otro.
 *
 * Misma disciplina que el DPA y la CIE-10: cada importación es una RELEASE con
 * su versión, su URL de origen y el SHA-256 del archivo. La ONU reorganiza la
 * lista —países que se renombran, que se dividen— y una ficha de hace tres años
 * tiene que seguir resolviendo el país con el que se registró.
 *
 * CATÁLOGO PLANO: `hierarchical` en `false`. Un país no cuelga de nada, y de
 * esa bandera depende que sus conceptos sean seleccionables — ver `toConcept`
 * en `prisma-catalog.repository.ts`. Con `true`, los 249 saldrían marcados como
 * títulos de navegación y el selector aparecería vacío.
 */

const SYSTEM_CODE = 'COUNTRY';

const FILE =
  process.env.COUNTRY_FILE ?? resolve(import.meta.dirname, 'paises/paises.csv');
const VERSION = process.env.COUNTRY_VERSION ?? 'un-m49-2024';
const SOURCE_URL =
  process.env.COUNTRY_SOURCE_URL ??
  'https://unstats.un.org/unsd/methodology/m49/';

/**
 * Fecha desde la que rige esta edición.
 *
 * Anclada al inicio del año y no a hoy, por el mismo motivo que el DPA: una
 * fecha reciente marcaría como «no vigente» el país de cualquier documento
 * registrado antes, y el catálogo se consulta con la fecha del registro.
 */
const EFFECTIVE_FROM = new Date(
  `${process.env.COUNTRY_EFFECTIVE_YEAR ?? '2024'}-01-01T00:00:00Z`,
);

/** One data line of the file: the ISO alpha-3 code and the Spanish name, exactly as written there. */
interface Pais {
  alpha3: string;
  nombre: string;
}

/**
 * Lee el CSV `alpha3;nombre`.
 *
 * SEPARADOR `;` Y SIN COMILLAS, igual que el archivo del INEC. Los nombres
 * llevan paréntesis y comas —«Venezuela (República Bolivariana de)», «Corea,
 * República de»— pero ninguna comilla ni ningún punto y coma, así que partir
 * por el separador es correcto. Si alguna vez apareciera uno, la comprobación
 * de forma rechazaría la fila en vez de partirla mal.
 *
 * El BOM se quita por si el archivo se reexporta desde una hoja de cálculo:
 * sin quitarlo el primer país se llamaría `﻿AFG` y no encontraría su código.
 */
function leer(contenido: string): { paises: Pais[]; descartadas: string[] } {
  const lineas = contenido
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const paises: Pais[] = [];
  const descartadas: string[] = [];

  // Se salta la cabecera por posición; cualquier otra línea sin forma de dato
  // se descarta y se dice, en vez de producir un concepto con código vacío.
  for (const linea of lineas.slice(1)) {
    const c = linea.split(';').map((v) => v.trim());

    const tieneForma =
      c.length === 2 && /^[A-Z]{3}$/.test(c[0] ?? '') && (c[1] ?? '') !== '';

    if (!tieneForma) {
      descartadas.push(linea);
      continue;
    }

    paises.push({ alpha3: c[0]!, nombre: c[1]! });
  }

  return { paises, descartadas };
}

/**
 * Deja el catálogo de países en la base, sobre el cliente que se le dé.
 *
 * EXPORTADA para que `seed.mts` la llame: sin países sembrados el selector del
 * alta aparece vacío en cada base recién creada, y eso parece un fallo de la
 * pantalla en vez de una siembra que falta. Es idempotente —la release con su
 * checksum es la que decide— así que llamarla desde el seed de desarrollo no
 * duplica nada.
 */
export async function seedCountries(prisma: PrismaClient): Promise<void> {
  const contenido = readFileSync(FILE, 'utf8');
  const checksum = createHash('sha256').update(contenido).digest('hex');
  const { paises, descartadas } = leer(contenido);

  if (paises.length === 0) throw new Error(`${FILE} no tiene filas de datos`);

  const sistema = await prisma.catalogSystem.upsert({
    where: { code: SYSTEM_CODE },
    /**
     * `hierarchical` SE FIJA TAMBIÉN AL ACTUALIZAR. La columna es
     * `@default(false)`, así que aquí el valor coincide con el que la base
     * pondría sola — pero escribirlo es lo que impide que una fila `COUNTRY`
     * creada a mano en `true` deje el catálogo entero como no seleccionable, y
     * es la misma disciplina que el DPA necesita en el otro sentido. Un
     * `update: {}` convierte esa bandera en algo que sólo se puede corregir a
     * mano y que nadie mira.
     */
    update: { hierarchical: false },
    create: {
      code: SYSTEM_CODE,
      name: 'Países (ISO 3166-1 alpha-3)',
      hierarchical: false,
    },
  });

  const yaImportada = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: sistema.id, version: VERSION } },
  });

  if (yaImportada) {
    if (yaImportada.sourceChecksum === checksum) return;

    // Misma versión, archivo distinto: o la ONU republicó, o alguien está
    // cargando otra cosa. Las dos piden una decisión humana.
    throw new Error(
      `La versión ${VERSION} ya existe con otro checksum.\n` +
        `  importado: ${yaImportada.sourceChecksum}\n` +
        `  archivo:   ${checksum}\n` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  // Todo dentro de una transacción: una lista a medias que se declara completa
  // deja países que simplemente no aparecen, y la siguiente ejecución ve el
  // mismo checksum y no hace nada. Ya pasó con la CIE-10.
  await prisma.$transaction(async (tx) => {
    const release = await tx.catalogRelease.create({
      data: {
        systemId: sistema.id,
        version: VERSION,
        effectiveFrom: EFFECTIVE_FROM,
        sourceUrl: SOURCE_URL,
        sourceChecksum: checksum,
      },
    });

    await tx.catalogConcept.createMany({
      data: paises.map((pais) => ({
        systemId: sistema.id,
        code: pais.alpha3,
        display: pais.nombre,
        validFrom: EFFECTIVE_FROM,
        introducedByReleaseId: release.id,
        // Sin `parent_id` y sin `chapter`: una lista plana no tiene ni padre ni
        // agrupador. `level` 0 es lo que hay, y en un catálogo no jerárquico es
        // exactamente el nivel que se elige.
        attributes: { level: 0 },
      })),
    });
  });

  if (descartadas.length > 0) {
    console.log(
      `  ${descartadas.length} línea(s) sin forma de dato, descartadas:`,
    );
    for (const d of descartadas) console.log(`    ${d.slice(0, 70)}`);
  }

  console.log(
    `Importados ${paises.length} países (${VERSION}).\n` +
      `  origen:   ${SOURCE_URL} (nombres del UNTERM y de la M49)\n` +
      `  sha-256:  ${checksum}`,
  );
}

/**
 * Entry point of `pnpm db:seed:countries`. Reference data, not demo data, so
 * there is no production guard; idempotency is `seedCountries`'s.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    await seedCountries(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Sólo cuando se invoca directamente, para que importar `seedCountries` desde
// `seed.mts` o desde una prueba no siembre la base al cargar el módulo.
if (process.argv[1]?.endsWith('seed-countries.mts')) {
  await main();
}
