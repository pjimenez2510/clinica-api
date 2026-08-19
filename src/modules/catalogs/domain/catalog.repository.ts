/**
 * Qué necesita la aplicación de un catálogo, dicho sin nombrar una base.
 *
 * UN PUERTO, y aquí no es ceremonia: la búsqueda por texto se resuelve hoy con
 * un índice trigram de PostgreSQL y mañana puede ser otra cosa. Lo que no debe
 * cambiar es la pregunta — «códigos vigentes que se parecen a esto» — ni las
 * reglas de qué es seleccionable.
 */

/** Un concepto tal como lo lee una persona. */
export interface CatalogConcept {
  id: string;
  code: string;
  display: string;
  /**
   * Capítulo al que pertenece, para dar contexto en la lista: dos códigos con
   * texto parecido pueden estar en capítulos muy distintos, y el capítulo es lo
   * que desambigua sin abrir nada.
   *
   * EL CÓDIGO DEL CAPÍTULO: `A00-B99` en la CIE-10, `17` en el DPA. Viaja
   * siempre —en la CIE-10 el código se maneja, se dicta y se teclea— pero
   * NUNCA SOLO: ver {@link CatalogConcept.chapterDisplay}.
   */
  chapter: string | null;
  /**
   * Cómo se llama ese capítulo: «Ciertas enfermedades infecciosas y
   * parasitarias», «Pichincha».
   *
   * ═══════════════════════════════════════════════════════════════════════
   * ADR-005 §5: UN CÓDIGO QUE QUIEN LO LEE NO PUEDE INTERPRETAR NO ES
   * INFORMACIÓN, ES RUIDO CON ASPECTO DE DATO.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * El capítulo está aquí «para desambiguar dos textos parecidos», y `A00-B99`
   * no desambigua nada para nadie. No se trata de esconder el código —en la
   * CIE-10 sí se maneja— sino de acompañarlo del nombre, que es exactamente lo
   * que la regla pide: se enseña el nombre, el código puede ir en segundo
   * plano, y ninguno de los dos aparece solo. Y es obligación del backend: la
   * interfaz no puede resolverlo si el contrato sólo manda el código.
   *
   * `null` cuando no hay capítulo —una lista plana no tiene— o cuando el
   * catálogo no puede decir cómo se llama: una edición vieja cuyo capítulo ya
   * no está. El CÓDIGO sigue viajando, porque un nombre que falta es una
   * pantalla peor y un código que falta es un registro peor.
   */
  chapterDisplay: string | null;
  /**
   * Profundidad en la jerarquía. `0` capítulo, `1` grupo, `2` en adelante
   * categorías y subcategorías.
   */
  level: number;
  /**
   * Si puede registrarse como diagnóstico.
   *
   * NO TODO CÓDIGO ES DIAGNOSTICABLE. `A00-B99` es un capítulo y `A00-A09` un
   * grupo: son navegación, no enfermedades. Registrar uno de ellos produce un
   * dato que el RDACAA rechaza, así que la distinción viaja hasta la interfaz
   * en vez de quedarse en una convención que alguien recuerda.
   */
  selectable: boolean;
}

export interface CatalogSearchCriteria {
  systemCode: string;
  /** Texto libre: un código, un fragmento de código, o parte de la descripción. */
  query: string;
  /**
   * Fecha en la que el concepto debe estar vigente.
   *
   * Casi siempre hoy, pero NO siempre: al reabrir una historia de hace tres
   * años hay que resolver sus diagnósticos con el catálogo de entonces, o un
   * código retirado aparecería como inexistente.
   */
  on: Date;
  /** Excluye capítulos y grupos. Lo que quiere una caja de diagnóstico. */
  onlySelectable: boolean;
  /**
   * Acota la búsqueda a una RAMA del árbol, o `null` para buscar en todo el
   * catálogo.
   *
   * TODA LA DESCENDENCIA, no sólo los hijos directos, y la diferencia es que
   * sirva o no: las parroquias son NIETAS de una provincia, así que «buscar
   * SANTA dentro de Guayas» limitado a hijos directos devolvería cantones y
   * ninguna parroquia — es decir, nada de lo que se estaba buscando.
   *
   * Existe porque sin él acotar obliga al cliente a traerse el cantón entero y
   * filtrar en memoria, que es justo lo que esta consulta evita.
   */
  parentId: string | null;
  limit: number;
}

/**
 * Recorrer el árbol por niveles, que es como una persona sabe dónde vive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO BASTA CON BUSCAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La búsqueda por texto devuelve las mejores coincidencias y nada más. Con 1401
 * parroquias, quien teclea «SANTA» recibe un puñado y NO TIENE FORMA DE LLEGAR
 * AL RESTO: ni sabe cuántas hay, ni puede pedir las siguientes. Si la suya no
 * está entre las que cupieron, la pantalla es un callejón sin salida.
 *
 * Navegar provincia → cantón → parroquia no tiene ese problema porque no
 * depende de acertar con el texto: la lista de cada nivel es corta, completa y
 * ordenada, y el número total viaja para que el cliente sepa si falta algo.
 */
export interface CatalogBrowseCriteria {
  /** Fecha en la que el concepto debe estar vigente. Una parroquia retirada
   * no se ofrece para elegir hoy, igual que en la búsqueda. */
  on: Date;
  limit: number;
  offset: number;
}

/** Un tramo del catálogo y cuántos hay en total, para poder pedir el resto. */
export interface CatalogPage {
  items: readonly CatalogConcept[];
  total: number;
}

export interface CatalogRepository {
  search(criteria: CatalogSearchCriteria): Promise<readonly CatalogConcept[]>;

  /**
   * Los conceptos de primer nivel de un catálogo: las 24 provincias del DPA,
   * los capítulos de la CIE-10, los 249 países.
   *
   * `parent_id IS NULL` y no «nivel 0», porque el nivel es un atributo del
   * archivo importado y el padre es la relación de verdad. En un catálogo
   * plano las raíces son la lista entera, que es justo lo que hace falta para
   * un desplegable de países.
   */
  rootsOf(
    systemCode: string,
    criteria: CatalogBrowseCriteria,
  ): Promise<CatalogPage>;

  /** Los hijos directos de un concepto: los cantones de una provincia. */
  childrenOf(
    parentId: string,
    criteria: CatalogBrowseCriteria,
  ): Promise<CatalogPage>;

  /**
   * Un concepto por su código, para resolver lo que ya está guardado.
   *
   * Separado de la búsqueda porque la pregunta es distinta: aquí el código se
   * conoce y lo que importa es la vigencia en una fecha concreta.
   */
  findByCode(
    systemCode: string,
    code: string,
    on: Date,
  ): Promise<CatalogConcept | null>;

  /**
   * Un concepto por su identificador, para poner nombre a una referencia ya
   * guardada.
   *
   * SIN FECHA Y SIN SISTEMA, y las dos ausencias son deliberadas. Quien llama
   * tiene una clave foránea en la mano —`site.parish_concept_id`— y lo único
   * que le falta es cómo se llama. Exigirle la fecha de vigencia convertiría
   * la retirada de una parroquia del DPA en una pantalla que deja de decir
   * dónde está la sede; exigirle el sistema le obligaría a saber de qué
   * catálogo salió el id que le dieron.
   *
   * Por eso tampoco pasa por `resolveDiagnosis`: aquella pregunta es «¿puedo
   * registrar esto HOY?» y responde que no a un código retirado, que es
   * exactamente lo correcto allí y exactamente lo contrario de lo que hace
   * falta aquí.
   */
  findById(id: string): Promise<CatalogConcept | null>;

  /**
   * Si el código existió ALGUNA VEZ, sin mirar en qué periodo.
   *
   * Es lo que separa «se tecleó mal» de «existió, pero no en esa fecha», y por
   * eso es una pregunta propia y no `findByCode` con una fecha muy antigua:
   * esa fecha tendría que ser anterior al `valid_from` de todo concepto del
   * catálogo, y no hay ninguna que lo garantice. Devuelve un booleano porque
   * es lo único que hace falta para elegir el mensaje.
   */
  existsInAnyPeriod(systemCode: string, code: string): Promise<boolean>;

  /** La cadena de ancestros, de capítulo a padre inmediato. */
  ancestorsOf(id: string): Promise<readonly CatalogConcept[]>;
}

export const CATALOG_REPOSITORY = Symbol('CatalogRepository');
