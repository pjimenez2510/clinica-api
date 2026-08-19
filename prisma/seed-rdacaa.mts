import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Importa los tres catálogos PLANOS que la ficha del RDACAA necesita:
 * autoidentificación étnica, nacionalidad o pueblo indígena e identidad de
 * género.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS TRES EN UN SOLO SEMBRADOR, PORQUE SON LA MISMA COSA TRES VECES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Misma forma —`codigo;nombre`, sin padres, sin capítulos—, misma disciplina
 * que el DPA, la CIE-10 y los países —una `catalog_release` por sistema con su
 * versión, su origen y el SHA-256 del archivo— y la misma fuente documental: el
 * formulario del RDACAA y lo que el MSP y el INEC publican sobre él. Tres
 * archivos casi idénticos sólo habrían multiplicado por tres el sitio donde
 * corregir el día que aparezca el instructivo oficial.
 *
 * El mecanismo ya estaba hecho desde P2 de `patients`: `catalogSystemSchema`
 * admite los tres códigos y la ficha sabe guardar la referencia. Lo único que
 * faltaba eran las FILAS, y sin ellas el selector de la pantalla salía vacío
 * —con un 200, que es la forma cara de romperse— igual que le pasaba al de
 * parroquia antes del 13-08-2026.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DE DÓNDE SALE CADA LISTA (D-036, resuelta el 17-08-2026)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Etnia** — las ocho categorías de la pregunta 11 del cuestionario del VIII
 * Censo de Población y VII de Vivienda 2022 del INEC:
 * `https://www.ecuadorencifras.gob.ec/documentos/web-inec/CPV_2022/Doc/Cuestionario%20censal%202022.pdf`
 *
 * **Nacionalidad** — la variable `P12`, «nacionalidad o pueblo indígena», del
 * mismo censo, tal como el INEC la publica en su catálogo de microdatos ANDA:
 * `https://anda.inec.gob.ec/anda5/index.php/catalog/1085`
 *
 * **Identidad de género** — los términos que define el *Manual de atención
 * integral en salud a personas de las diversidades sexo-genéricas* del MSP
 * (Acuerdo Ministerial 00085-2024), publicado en el **Registro Oficial Nº 579
 * del 14 de junio de 2024**, § 6.1.7 y su glosario.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ LA ETNIA SON OCHO Y NO LAS SEIS QUE EL INEC PUBLICA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El INEC agrupa afroecuatoriano, negro y mulato en una sola categoría **al
 * publicar** los resultados, pero el formulario pregunta por las ocho y el
 * RDACAA las separa. Se siembran las ocho por el mismo argumento que PA-005
 * escribe para el sexo: **agrupar es trabajo de la capa de exportación, no del
 * registro**. De ocho siempre se pueden sacar seis; de seis no se pueden sacar
 * ocho, y lo que se perdió no se puede volver a preguntar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ «NACIONALIDAD» AQUÍ NO ES EL PAÍS. QUIEN LEA ESTO DENTRO DE UN AÑO: NO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En el RDACAA ese campo **se activa sólo cuando la autoidentificación étnica
 * es «Indígena»** y recoge la nacionalidad o pueblo indígena —Kichwa, Shuar,
 * Awa…—. El país de un paciente extranjero es otra cosa, hoy **no tiene
 * columna**, y está registrado como decisión pendiente (D-036, opción C). Sin
 * esta advertencia, la primera persona que necesite anotar que alguien es
 * venezolano rellenará esta tabla con países, y el reporte mensual saldrá mal
 * sin que nada falle. El país emisor de un documento sí tiene catálogo propio:
 * `COUNTRY`, ver `seed-countries.mts`.
 *
 * SE CONSERVAN LOS CÓDIGOS DEL INEC CON SUS SALTOS —del 14 al 21, sin 37—
 * porque son los suyos: renumerarlos para que quedaran seguidos rompería la
 * comparación con cualquier fuente oficial. Y se excluye a propósito el código
 * `99 Se ignora`: es un resultado de la recolección, no algo que se le ofrezca
 * a nadie para elegir — que el campo quede vacío ya dice eso.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LAS TRES LISTAS SON PROVISIONALES, Y POR ESO CADA UNA ES UNA RELEASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La lista que manda es la del **instructivo del RDACAA 2.0** —el propio MSP
 * remite a él: «utilizando las definiciones que constan en esas herramientas»—
 * y no se ha podido obtener de fuente oficial. El usuario dio permiso expreso
 * (17-08-2026) para sembrar con la lista del INEC y corregir cuando aparezca el
 * documento.
 *
 * Por eso cada sistema entra como `catalog_release` con versión y checksum:
 * **sustituir una lista es cargar otra release, no editar filas a mano**, y una
 * ficha registrada hoy seguirá resolviendo la categoría con la que se registró
 * —que es lo que separa un catálogo clínico de una semilla de desarrollo—.
 *
 * CATÁLOGOS PLANOS: `hierarchical` en `false`. Ninguno cuelga de nada, y de esa
 * bandera depende que sus conceptos sean elegibles — ver `toConcept` en
 * `prisma-catalog.repository.ts`. Con `true`, los tres saldrían marcados como
 * títulos de navegación y los tres selectores aparecerían vacíos.
 */

/** Un catálogo plano y de dónde sale. Lo único que cambia entre los tres. */
interface CatalogoPlano {
  systemCode: string;
  nombre: string;
  archivo: string;
  version: string;
  sourceUrl: string;
  /**
   * La fecha del documento que publica la lista, cuando se conoce con
   * precisión. Del censo se conoce el año, no el día, y una fecha inventada
   * sería peor que ninguna.
   */
  publishedOn: Date | null;
  /**
   * Desde cuándo rige, ANCLADA AL INICIO DEL AÑO como el DPA y los países: una
   * fecha reciente marcaría como «no vigente» la categoría de cualquier ficha
   * registrada antes, y el catálogo se consulta con la fecha del registro.
   */
  effectiveFrom: Date;
}

/**
 * Los tres, con sus valores por defecto.
 *
 * Cada uno admite `<SISTEMA>_FILE`, `<SISTEMA>_VERSION` y
 * `<SISTEMA>_SOURCE_URL` por entorno, que es como se cargará el instructivo
 * oficial del RDACAA 2.0 el día que se consiga: otra release, sin tocar código.
 */
const CATALOGOS: readonly CatalogoPlano[] = [
  {
    systemCode: 'ETHNICITY',
    nombre: 'Autoidentificación étnica (RDACAA)',
    archivo: 'rdacaa/etnias.csv',
    version: 'inec-cpv-2022',
    sourceUrl:
      'https://www.ecuadorencifras.gob.ec/documentos/web-inec/CPV_2022/Doc/Cuestionario%20censal%202022.pdf',
    publishedOn: null,
    effectiveFrom: new Date('2022-01-01T00:00:00Z'),
  },
  {
    systemCode: 'NATIONALITY',
    nombre: 'Nacionalidad o pueblo indígena (RDACAA)',
    archivo: 'rdacaa/nacionalidades-indigenas.csv',
    version: 'inec-cpv-2022',
    sourceUrl: 'https://anda.inec.gob.ec/anda5/index.php/catalog/1085',
    publishedOn: null,
    effectiveFrom: new Date('2022-01-01T00:00:00Z'),
  },
  {
    systemCode: 'GENDER_IDENTITY',
    nombre: 'Identidad de género (MSP)',
    archivo: 'rdacaa/identidades-genero.csv',
    version: 'msp-ro-579-2024',
    /**
     * La página del MSP que anuncia el manual, y no un enlace al PDF: el
     * documento no está publicado en una URL oficial estable. La cita canónica
     * de la norma es el Acuerdo Ministerial 00085-2024, Registro Oficial Nº 579
     * del 14-06-2024, y eso es lo que va en `publishedOn`.
     */
    sourceUrl:
      'https://www.salud.gob.ec/msp-presento-el-manual-buenas-practicas-en-la-atencion-integral-de-salud-a-personas-de-las-diversidades-sexo-genericas-lgbtiq/',
    publishedOn: new Date('2024-06-14T00:00:00Z'),
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
  },
];

interface Concepto {
  codigo: string;
  nombre: string;
}

/**
 * Lee un CSV `codigo;nombre` con cabecera.
 *
 * SEPARADOR `;` Y SIN COMILLAS, como los archivos del INEC. Los nombres llevan
 * barras y apóstrofos —«Afroecuatoriano/a», «A'i cofan»— pero ningún punto y
 * coma, así que partir por el separador es correcto; si algún día apareciera
 * uno, la comprobación de forma rechaza la fila en vez de partirla mal.
 *
 * EL CÓDIGO SE GUARDA TAL CUAL, con su cero a la izquierda: `01` es el código
 * del INEC para Awa, y `1` sería otro. Por eso la comprobación es de forma y no
 * un `Number`.
 *
 * El BOM se quita por si el archivo se reexporta desde una hoja de cálculo: sin
 * quitarlo la primera fila tendría un código que no encuentra nadie.
 */
function leer(contenido: string): {
  conceptos: Concepto[];
  descartadas: string[];
} {
  const lineas = contenido
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const conceptos: Concepto[] = [];
  const descartadas: string[] = [];

  // Se salta la cabecera por posición; cualquier otra línea sin forma de dato
  // se descarta y se dice, en vez de producir un concepto con código vacío.
  for (const linea of lineas.slice(1)) {
    const c = linea.split(';').map((v) => v.trim());

    const tieneForma =
      c.length === 2 && /^\d{1,2}$/.test(c[0] ?? '') && (c[1] ?? '') !== '';

    if (!tieneForma) {
      descartadas.push(linea);
      continue;
    }

    conceptos.push({ codigo: c[0]!, nombre: c[1]! });
  }

  return { conceptos, descartadas };
}

/** Lo que el entorno puede cambiar de un catálogo, sin tocar el código. */
function conEntorno(catalogo: CatalogoPlano): CatalogoPlano {
  const env = process.env;
  return {
    ...catalogo,
    archivo: env[`${catalogo.systemCode}_FILE`] ?? catalogo.archivo,
    version: env[`${catalogo.systemCode}_VERSION`] ?? catalogo.version,
    sourceUrl: env[`${catalogo.systemCode}_SOURCE_URL`] ?? catalogo.sourceUrl,
  };
}

async function sembrarUno(
  prisma: PrismaClient,
  definicion: CatalogoPlano,
): Promise<void> {
  const catalogo = conEntorno(definicion);
  const ruta = resolve(import.meta.dirname, catalogo.archivo);

  const contenido = readFileSync(ruta, 'utf8');
  const checksum = createHash('sha256').update(contenido).digest('hex');
  const { conceptos, descartadas } = leer(contenido);

  if (conceptos.length === 0) {
    throw new Error(`${ruta} no tiene filas de datos`);
  }

  const sistema = await prisma.catalogSystem.upsert({
    where: { code: catalogo.systemCode },
    /**
     * `hierarchical` SE FIJA TAMBIÉN AL ACTUALIZAR, igual que en el DPA y en
     * los países. La columna es `@default(false)`, así que aquí el valor
     * coincide con el que la base pondría sola — pero escribirlo es lo que
     * impide que una fila creada a mano en `true` deje el catálogo entero como
     * no elegible. Con `update: {}` eso sólo se corrige a mano, y nadie mira
     * una bandera cuyo síntoma es un desplegable vacío.
     */
    update: { hierarchical: false },
    create: {
      code: catalogo.systemCode,
      name: catalogo.nombre,
      hierarchical: false,
    },
  });

  const yaImportada = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: sistema.id, version: catalogo.version } }, // prettier-ignore
  });

  if (yaImportada) {
    if (yaImportada.sourceChecksum === checksum) return;

    // Misma versión, archivo distinto: o se republicó la lista, o alguien está
    // cargando otra cosa. Las dos piden una decisión humana.
    throw new Error(
      `${catalogo.systemCode}: la versión ${catalogo.version} ya existe con otro checksum.\n` +
        `  importado: ${yaImportada.sourceChecksum}\n` +
        `  archivo:   ${checksum}\n` +
        'Impórtela con un número de versión nuevo.',
    );
  }

  // Todo dentro de una transacción: una lista a medias que se declara completa
  // deja categorías que simplemente no aparecen, y la siguiente ejecución ve el
  // mismo checksum y no hace nada. Ya pasó con la CIE-10.
  await prisma.$transaction(async (tx) => {
    const release = await tx.catalogRelease.create({
      data: {
        systemId: sistema.id,
        version: catalogo.version,
        publishedOn: catalogo.publishedOn,
        effectiveFrom: catalogo.effectiveFrom,
        sourceUrl: catalogo.sourceUrl,
        sourceChecksum: checksum,
      },
    });

    await tx.catalogConcept.createMany({
      data: conceptos.map((concepto) => ({
        systemId: sistema.id,
        code: concepto.codigo,
        display: concepto.nombre,
        validFrom: catalogo.effectiveFrom,
        introducedByReleaseId: release.id,
        // Sin `parent_id` y sin `chapter`: una lista plana no tiene ni padre ni
        // agrupador. `level` 0 es lo que hay, y en un catálogo no jerárquico es
        // exactamente el nivel que se elige.
        attributes: { level: 0 },
      })),
    });
  });

  console.log(
    `Importado ${catalogo.systemCode}: ${conceptos.length} conceptos (${catalogo.version}).\n` +
      `  origen:   ${catalogo.sourceUrl}\n` +
      `  sha-256:  ${checksum}`,
  );

  if (descartadas.length > 0) {
    console.log(
      `  ${descartadas.length} línea(s) sin forma de dato, descartadas:`,
    );
    for (const d of descartadas) console.log(`    ${d.slice(0, 70)}`);
  }
}

/**
 * Deja los tres catálogos en la base, sobre el cliente que se le dé.
 *
 * EXPORTADA para que `seed.mts` la llame y para que las pruebas siembren lo
 * mismo que se sirve: sin filas, los tres selectores de la ficha aparecen
 * vacíos en cada base recién creada y eso parece un fallo de la pantalla en vez
 * de una siembra que falta. Es idempotente —la release con su checksum es la
 * que decide—, así que llamarla en cada arranque no duplica nada.
 */
export async function seedRdacaa(prisma: PrismaClient): Promise<void> {
  for (const catalogo of CATALOGOS) {
    await sembrarUno(prisma, catalogo);
  }

  console.log(
    '  ⚠️  Listas PROVISIONALES hasta contrastarlas con el instructivo del ' +
      'RDACAA 2.0 del MSP (D-036). Sustituirlas es cargar otra release.',
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    await seedRdacaa(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Sólo cuando se invoca directamente, para que importar `seedRdacaa` desde
// `seed.mts` o desde una prueba no siembre la base al cargar el módulo.
if (process.argv[1]?.endsWith('seed-rdacaa.mts')) {
  await main();
}
