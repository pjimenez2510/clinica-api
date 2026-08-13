import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../../shared/http/auth.decorators';

import { CatalogsService } from './application/catalogs.service';
import {
  CatalogCodePathDto,
  CatalogConceptDetailDto,
  CatalogPathDto,
  CatalogSearchResultDto,
  ResolveCatalogDto,
  catalogSystemSchema,
  // NO `import type`: un DTO de parámetros TIENE que llegar a tiempo de
  // ejecución. Con `type` la clase se borra al compilar, `design:paramtypes`
  // emite `Object`, y Swagger documenta el endpoint SIN sus parámetros —
  // `openapi-typescript` los tipa entonces como `never` y el frontend no puede
  // ni pasarlos. Silencioso de principio a fin: compila, arranca y responde.
  SearchCatalogDto,
  type CatalogConceptDetailResponse,
  type CatalogSearchResponse,
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
   *
   * `@ApiParam` con la lista cerrada pone esa lista TAMBIÉN en el documento
   * OpenAPI, no sólo en la validación. Sin él Swagger describe `system` como un
   * `string` cualquiera, y el tipo generado en el frontend no impide escribir
   * `'CIE-10'` o `'cnmb'`: el fallo llegaría como un 422 en tiempo de ejecución
   * en vez de como un error al compilar. El contrato es el documento.
   */
  @ApiParam({ name: 'system', enum: catalogSystemSchema.options })
  @Get(':system')
  @RequirePermission('catalog:read', 'global')
  @ApiOperation({ summary: 'Search a clinical catalogue' })
  @ApiOkResponse({ type: CatalogSearchResultDto })
  async search(
    @Param() params: CatalogPathDto,
    @Query() query: SearchCatalogDto,
  ): Promise<CatalogSearchResponse> {
    const items = await this.catalogs.search({
      systemCode: params.system,
      query: query.q,
      on: query.on ? new Date(`${query.on}T00:00:00Z`) : undefined,
      onlySelectable: !query.includeGroups,
      limit: query.limit,
    });

    return { items };
  }

  /**
   * Un concepto por su identificador, para poner nombre a lo ya guardado.
   *
   * DECLARADA ANTES QUE `:system/:code` A PROPÓSITO. NestJS registra las rutas
   * en el orden en que aparecen los métodos, y `/catalogs/concepts/<uuid>`
   * encaja también en `:system/:code`: si aquella fuera primero, `concepts`
   * llegaría como sistema, fallaría contra la lista cerrada y esta ruta
   * respondería 422 sin haberse ejecutado nunca. El orden es la garantía, así
   * que moverla de sitio la rompe en silencio — y hay una prueba que lo
   * detecta.
   *
   * `concepts` y no un segundo `:algo` porque un segmento fijo no puede chocar
   * con un código de catálogo futuro.
   *
   * SIN FECHA DE VIGENCIA: ver `CatalogsService.byId`. Quien pregunta tiene una
   * clave foránea, no un código que esté eligiendo.
   */
  @Get('concepts/:id')
  @RequirePermission('catalog:read', 'global')
  @ApiOperation({ summary: 'Resolve one stored concept by its id' })
  @ApiOkResponse({ type: CatalogConceptDetailDto })
  async byId(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogConceptDetailResponse> {
    const concepto = await this.catalogs.byId(id);

    return {
      ...concepto,
      ancestors: await this.catalogs.ancestorsOf(concepto.id),
    };
  }

  /**
   * Un concepto con su cadena de ancestros.
   *
   * Sirve para dos cosas: comprobar que un código tecleado es válido antes de
   * guardarlo, y mostrar dónde encaja — «J30.1, dentro de Rinitis alérgica,
   * dentro de Enfermedades del sistema respiratorio».
   */
  @ApiParam({ name: 'system', enum: catalogSystemSchema.options })
  @Get(':system/:code')
  @RequirePermission('catalog:read', 'global')
  @ApiOperation({ summary: 'Resolve one code and its ancestors' })
  @ApiOkResponse({ type: CatalogConceptDetailDto })
  async byCode(
    @Param() params: CatalogCodePathDto,
    @Query() query: ResolveCatalogDto,
  ): Promise<CatalogConceptDetailResponse> {
    const concepto = await this.catalogs.resolveDiagnosis(
      params.system,
      params.code,
      query.on ? new Date(`${query.on}T00:00:00Z`) : undefined,
    );

    return {
      ...concepto,
      ancestors: await this.catalogs.ancestorsOf(concepto.id),
    };
  }
}
