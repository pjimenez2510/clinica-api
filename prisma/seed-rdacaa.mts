import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Importa los cinco catálogos PLANOS que la ficha del RDACAA necesita:
 * orientación sexual (columna 7), identidad de género (columna 8),
 * autoidentificación étnica (columna 12), nacionalidad indígena (columna 13) y
 * pueblo (columna 14).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS CINCO EN UN SOLO SEMBRADOR, PORQUE SON LA MISMA COSA CINCO VECES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Misma forma —`codigo;nombre`, sin padres, sin capítulos—, misma disciplina
 * que el DPA, la CIE-10 y los países —una `catalog_release` por sistema con su
 * versión, su origen y el SHA-256 del archivo— y ahora también la misma fuente:
 * las cinco listas salen del MISMO documento del ministerio, y de tres páginas
 * seguidas de él. Cinco sembradores casi idénticos sólo habrían multiplicado
 * por cinco el sitio donde corregir.
 *
 * ⚠️ LOS DOS ÚLTIMOS ENTRARON EL 19-08-2026, CON D-039 (PA-056, PA-057). Eran
 * dos columnas del formulario que este sistema no tenía —la 7 y la 14—, así
 * que su casilla salía vacía en el reporte mensual sin que nada fallara.
 *
 * El mecanismo ya estaba hecho desde P2 de `patients`: `catalogSystemSchema`
 * admite los códigos y la ficha sabe guardar la referencia. Para los tres
 * primeros lo único que faltaba eran las FILAS, y sin ellas el selector de la
 * pantalla salía vacío —con un 200, que es la forma cara de romperse—; para los
 * dos últimos faltaba además la columna, y la puso
 * `20260819093227_patient_rdacaa_people_and_sexual_orientation`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DE DÓNDE SALEN LAS CINCO LISTAS: EL INSTRUCTIVO OFICIAL, 19-08-2026
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Instructivo del formulario SNS-MSP / Form. 504 / 2019 — «Registro Diario
 * Automatizado de Consultas y Atenciones Ambulatorias RDACAA 2.0»**,
 * Coordinación General de Planificación y Gestión Estratégica · Dirección
 * Nacional de Estadística y Análisis de Información de Salud, **abril de
 * 2019**. Los catálogos están en las páginas 37, 39 y 40 del PDF, **como
 * imágenes**: no salen al extraer el texto y hay que mirarlas.
 *
 *  - **§ 1.4.7, columna 7 — Orientación sexual** → `SEXUAL_ORIENTATION`
 *    («Esta variable aplica a usuarios a partir de los 10 años de edad»)
 *  - **§ 1.4.8, columna 8 — Identidad de género** → `GENDER_IDENTITY`
 *  - **§ 1.4.12, columna 12 — Autoidentificación étnica** → `ETHNICITY`
 *    («Aplica para nacionalidad Ecuatoriana»)
 *  - **§ 1.4.13, columna 13 — Nacionalidades** → `NATIONALITY`
 *    («Aplica únicamente para la autoidentificación "indígena"»)
 *  - **§ 1.4.14, columna 14 — Pueblos** → `PEOPLE`
 *    («Aplica únicamente para la nacionalidad indígena "Kichwa"»)
 *
 * El documento es del ministerio; el ejemplar del que se transcribió está
 * alojado en un tercero —el MSP no lo publica en una URL estable— y una copia
 * vive en `../clinica-docs/`. Eso afecta a DÓNDE se consiguió, no a QUÉ dice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ CORRECCIÓN DEL 19-08-2026: LA COLUMNA 11 SÍ ES EL PAÍS. AQUÍ SE DIJO QUE
 *    NO, Y ERA FALSO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este archivo, el `SPEC.md` de `patients` y la decisión D-036 afirmaban que
 * «en el RDACAA "nacionalidad" NO es el país». **No es cierto, y quien lo lea
 * tiene que saberlo antes de tocar nada.** Son DOS columnas con nombres casi
 * iguales:
 *
 *  - **Columna 11, «Nacionalidad»** — *«Registrar la nacionalidad (país de
 *    origen) del usuario»*. Lista cerrada de 20 países más `988 Otro/a`. Es el
 *    país, y en este sistema lo cubre `patient.country_of_nationality_code`
 *    contra el catálogo `COUNTRY` (PA-053).
 *  - **Columna 13, «Nacionalidades»** — la nacionalidad INDÍGENA —Achuar, Awa,
 *    Kichwa, Shuar…—, que el formulario *«aplica únicamente para la
 *    autoidentificación "indígena"»*. Es la que se siembra aquí, en
 *    `NATIONALITY`, y a la que apunta `patient.nationality_concept_id`
 *    (PA-027).
 *
 * Lo que la corrección NO cambia: **siguen haciendo falta los dos datos**, que
 * es lo que D-036 decidió con la opción C y sigue siendo correcto. Lo que sí
 * cambia es el motivo: no es que el RDACAA no pregunte el país —lo pregunta en
 * la columna 11—, es que pregunta las dos cosas en dos columnas distintas.
 *
 * Y lo que la corrección CONFIRMA: **la condición de PA-027 es exactamente la
 * del instructivo.** Se construyó a partir de una copia de terceros del manual
 * de usuario del software y resulta ser literalmente lo que dice el documento
 * oficial. Ya no hay salvedad sobre la fuente.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `COUNTRY` NO SE TOCA, Y ÉSTA ES LA PREGUNTA QUE HARÁ EL SIGUIENTE QUE LEA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El instructivo cierra la columna 11 en **20 países más «Otro/a»**, y el
 * catálogo `COUNTRY` que sirve a PA-053 tiene los **249 de `ISO 3166-1
 * alpha-3`** (ver `seed-countries.mts`). No se reduce, y no es descuido:
 *
 *  - Los 20 del RDACAA son un **subconjunto** de los 249. Reducir el catálogo
 *    obligaría a registrar como «Otro/a» a un paciente boliviano, y **lo que se
 *    perdió no se puede volver a preguntar**.
 *  - Plegar los 249 a los 21 del formulario es trabajo de la **capa de
 *    exportación**, no del registro: es el mismo argumento que PA-005 escribe
 *    para el sexo y el que ya se aplicó a las nueve categorías de etnia.
 *  - `patient_identifier.issuing_country` guarda el país emisor del documento
 *    con el mismo estándar. Dos listas de países distintas en la misma base es
 *    lo que garantiza que un día discrepen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SUSTITUIR UNA LISTA ES CARGAR OTRA RELEASE, NO EDITAR FILAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Las tres listas que se sembraron el 17-08-2026 salían del censo del INEC y de
 * un manual del MSP —no del instructivo— y las tres estaban mal. La peor era la
 * etnia: usaba el `8` para «Otro/a» donde el ministerio pone **«No sabe / No
 * responde»**, así que una ficha registrada como «Otro/a» se habría reportado
 * como «No sabe» sin que nada fallara. El instructivo separa las dos: `8` es
 * «No sabe / No responde» y `98` es «Otro/a».
 *
 * La corrección entra como una **release nueva**: `sembrarUno` cierra la
 * vigencia de lo que dejó la anterior —`valid_to` y `retired_by_release_id`— y
 * mete las filas nuevas. La versión vieja **se queda en la tabla**, que es lo
 * que permite que una ficha registrada ayer siga resolviendo la categoría con
 * la que se registró: las fichas apuntan a la FILA por su `id`, no al código,
 * y leer una ficha nunca pregunta por vigencia (ver `isInForce` en
 * `patients.service.ts`, que sólo se aplica al escribir).
 *
 * CATÁLOGOS PLANOS: `hierarchical` en `false`. Ninguno cuelga de nada, y de esa
 * bandera depende que sus conceptos sean elegibles — ver `toConcept` en
 * `prisma-catalog.repository.ts`. Con `true`, saldrían marcados como títulos de
 * navegación y sus selectores aparecerían vacíos.
 *
 * ⚠️ Y `PEOPLE` NO CUELGA DE `NATIONALITY`, aunque el formulario lo condicione
 * a ella. La condición es del REGISTRO —«pueblo sólo si la nacionalidad es
 * Kichwa», PA-056— y no del catálogo: los 18 pueblos no son hijos de una fila
 * de otro sistema, y modelarlos como jerarquía obligaría a cruzar dos releases
 * cada vez que el ministerio reedite una de las dos listas. Misma razón por la
 * que `NATIONALITY` no cuelga de `ETHNICITY`.
 */

/**
 * El documento del que salen las tres listas, escrito una sola vez.
 *
 * La página es de un tercero porque el MSP no publica el instructivo en una URL
 * estable; el CONTENIDO es el del ministerio, con su número de formulario y su
 * fecha en la portada. Poner aquí una URL de `salud.gob.ec` que no existe sería
 * peor que decir de dónde se sacó de verdad.
 */
const INSTRUCTIVO_URL =
  'https://pdfcoffee.com/instructivo-fisico-rdacaa-20-ministerio-salud-publica-ecuador-pdf-free.html';

/**
 * La versión con la que entran los tres, que es el propio documento.
 *
 * Lleva el año de la portada —abril de 2019— porque el número de versión del
 * formulario (`2.0`) no cambia cuando el ministerio reedita el instructivo, y
 * dos artefactos distintos bajo la misma versión es exactamente lo que
 * `sourceChecksum` está puesto para detectar.
 */
const VERSION_INSTRUCTIVO = 'msp-rdacaa-2.0-2019';

/**
 * Desde cuándo esta base sirve las listas del instructivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO SE ANCLA AL INICIO DEL AÑO, AL REVÉS QUE UNA PRIMERA CARGA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El DPA, los países y la primera siembra de estos tres anclan su vigencia al
 * inicio del año para no declarar «no vigente» la categoría de una ficha
 * registrada antes. Para una release que SUSTITUYE a otra ese mismo anclaje es
 * el error: retrasar el corte a enero cerraría la lista anterior en una fecha
 * en la que estuvo sirviendo de verdad, y una ficha registrada bajo ella
 * quedaría apuntando a un concepto que su propia fecha de registro dice que no
 * existía.
 *
 * El corte es el día de la carga, y eso es lo que significa: **hasta el 19 esta
 * base servía la lista del INEC; desde el 19 sirve la del ministerio.** No
 * pretende decir desde cuándo rige el instructivo —rige desde 2019, y eso lo
 * dicen `sourceUrl` y la portada del documento—, sino desde cuándo lo obedece
 * este sistema.
 *
 * FIJA Y NO `new Date()`: sembrar dos veces tiene que producir lo mismo, y una
 * fecha que se mueve con el reloj convierte cada `pnpm db:seed` en una release
 * con una vigencia distinta.
 */
const VIGENTE_DESDE = new Date('2026-08-19T00:00:00Z');

/**
 * Desde cuándo esta base sirve una lista que NO SUSTITUYE A NINGUNA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNA PRIMERA CARGA SÍ SE ANCLA AL INICIO DEL AÑO, AL REVÉS QUE {@link VIGENTE_DESDE}
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SEXUAL_ORIENTATION` y `PEOPLE` entran el 19-08-2026 sin nada que retirar, y
 * ahí el argumento se invierte: `isInForce` (ver `patients.service.ts`) exige
 * `validFrom <= hoy` **al escribir**, así que una lista que empieza el mismo día
 * de la carga deja fuera cualquier ficha que se registre con una fecha clínica
 * anterior —una base restaurada, un entorno con el reloj movido, una prueba que
 * fija el día—. Con el corte en enero eso no puede pasar y no se pierde nada:
 * no hay ninguna release previa a la que este corte pudiera contradecir.
 *
 * Es el mismo anclaje que el DPA y los países, y por el mismo motivo.
 */
const VIGENTE_DESDE_PRIMERA_CARGA = new Date('2026-01-01T00:00:00Z');

/** Un catálogo plano y de dónde sale. Lo único que cambia entre los cinco. */
interface CatalogoPlano {
  systemCode: string;
  nombre: string;
  archivo: string;
  version: string;
  sourceUrl: string;
  /**
   * La fecha del documento que publica la lista, cuando se conoce con
   * precisión. Del instructivo se conoce el mes —abril de 2019— y no el día, y
   * una fecha inventada sería peor que ninguna: el año va en la versión.
   */
  publishedOn: Date | null;
  /** Desde cuándo esta base la sirve. Ver {@link VIGENTE_DESDE}. */
  effectiveFrom: Date;
}

/**
 * Los cinco, con sus valores por defecto.
 *
 * Cada uno admite `<SISTEMA>_FILE`, `<SISTEMA>_VERSION` y
 * `<SISTEMA>_SOURCE_URL` por entorno, que es como entrará la próxima edición
 * del instructivo: otra release, sin tocar código.
 */
const CATALOGOS: readonly CatalogoPlano[] = [
  {
    systemCode: 'SEXUAL_ORIENTATION',
    /**
     * Columna 7, y el instructivo la titula así en singular.
     *
     * ⚠️ NO ES `GENDER_IDENTITY`, que es la columna siguiente. El formulario
     * pregunta las dos, una detrás de otra, y son datos distintos: la identidad
     * de género dice cómo se identifica la persona y ésta a quién atrae.
     * Derivar una de la otra —o servir una lista donde se espera la otra— es el
     * error que este nombre existe para hacer visible.
     */
    nombre: 'Orientación sexual (RDACAA, columna 7)',
    archivo: 'rdacaa/orientaciones-sexuales.csv',
    version: VERSION_INSTRUCTIVO,
    sourceUrl: INSTRUCTIVO_URL,
    publishedOn: null,
    effectiveFrom: VIGENTE_DESDE_PRIMERA_CARGA,
  },
  {
    systemCode: 'ETHNICITY',
    // Columna 12 del formulario. El instructivo la titula así, en singular.
    nombre: 'Autoidentificación étnica (RDACAA, columna 12)',
    archivo: 'rdacaa/etnias.csv',
    version: VERSION_INSTRUCTIVO,
    sourceUrl: INSTRUCTIVO_URL,
    publishedOn: null,
    effectiveFrom: VIGENTE_DESDE,
  },
  {
    systemCode: 'NATIONALITY',
    /**
     * Columna 13, y el instructivo la titula «Nacionalidades», en plural, para
     * distinguirla de la columna 11 «Nacionalidad», que es el país. Aquí se
     * escribe «indígena» en el nombre porque ese plural no basta para que nadie
     * las confunda: es la confusión que este catálogo ya sufrió una vez.
     */
    nombre: 'Nacionalidad indígena (RDACAA, columna 13)',
    archivo: 'rdacaa/nacionalidades-indigenas.csv',
    version: VERSION_INSTRUCTIVO,
    sourceUrl: INSTRUCTIVO_URL,
    publishedOn: null,
    effectiveFrom: VIGENTE_DESDE,
  },
  {
    systemCode: 'GENDER_IDENTITY',
    // Columna 8.
    nombre: 'Identidad de género (RDACAA, columna 8)',
    archivo: 'rdacaa/identidades-genero.csv',
    version: VERSION_INSTRUCTIVO,
    sourceUrl: INSTRUCTIVO_URL,
    publishedOn: null,
    effectiveFrom: VIGENTE_DESDE,
  },
  {
    systemCode: 'PEOPLE',
    /**
     * Columna 14, el tercer escalón de la cadena que empieza en la 12.
     *
     * El instructivo lo activa *«únicamente para la nacionalidad indígena
     * "Kichwa"»*, y esa condición es del REGISTRO (PA-056), no de este
     * catálogo: aquí sólo entran las 18 filas, planas y sin padre. Ver la
     * cabecera.
     */
    nombre: 'Pueblo (RDACAA, columna 14)',
    archivo: 'rdacaa/pueblos.csv',
    version: VERSION_INSTRUCTIVO,
    sourceUrl: INSTRUCTIVO_URL,
    publishedOn: null,
    effectiveFrom: VIGENTE_DESDE_PRIMERA_CARGA,
  },
];

/** One data line of a `codigo;nombre` file; the code stays a string (see `leer`). */
interface Concepto {
  codigo: string;
  nombre: string;
}

/**
 * Lee un CSV `codigo;nombre` con cabecera.
 *
 * SEPARADOR `;` Y SIN COMILLAS. Los nombres llevan barras y espacios
 * —«Afroecuatoriano/a Afrodescendiente», «No sabe / No responde»— pero ningún
 * punto y coma, así que partir por el separador es correcto; si algún día
 * apareciera uno, la comprobación de forma rechaza la fila en vez de partirla
 * mal.
 *
 * EL CÓDIGO SE GUARDA TAL CUAL, como una cadena y no como un número: en el
 * instructivo la etnia salta del `8` al `98`, y `98` no es «el noveno». Un
 * `Number` invitaría a renumerar, y renumerar es lo que hace que el reporte
 * mensual salga mal sin que nada falle.
 *
 * DOS DÍGITOS COMO MUCHO, que es lo más ancho de las tres listas (`98 Otro/a`).
 * La columna 11 llega hasta `988`, pero esa es la del país y la sirve `COUNTRY`
 * con códigos `ISO 3166-1 alpha-3`; si alguien la volcara aquí, sus filas se
 * descartarían EN VOZ ALTA en vez de entrar mal.
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

/**
 * Imports one flat catalogue as a new release. Idempotent on (system, version):
 * the same file again is a no-op, a different file under the same version is
 * refused. A new release retires the concepts in force instead of deleting
 * them, and refuses to run when one of them starts on or after its cut-off.
 */
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
     *
     * `name` TAMBIÉN, porque el título del catálogo cambió al llegar el
     * instructivo —«Nacionalidad o pueblo indígena» era de otra fuente y de
     * otra columna— y un nombre que sólo se escribe al crear se queda con la
     * redacción equivocada en toda base que ya existiera.
     */
    update: { hierarchical: false, name: catalogo.nombre },
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

  /**
   * Lo que la release anterior dejó vigente y esta va a sustituir.
   *
   * Se cuenta ANTES de la transacción sólo para poder decirlo por consola; lo
   * que decide es el `updateMany` de dentro.
   */
  const vigentes = await prisma.catalogConcept.count({
    where: { systemId: sistema.id, validTo: null },
  });

  /**
   * Una lista anterior que empiece EN o DESPUÉS del corte no se puede cerrar.
   *
   * `catalog_concept_period_not_empty` exige `valid_to > valid_from`, y
   * `catalog_concept_code_temporal_unique` rechazaría los códigos repetidos:
   * el fallo llegaría igual, pero como una violación de constraint en mitad de
   * un `createMany` de dieciséis filas. Decirlo aquí, con el sistema y la
   * fecha, es la diferencia entre saber qué pasa y leer un `23514`.
   */
  const posteriores = await prisma.catalogConcept.count({
    where: {
      systemId: sistema.id,
      validTo: null,
      validFrom: { gte: catalogo.effectiveFrom },
    },
  });

  if (posteriores > 0) {
    throw new Error(
      `${catalogo.systemCode}: ${posteriores} concepto(s) vigentes empiezan en ` +
        `${catalogo.effectiveFrom.toISOString().slice(0, 10)} o después, así que ` +
        'la release nueva no los puede sustituir. Cargue la lista con una ' +
        'fecha de vigencia posterior.',
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

    /**
     * RETIRAR, NO BORRAR. Las fichas apuntan a estas filas por su `id` —hay
     * `ON DELETE RESTRICT` de por medio—, así que borrarlas ni se puede ni se
     * querría: lo que se retira es la posibilidad de ELEGIRLAS a partir del
     * corte. Una ficha registrada antes sigue enseñando la categoría con la
     * que se registró, porque leerla no pregunta por vigencia.
     *
     * `retired_by_release_id` es lo que deja escrito QUIÉN las retiró, y es la
     * mitad que faltaba de la provenance: sin ella, un catálogo con dos
     * releases no sabe decir cuál cerró qué.
     */
    await tx.catalogConcept.updateMany({
      where: { systemId: sistema.id, validTo: null },
      data: {
        validTo: catalogo.effectiveFrom,
        retiredByReleaseId: release.id,
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

  if (vigentes > 0) {
    console.log(
      `  ${vigentes} concepto(s) de la release anterior retirados el ` +
        `${catalogo.effectiveFrom.toISOString().slice(0, 10)}. Las fichas que ` +
        'los declaran los siguen resolviendo; ya no se pueden elegir.',
    );
  }

  if (descartadas.length > 0) {
    console.log(
      `  ${descartadas.length} línea(s) sin forma de dato, descartadas:`,
    );
    for (const d of descartadas) console.log(`    ${d.slice(0, 70)}`);
  }
}

/**
 * Deja los cinco catálogos en la base, sobre el cliente que se le dé.
 *
 * EXPORTADA para que `seed.mts` la llame y para que las pruebas siembren lo
 * mismo que se sirve: sin filas, los cinco selectores de la ficha aparecen
 * vacíos en cada base recién creada y eso parece un fallo de la pantalla en vez
 * de una siembra que falta. Es idempotente —la release con su checksum es la
 * que decide—, así que llamarla en cada arranque no duplica nada.
 */
export async function seedRdacaa(prisma: PrismaClient): Promise<void> {
  for (const catalogo of CATALOGOS) {
    await sembrarUno(prisma, catalogo);
  }
}

/** Entry point of `pnpm db:seed:rdacaa`. Reference data from the ministry's instructivo, not demo data. */
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
