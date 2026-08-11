import { Inject, Injectable } from '@nestjs/common';

import {
  CatalogConceptNotFoundError,
  CatalogConceptNotInForceError,
  CatalogConceptNotSelectableError,
} from '../domain/catalog.errors';
import {
  CATALOG_REPOSITORY,
  type CatalogConcept,
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
      limit: params.limit ?? 20,
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
      const enCualquierFecha = await this.catalog.findByCode(
        systemCode,
        code,
        new Date('1900-01-01T00:00:00Z'),
      );
      if (enCualquierFecha) throw new CatalogConceptNotInForceError(code, on);
      throw new CatalogConceptNotFoundError(systemCode, code);
    }

    if (!concepto.selectable) {
      throw new CatalogConceptNotSelectableError(concepto.code);
    }

    return concepto;
  }

  /** La cadena de ancestros, para mostrar dónde encaja un código. */
  async ancestorsOf(id: string): Promise<readonly CatalogConcept[]> {
    return this.catalog.ancestorsOf(id);
  }
}
