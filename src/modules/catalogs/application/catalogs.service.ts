import { Inject, Injectable } from '@nestjs/common';

import {
  CatalogConceptNotFoundError,
  CatalogConceptNotInForceError,
  CatalogConceptNotSelectableError,
} from '../domain/catalog.errors';
import {
  CATALOG_REPOSITORY,
  type CatalogConcept,
  type CatalogPage,
  type CatalogRepository,
} from '../domain/catalog.repository';

/**
 * Consultar catálogos y comprobar que un código puede usarse.
 *
 * NO SE AUDITA. Un catálogo es una lista pública de códigos de enfermedad: no
 * hay dato personal en «J30.1 Rinitis alérgica debida al polen». Lo que sí se
 * audita es la historia donde ese diagnóstico acaba escrito.
 */
@Injectable()
export class CatalogsService {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly catalog: CatalogRepository,
  ) {}

  async search(params: {
    systemCode: string;
    query: string;
    on?: Date;
    onlySelectable?: boolean;
    parentId?: string;
    limit?: number;
  }): Promise<readonly CatalogConcept[]> {
    return this.catalog.search({
      systemCode: params.systemCode,
      query: params.query,
      on: params.on ?? new Date(),
      // Por defecto SÓLO lo diagnosticable: quien busca en una caja de
      // diagnóstico no quiere ver títulos de capítulo, y ofrecérselos es
      // invitarle a registrar algo que el ministerio rechaza.
      onlySelectable: params.onlySelectable ?? true,
      /**
       * Sin rama, todo el catálogo.
       *
       * UNA RAMA INEXISTENTE DEVUELVE LISTA VACÍA, y no un 404. Es un FILTRO de
       * una búsqueda, no el recurso que se pide: quien navega el árbol tiene el
       * id del cantón que acaba de abrir, y responder 404 a una caja de texto
       * convertiría un filtro obsoleto en una pantalla de error.
       */
      parentId: params.parentId ?? null,
      limit: params.limit ?? 20,
    });
  }

  /**
   * Las raíces de un catálogo: las 24 provincias del DPA, los 249 países.
   *
   * NO COMPRUEBA QUE EL CATÁLOGO EXISTA porque no puede no existir: la lista
   * cerrada de `catalogSystemSchema` ya lo rechazó en el borde. Un catálogo
   * declarado y sin sembrar devuelve cero, que es la verdad.
   */
  async rootsOf(
    systemCode: string,
    params: { on?: Date; limit: number; offset: number },
  ): Promise<CatalogPage> {
    return this.catalog.rootsOf(systemCode, {
      on: params.on ?? new Date(),
      limit: params.limit,
      offset: params.offset,
    });
  }

  /**
   * Los hijos de un concepto: los cantones de una provincia, sus parroquias.
   *
   * SE COMPRUEBA ANTES QUE EL PADRE EXISTE, y esa consulta de más es lo único
   * que separa «este cantón no tiene parroquias» de «ese id no es nada». Las
   * dos respuestas son una lista vacía, y una parroquia —que es una hoja— tiene
   * cero hijos con toda legitimidad, así que sin la comprobación un id
   * caducado en la pantalla se vería igual que un nivel sin descendencia.
   *
   * `byId` es la que comprueba, y por tanto TAMPOCO exige vigencia al padre:
   * abrir una provincia retirada del DPA para ver qué colgaba de ella es una
   * pregunta legítima. La vigencia se aplica a los HIJOS, que son los que se
   * están ofreciendo para elegir.
   */
  async childrenOf(
    parentId: string,
    params: { on?: Date; limit: number; offset: number },
  ): Promise<CatalogPage> {
    await this.byId(parentId);

    return this.catalog.childrenOf(parentId, {
      on: params.on ?? new Date(),
      limit: params.limit,
      offset: params.offset,
    });
  }

  /**
   * Resuelve un código y comprueba que puede registrarse como diagnóstico.
   *
   * ES LA PUERTA QUE USARÁ LA CONSULTA CLÍNICA. Las tres respuestas negativas
   * son distintas a propósito, porque llevan a acciones distintas:
   *
   *   - no existe        → se tecleó mal
   *   - no vigente       → existió, pero no en esa fecha; hay que elegir otro
   *   - no seleccionable → es un capítulo; hay que bajar al código específico
   *
   * Devolver un 404 para las tres haría que la de en medio pareciera un error
   * del sistema sobre una historia antigua perfectamente válida.
   */
  async resolveDiagnosis(
    systemCode: string,
    code: string,
    on: Date = new Date(),
  ): Promise<CatalogConcept> {
    const concepto = await this.catalog.findByCode(systemCode, code, on);

    if (!concepto) {
      // Se distingue «no existe» de «existió pero no en esa fecha» buscando sin
      // restricción temporal. Cuesta una consulta más y sólo en el camino de
      // error, que es donde importa dar la razón correcta.
      //
      // ESTA CONSULTA IGNORA EL PERIODO; antes preguntaba por el 1 de enero de
      // 1900, y eso hacía la rama INALCANZABLE: ningún concepto de la CIE-10
      // está vigente en 1900, así que el `if` era siempre falso y un código
      // retirado respondía «no existe». Justo al revés de lo que hace falta
      // sobre una historia de hace tres años, que es el caso para el que se
      // escribió.
      const enCualquierFecha = await this.catalog.existsInAnyPeriod(
        systemCode,
        code,
      );
      if (enCualquierFecha) throw new CatalogConceptNotInForceError(code, on);
      throw CatalogConceptNotFoundError.byCode(systemCode, code);
    }

    if (!concepto.selectable) {
      throw new CatalogConceptNotSelectableError(concepto.code);
    }

    return concepto;
  }

  /**
   * Pone nombre a una referencia guardada.
   *
   * NO COMPRUEBA NI VIGENCIA NI SELECCIONABILIDAD, y por eso no reutiliza
   * `resolveDiagnosis`. Quien llama no está eligiendo un código: ya lo eligió
   * alguien, está guardado en una columna, y lo único que falta es cómo se
   * llama. `site.parish_concept_id` es el caso que lo motiva —la pantalla de
   * la sede decía «Registrada» porque no había forma de preguntar CUÁL— y
   * negarle el nombre a una parroquia retirada del DPA dejaría en blanco la
   * dirección de una sede que no ha cambiado de sitio.
   */
  async byId(id: string): Promise<CatalogConcept> {
    const concepto = await this.catalog.findById(id);
    if (!concepto) throw CatalogConceptNotFoundError.byId(id);
    return concepto;
  }

  /** La cadena de ancestros, para mostrar dónde encaja un código. */
  async ancestorsOf(id: string): Promise<readonly CatalogConcept[]> {
    return this.catalog.ancestorsOf(id);
  }
}
