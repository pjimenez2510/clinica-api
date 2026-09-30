import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CatalogBrowseCriteria,
  CatalogConcept,
  CatalogPage,
  CatalogRepository,
  CatalogSearchCriteria,
} from '../domain/catalog.repository';

/**
 * Filas de PostgreSQL, conceptos de dominio.
 *
 * TODA LA BÚSQUEDA VA EN SQL, y por una vez no es una preferencia: se apoya en
 * el índice GIN trigram (`catalog_concept_search_trgm`) y en la columna
 * generada `search_display`, ninguno de los cuales existe en `schema.prisma`
 * porque Prisma no sabe expresarlos.
 */

/** Lo que devuelve cualquiera de las consultas de abajo. */
interface FilaConcepto {
  id: string;
  code: string;
  display: string;
  chapter: string | null;
  chapterDisplay: string | null;
  level: number;
  /**
   * Si el catálogo del que sale forma un árbol.
   *
   * VIAJA EN CADA FILA porque es lo que decide si el concepto es elegible. Ver
   * `toConcept`.
   */
  hierarchical: boolean;
}

/**
 * Profundidad a partir de la cual un concepto de un catálogo JERÁRQUICO es
 * elegible.
 *
 * 0 es capítulo (`A00-B99`) y 1 es grupo (`A00-A09`): títulos de navegación,
 * no enfermedades. Desde 2 son categorías reales, y en el DPA son las
 * parroquias —provincia 0, cantón 1, parroquia 2—.
 *
 * ⚠️ SÓLO APLICA SI EL SISTEMA ES JERÁRQUICO, y esa condición entró con P2 de
 * `patients`. Etnia, nacionalidad e identidad de género son listas PLANAS: sus
 * conceptos están en el nivel 0 y son exactamente lo que hay que elegir.
 * Filtrando por profundidad sin mirar el sistema, `/catalogs/ETHNICITY`
 * devolvía la lista vacía SIEMPRE —y sin fallar—, que es la forma más cara de
 * romperse: el selector de la pantalla aparece vacío y parece que falta
 * sembrar.
 */
const NIVEL_SELECCIONABLE = 2;

/**
 * Cuánto parecido basta para considerar que una errata apunta a un concepto.
 *
 * `word_similarity` Y NO `similarity`, y la diferencia es encontrar o no
 * encontrar: `similarity` compara lo tecleado con la descripción ENTERA, así
 * que «nuemonia» contra «Neumonía, no especificada» da 0,18 —las palabras
 * sobrantes diluyen el parecido, y 0,18 está muy por debajo de cualquier umbral
 * razonable—, mientras que `word_similarity` busca el mejor tramo de palabras
 * dentro del texto y da 0,56.
 *
 * 0,4 y no el 0,6 que trae `<%` de fábrica: con 0,6 «nuemonia» se quedaba fuera
 * por muy poco, y dos letras transpuestas es exactamente la errata que hay que
 * tolerar. Por debajo de 0,3 empiezan a colarse conceptos sin relación.
 */
const UMBRAL_ERRATA = 0.4;

/**
 * Colación española para ordenar lo que va a leer una persona.
 *
 * LA MISMA RAZÓN QUE EN EL LISTADO DE PACIENTES, y aquí el caso es literal: la
 * base está creada con colación `C`, que ordena por byte, y con eso «Ñucanchi
 * Llacta» —parroquia de Orellana— cae detrás de TODAS las demás, después
 * incluso de las minúsculas. Una lista de parroquias donde las que empiezan por
 * Ñ están al final es una parroquia que nadie encuentra recorriendo la lista, y
 * en Ecuador no es un caso raro.
 *
 * `es-ES-x-icu` pone `Ñ` entre `N` y `O`, que es donde va en español. Se aplica
 * SÓLO donde se ordena para mostrar; ver `prisma-patient.repository.ts`.
 */
const SPANISH = 'COLLATE "es-ES-x-icu"';

/**
 * Las columnas que `FilaConcepto` espera, escritas una sola vez.
 *
 * `"chapterDisplay"` ENTRE COMILLAS: PostgreSQL pasa a minúsculas todo
 * identificador sin comillas, y el campo llegaría como `chapterdisplay` —que no
 * es el que `FilaConcepto` declara, y `undefined` no falla en ningún sitio: el
 * nombre del capítulo simplemente no aparecería—.
 */
const CONCEPT_COLUMNS = Prisma.sql`
  c.id,
  c.code,
  c.display,
  c.attributes->>'chapter' AS chapter,
  capitulo.display AS "chapterDisplay",
  COALESCE((c.attributes->>'level')::int, 0) AS level,
  s.hierarchical
`;

/**
 * De dónde salen esas columnas: el concepto, su catálogo y el NOMBRE de su
 * capítulo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CAPÍTULO SE RESUELVE AL CONSULTAR, NO AL SEMBRAR (ADR-005 §5)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `attributes.chapter` guarda un CÓDIGO —`A00-B99`, `17`— y eso es lo que
 * acababa en pantalla. Guardar además el nombre al sembrar habría sido más
 * barato de consultar y es la opción que se descarta, por tres motivos:
 *
 *  1. Obligaría a RESEMBRAR todo catálogo ya cargado. Los 14 498 conceptos de
 *     la CIE-10 son destino de claves foráneas de diagnósticos, así que
 *     resembrar es borrar y volver a insertar filas a las que apuntan
 *     historias clínicas. Arreglar una pantalla no puede costar eso.
 *  2. Congelaría el nombre. Un capítulo renombrado en la siguiente edición
 *     dejaría el nombre viejo copiado en cada uno de sus descendientes, y no
 *     hay nada que los recorra para corregirlo. Aquí el nombre sale de la fila
 *     del capítulo, que es su única fuente.
 *  3. Sólo arreglaría lo que se siembre a partir de hoy. Esto lo arregla
 *     también para el DPA, para el que venga, y sin tocar una sola fila.
 *
 * El precio es esta unión, y es pequeño: `LATERAL` con `LIMIT 1` sobre
 * `(system_id, code)`, que tiene índice (`catalog_concept_system_id_code_idx`),
 * y sobre páginas acotadas —50 filas de una búsqueda, 500 de un nivel—.
 *
 * `ORDER BY valid_from DESC` porque un código es único POR PERIODO, no en
 * absoluto: un capítulo renombrado tiene dos filas, y el nombre que se enseña
 * es el vigente. Misma regla que la provincia y el cantón de la ficha.
 *
 * `LEFT JOIN` y no `JOIN`: un catálogo plano no tiene capítulo, y un concepto
 * cuyo capítulo no esté en la base tiene que seguir apareciendo con su código.
 */
const CONCEPT_SOURCE = Prisma.sql`
  FROM catalog_concept c
  JOIN catalog_system s ON s.id = c.system_id
  LEFT JOIN LATERAL (
    SELECT cap.display
    FROM catalog_concept cap
    WHERE cap.system_id = c.system_id
      AND cap.code = c.attributes->>'chapter'
    ORDER BY cap.valid_from DESC
    LIMIT 1
  ) capitulo ON TRUE
`;

/**
 * Raw SQL adapter for `CatalogRepository`: every query is built from
 * `CONCEPT_COLUMNS` and `CONCEPT_SOURCE`, so each one returns the same
 * `FilaConcepto` shape with the chapter's name resolved.
 */
@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca por código o por descripción, en una sola consulta.
   *
   * DOS ESTRATEGIAS SEGÚN LO QUE SE TECLEE, porque son preguntas distintas:
   *
   *  - Un CÓDIGO se busca por PREFIJO. Quien escribe `J30` quiere ver `J30` y
   *    sus subcategorías `J30.0`, `J30.1`…, que es como se navega la CIE-10
   *    hacia el código específico que exige el RDACAA. El punto se ignora, así
   *    que `J300` y `J30.0` encuentran lo mismo.
   *
   *  - Una DESCRIPCIÓN se busca por similitud trigram, que tolera erratas y
   *    acentos: «neumonia», «neumonía» y «nuemonia» llegan a lo mismo. Un
   *    `LIKE` exigiría escribirlo bien, y nadie escribe bien a las once de la
   *    mañana con la sala llena.
   *
   * El orden mezcla ambas: primero lo que empieza por el texto, luego lo más
   * parecido, y a igualdad el código — así un código exacto nunca queda
   * sepultado bajo coincidencias de texto.
   */
  async search(
    criteria: CatalogSearchCriteria,
  ): Promise<readonly CatalogConcept[]> {
    const texto = criteria.query.trim();
    if (texto === '') return [];

    // Sin puntos ni espacios: `J30.0`, `J300` y `j30 0` son el mismo prefijo.
    const prefijoCodigo = `${texto.replace(/[\s.]/g, '').toUpperCase()}%`;

    const soloSeleccionables = criteria.onlySelectable
      ? Prisma.sql`AND (
          NOT s.hierarchical
          OR COALESCE((c.attributes->>'level')::int, 0) >= ${NIVEL_SELECCIONABLE}
        )`
      : Prisma.empty;

    /**
     * Acotar a una rama: TODA la descendencia, no los hijos directos.
     *
     * Las parroquias son NIETAS de una provincia. Con `parent_id = ${padre}`,
     * «buscar SANTA dentro de Guayas» devolvería cantones y ninguna parroquia
     * —y con `onlySelectable`, que es el valor por defecto, devolvería la lista
     * vacía—: exactamente lo contrario de lo que se pidió.
     *
     * El `WITH RECURSIVE` va DENTRO del `IN` y no delante de la consulta para
     * no partir en dos el `SELECT` de arriba según haya rama o no. PostgreSQL
     * admite un `WITH` en una subconsulta, y el recorrido es por `parent_id`,
     * que está indexado.
     *
     * ARRANCA EN LOS HIJOS, así que el propio padre queda fuera: quien busca
     * DENTRO de un cantón no está buscando el cantón. Y el recorrido no filtra
     * por vigencia —sólo lo hace el `WHERE` de fuera, sobre el resultado—
     * porque un nivel intermedio retirado no debe esconder a sus descendientes
     * vigentes.
     */
    const rama =
      criteria.parentId === null
        ? Prisma.empty
        : Prisma.sql`AND c.id IN (
            WITH RECURSIVE descendencia AS (
              SELECT h.id
              FROM catalog_concept h
              WHERE h.parent_id = ${criteria.parentId}::uuid

              UNION ALL

              SELECT n.id
              FROM catalog_concept n
              JOIN descendencia ON n.parent_id = descendencia.id
            )
            SELECT id FROM descendencia
          )`;

    const filas = await this.prisma.$transaction(async (tx) => {
      /**
       * Bajar el umbral de `<%` para esta transacción y sólo para ella.
       *
       * EL OPERADOR Y NO `word_similarity(…) >= 0,4` ESCRITO A MANO, aunque
       * signifique este viaje extra: una comparación explícita es una función
       * cualquiera para el planificador, que entonces no puede usar el índice
       * GIN y recorre la tabla. Medido sobre los 14 498 conceptos reales, misma
       * consulta y mismo resultado: 74 ms con el umbral escrito a mano, 1 ms
       * con el operador. La caja de diagnóstico busca en cada pulsación.
       *
       * El tercer argumento `true` es lo que lo hace local: el valor se
       * deshace al terminar la transacción y no contamina la conexión, que
       * vuelve a un pool compartido con el resto de la aplicación.
       */
      await tx.$executeRaw`
        SELECT set_config('pg_trgm.word_similarity_threshold', ${String(UMBRAL_ERRATA)}, true)
      `;

      return tx.$queryRaw<FilaConcepto[]>`
        SELECT ${CONCEPT_COLUMNS}
        ${CONCEPT_SOURCE}
        WHERE s.code = ${criteria.systemCode}
          -- Vigencia: el rango generado es el que tiene el índice.
          AND c.valid_period @> ${criteria.on}::date
          ${soloSeleccionables}
          ${rama}
          -- Las tres ramas están indexadas a propósito: PostgreSQL sólo las
          -- combina con un BitmapOr si NINGUNA se queda sin índice.
          AND (
            replace(c.code, '.', '') LIKE ${prefijoCodigo}
            OR c.search_display LIKE '%' || immutable_unaccent(lower(${texto})) || '%'
            OR immutable_unaccent(lower(${texto})) <% c.search_display
          )
        ORDER BY
          -- 1. El código exacto primero, siempre.
          (replace(c.code, '.', '') = ${prefijoCodigo.slice(0, -1)}) DESC,
          -- 2. Luego los códigos que empiezan por lo tecleado.
          (replace(c.code, '.', '') LIKE ${prefijoCodigo}) DESC,
          -- 3. Luego por parecido del texto.
          word_similarity(immutable_unaccent(lower(${texto})), c.search_display) DESC,
          c.code ASC
        LIMIT ${criteria.limit}
      `;
    });

    return filas.map(toConcept);
  }

  /**
   * Las raíces de un catálogo: las 24 provincias, los capítulos, los países.
   *
   * `parent_id IS NULL` Y NO «nivel 0». El nivel es un atributo del archivo
   * importado —un número dentro de un JSON— y el padre es la relación que la
   * base sí garantiza. Un catálogo sembrado sin `level` tiene raíces igual.
   */
  async rootsOf(
    systemCode: string,
    criteria: CatalogBrowseCriteria,
  ): Promise<CatalogPage> {
    return this.pageOf(
      Prisma.sql`s.code = ${systemCode} AND c.parent_id IS NULL`,
      criteria,
    );
  }

  /** Los hijos directos: los cantones de una provincia, sus parroquias. */
  async childrenOf(
    parentId: string,
    criteria: CatalogBrowseCriteria,
  ): Promise<CatalogPage> {
    return this.pageOf(Prisma.sql`c.parent_id = ${parentId}::uuid`, criteria);
  }

  /**
   * Un tramo del catálogo, ordenado para leerlo, y cuántos hay en total.
   *
   * DOS CONSULTAS Y NO UN `COUNT(*) OVER ()`. La ventana ahorra un viaje, pero
   * viaja EN LAS FILAS: una página vacía —la tercera de una lista de dos— no
   * trae ninguna fila y por tanto ningún total, y el cliente concluye que la
   * lista entera está vacía justo cuando lo que necesita es saber que se pasó
   * de largo. Van en paralelo, y las dos usan el mismo índice.
   *
   * El orden es por NOMBRE con colación española y el código desempata: dos
   * parroquias pueden llamarse igual en cantones distintos, y sin el segundo
   * criterio su orden relativo cambiaría entre páginas — que es como una fila
   * se repite en una página y falta en otra.
   */
  private async pageOf(
    where: Prisma.Sql,
    criteria: CatalogBrowseCriteria,
  ): Promise<CatalogPage> {
    const [filas, total] = await Promise.all([
      this.prisma.$queryRaw<FilaConcepto[]>`
        SELECT ${CONCEPT_COLUMNS}
        ${CONCEPT_SOURCE}
        WHERE ${where}
          AND c.valid_period @> ${criteria.on}::date
        ORDER BY c.display ${Prisma.raw(SPANISH)} ASC, c.code ASC
        LIMIT ${criteria.limit} OFFSET ${criteria.offset}
      `,
      // La cuenta NO usa CONCEPT_SOURCE: contar filas no necesita el nombre
      // del capítulo, y una unión lateral por fila para descartarla después
      // sería trabajo pagado sobre el catálogo entero, no sobre una página.
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(*) AS total
        FROM catalog_concept c
        JOIN catalog_system s ON s.id = c.system_id
        WHERE ${where}
          AND c.valid_period @> ${criteria.on}::date
      `,
    ]);

    return {
      items: filas.map(toConcept),
      // `COUNT(*)` es `bigint` en PostgreSQL y llega como `BigInt`, que no
      // sobrevive a `JSON.stringify` sin ayuda. Un catálogo no llega a 2^53.
      total: Number(total[0]?.total ?? 0),
    };
  }

  /**
   * The typed code is stripped of dots and spaces and upper-cased, and the
   * stored one of dots, so `J18.9` and `j189` find the same concept.
   * `valid_period @> on` is the validity at that date.
   */
  async findByCode(
    systemCode: string,
    code: string,
    on: Date,
  ): Promise<CatalogConcept | null> {
    const filas = await this.prisma.$queryRaw<FilaConcepto[]>`
      SELECT ${CONCEPT_COLUMNS}
      ${CONCEPT_SOURCE}
      WHERE s.code = ${systemCode}
        AND replace(c.code, '.', '') = ${code.replace(/[\s.]/g, '').toUpperCase()}
        AND c.valid_period @> ${on}::date
      LIMIT 1
    `;
    return filas[0] ? toConcept(filas[0]) : null;
  }

  /** El mismo `WHERE` que `findByCode`, menos la vigencia. */
  async existsInAnyPeriod(systemCode: string, code: string): Promise<boolean> {
    const filas = await this.prisma.$queryRaw<{ uno: number }[]>`
      SELECT 1 AS uno
      FROM catalog_concept c
      JOIN catalog_system s ON s.id = c.system_id
      WHERE s.code = ${systemCode}
        AND replace(c.code, '.', '') = ${code.replace(/[\s.]/g, '').toUpperCase()}
      LIMIT 1
    `;
    return filas.length > 0;
  }

  /**
   * Un concepto por su id, sin condición de vigencia.
   *
   * El `::uuid` es lo que hace que la comparación tenga tipo: el parámetro
   * llega como `text` y la columna es `uuid`. NO valida la forma —un id mal
   * escrito hace fallar el propio cast—, y de eso se encarga el
   * `ParseUUIDPipe` del controlador, que responde 400 antes de llegar aquí.
   */
  async findById(id: string): Promise<CatalogConcept | null> {
    const filas = await this.prisma.$queryRaw<FilaConcepto[]>`
      SELECT ${CONCEPT_COLUMNS}
      ${CONCEPT_SOURCE}
      WHERE c.id = ${id}::uuid
      LIMIT 1
    `;
    return filas[0] ? toConcept(filas[0]) : null;
  }

  /**
   * La cadena de ancestros, de capítulo a padre inmediato.
   *
   * Consulta RECURSIVA en lugar de un bucle de consultas: la profundidad es
   * variable —tres niveles en unos capítulos, cinco en otros— y hacer una
   * consulta por nivel multiplica los viajes a la base por algo que PostgreSQL
   * resuelve de una vez.
   */
  async ancestorsOf(id: string): Promise<readonly CatalogConcept[]> {
    const filas = await this.prisma.$queryRaw<
      (FilaConcepto & { depth: number })[]
    >`
      WITH RECURSIVE cadena AS (
        SELECT c.id, c.code, c.display, c.attributes, c.parent_id, c.system_id, 0 AS depth
        FROM catalog_concept c
        WHERE c.id = ${id}::uuid

        UNION ALL

        SELECT p.id, p.code, p.display, p.attributes, p.parent_id, p.system_id, cadena.depth + 1
        FROM catalog_concept p
        JOIN cadena ON cadena.parent_id = p.id
      )
      SELECT
        cadena.id,
        cadena.code,
        cadena.display,
        cadena.attributes->>'chapter' AS chapter,
        capitulo.display AS "chapterDisplay",
        COALESCE((cadena.attributes->>'level')::int, 0) AS level,
        s.hierarchical,
        cadena.depth
      FROM cadena
      JOIN catalog_system s ON s.id = cadena.system_id
      -- El mismo nombre de capítulo que el resto de consultas; ver
      -- CONCEPT_SOURCE. La cadena de ancestros es lo que sitúa un código en su
      -- rama, así que enseñarla en códigos es donde menos se puede.
      LEFT JOIN LATERAL (
        SELECT cap.display
        FROM catalog_concept cap
        WHERE cap.system_id = cadena.system_id
          AND cap.code = cadena.attributes->>'chapter'
        ORDER BY cap.valid_from DESC
        LIMIT 1
      ) capitulo ON TRUE
      -- El propio concepto (profundidad 0) no es ancestro de sí mismo.
      WHERE cadena.depth > 0
      ORDER BY cadena.depth DESC
    `;
    return filas.map(toConcept);
  }
}

/**
 * The single conversion from row to domain concept; see the field comments for
 * `chapterDisplay` and `selectable`.
 */
function toConcept(fila: FilaConcepto): CatalogConcept {
  return {
    id: fila.id,
    code: fila.code,
    display: fila.display,
    chapter: fila.chapter,
    /**
     * El nombre del capítulo, o `null` si el catálogo no puede decirlo.
     *
     * `?? null` Y NO `fila.chapterDisplay` A SECAS: la unión lateral no
     * devuelve la columna cuando no hay capítulo en ninguna consulta futura
     * que se escriba sin ella, y `undefined` desaparece al serializar a JSON —
     * el campo no viajaría, y el cliente no distinguiría «no tiene capítulo»
     * de «este endpoint no lo manda».
     */
    chapterDisplay: fila.chapterDisplay ?? null,
    level: fila.level,
    /**
     * Elegible: lo que se puede guardar como referencia.
     *
     * EN UN CATÁLOGO PLANO, TODO LO ES. Etnia, nacionalidad e identidad de
     * género no tienen capítulos que descartar, así que exigirles profundidad 2
     * sería declarar no elegible a la lista entera. En uno jerárquico sigue
     * siendo la profundidad la que distingue el título de navegación —un
     * capítulo de la CIE-10, una provincia del DPA— del código que el RDACAA
     * acepta.
     */
    selectable: !fila.hierarchical || fila.level >= NIVEL_SELECCIONABLE,
  };
}
