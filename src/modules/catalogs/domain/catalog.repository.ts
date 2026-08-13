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
   */
  chapter: string | null;
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
  limit: number;
}

export interface CatalogRepository {
  search(criteria: CatalogSearchCriteria): Promise<readonly CatalogConcept[]>;

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
