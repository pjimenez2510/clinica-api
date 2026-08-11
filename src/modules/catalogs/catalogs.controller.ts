import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../../shared/http/auth.decorators';

import { CatalogsService } from './application/catalogs.service';
import {
  CatalogConceptDetailDto,
  CatalogSearchResultDto,
  catalogSystemSchema,
  type SearchCatalogDto,
} from './dto/catalog.dto';

/**
 * Consulta de catálogos clínicos.
 *
 * `catalog:read` y ámbito global. Un catálogo NO es dato de paciente: es una
 * lista pública de códigos de enfermedad, igual en todas las sedes. Pedir un
 * permiso por sede aquí sería confundir el código con quien lo tiene.
 *
 * Sí exige sesión, y no por el contenido: sin autenticación sería un endpoint
 * abierto que cualquiera puede usar para medir la instalación.
 */
@ApiTags('catalogs')
@Controller({ path: 'catalogs', version: '1' })
export class CatalogsController {
  constructor(private readonly catalogs: CatalogsService) {}

  /**
   * Busca en un catálogo por código o por descripción.
   *
   * El código va en la RUTA y no en la consulta porque identifica el recurso:
   * `/catalogs/CIE10` es un catálogo distinto de `/catalogs/CNMB`, no el mismo
   * filtrado.
   */
  @Get(':system')
  @RequirePermission('catalog:read', 'global')
  @ApiOperation({ summary: 'Search a clinical catalogue' })
  @ApiOkResponse({ type: CatalogSearchResultDto })
  async search(
    @Param('system') system: string,
    @Query() query: SearchCatalogDto,
  ): Promise<unknown> {
    const items = await this.catalogs.search({
      // Validado contra la lista cerrada, no aceptado tal cual: un parámetro de
      // ruta es texto libre y acaba en una consulta.
      systemCode: catalogSystemSchema.parse(system.toUpperCase()),
      query: query.q,
      on: query.on ? new Date(`${query.on}T00:00:00Z`) : undefined,
      onlySelectable: !query.includeGroups,
      limit: query.limit,
    });

    return { items };
  }

  /**
   * Un concepto con su cadena de ancestros.
   *
   * Sirve para dos cosas: comprobar que un código tecleado es válido antes de
   * guardarlo, y mostrar dónde encaja — «J30.1, dentro de Rinitis alérgica,
   * dentro de Enfermedades del sistema respiratorio».
   */
  @Get(':system/:code')
  @RequirePermission('catalog:read', 'global')
  @ApiOperation({ summary: 'Resolve one code and its ancestors' })
  @ApiOkResponse({ type: CatalogConceptDetailDto })
  async byCode(
    @Param('system') system: string,
    @Param('code') code: string,
    @Query('on') on?: string,
  ): Promise<unknown> {
    const concepto = await this.catalogs.resolveDiagnosis(
      catalogSystemSchema.parse(system.toUpperCase()),
      code,
      on ? new Date(`${on}T00:00:00Z`) : undefined,
    );

    return {
      ...concepto,
      ancestors: await this.catalogs.ancestorsOf(concepto.id),
    };
  }
}

/**
 * El catálogo pedido, validado contra la lista cerrada.
 *
 * Zod lanza aquí, y el filtro lo traduce a 422 con el mensaje del esquema. La
 * alternativa —aceptar cualquier texto— haría que un nombre inventado
 * devolviera una lista vacía, indistinguible de un catálogo sin datos.
 */
