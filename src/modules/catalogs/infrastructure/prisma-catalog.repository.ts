import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CatalogConcept,
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
  level: number;
}

/**
 * Profundidad a partir de la cual un concepto es diagnosticable.
 *
 * 0 es capítulo (`A00-B99`) y 1 es grupo (`A00-A09`): títulos de navegación,
 * no enfermedades. Desde 2 son categorías reales.
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
      ? Prisma.sql`AND (c.attributes->>'level')::int >= ${NIVEL_SELECCIONABLE}`
      : Prisma.empty;

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
        SELECT
          c.id,
          c.code,
          c.display,
          c.attributes->>'chapter' AS chapter,
          (c.attributes->>'level')::int AS level
        FROM catalog_concept c
        JOIN catalog_system s ON s.id = c.system_id
        WHERE s.code = ${criteria.systemCode}
          -- Vigencia: el rango generado es el que tiene el índice.
          AND c.valid_period @> ${criteria.on}::date
          ${soloSeleccionables}
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

  async findByCode(
    systemCode: string,
    code: string,
    on: Date,
  ): Promise<CatalogConcept | null> {
    const filas = await this.prisma.$queryRaw<FilaConcepto[]>`
      SELECT
        c.id,
        c.code,
        c.display,
        c.attributes->>'chapter' AS chapter,
        (c.attributes->>'level')::int AS level
      FROM catalog_concept c
      JOIN catalog_system s ON s.id = c.system_id
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
      SELECT
        c.id,
        c.code,
        c.display,
        c.attributes->>'chapter' AS chapter,
        (c.attributes->>'level')::int AS level
      FROM catalog_concept c
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
        SELECT c.id, c.code, c.display, c.attributes, c.parent_id, 0 AS depth
        FROM catalog_concept c
        WHERE c.id = ${id}::uuid

        UNION ALL

        SELECT p.id, p.code, p.display, p.attributes, p.parent_id, cadena.depth + 1
        FROM catalog_concept p
        JOIN cadena ON cadena.parent_id = p.id
      )
      SELECT
        id,
        code,
        display,
        attributes->>'chapter' AS chapter,
        (attributes->>'level')::int AS level,
        depth
      FROM cadena
      -- El propio concepto (profundidad 0) no es ancestro de sí mismo.
      WHERE depth > 0
      ORDER BY depth DESC
    `;
    return filas.map(toConcept);
  }
}

function toConcept(fila: FilaConcepto): CatalogConcept {
  return {
    id: fila.id,
    code: fila.code,
    display: fila.display,
    chapter: fila.chapter,
    level: fila.level,
    selectable: fila.level >= NIVEL_SELECCIONABLE,
  };
}
