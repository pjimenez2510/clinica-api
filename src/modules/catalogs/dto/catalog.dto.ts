import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * El contrato de los catálogos.
 *
 * Las respuestas son esquemas, no interfaces: el documento OpenAPI es de donde
 * `clinica-web` saca sus tipos, y una respuesta que Swagger no ve llega al otro
 * lado tipada como `never`.
 */

/**
 * Qué catálogos se pueden consultar.
 *
 * LISTA CERRADA y no texto libre. El nombre del sistema entra en una consulta,
 * y además obliga a decidir qué está expuesto: `CIE10` hoy, `CNMB` y `TARIFF`
 * cuando existan. Un `string` dejaría la puerta abierta a sondear qué otros
 * catálogos hay.
 */
export const catalogSystemSchema = z.enum(['CIE10', 'CNMB', 'TARIFF', 'DPA']);

/**
 * El catálogo pedido en la ruta, validado contra la lista cerrada.
 *
 * UN ESQUEMA Y NO UN `parse` DENTRO DEL MÉTODO. Llamar a `.parse()` a mano en
 * el cuerpo del controlador lanza un `ZodError` crudo, que el filtro de
 * problemas no reconoce —sólo traduce el que produce el pipe de validación— y
 * la respuesta acababa siendo un 500. Un catálogo mal escrito es un error del
 * cliente, no una avería del servidor: 500 despierta a quien esté de guardia y
 * ensucia los registros con excepciones que no son fallos.
 *
 * Se normaliza a mayúsculas antes de comprobar, para que `/catalogs/cie10`
 * funcione igual que `/catalogs/CIE10`: nadie escribe una URL a mano dos veces
 * de la misma forma.
 */
const sistemaEnRuta = z
  .string()
  .transform((valor) => valor.toUpperCase())
  .pipe(catalogSystemSchema);

export const catalogPathSchema = z.object({ system: sistemaEnRuta });
export class CatalogPathDto extends createZodDto(catalogPathSchema) {}

export const catalogCodePathSchema = z.object({
  system: sistemaEnRuta,
  code: z.string().min(1).max(20),
});
export class CatalogCodePathDto extends createZodDto(catalogCodePathSchema) {}

export const searchCatalogSchema = z.object({
  q: z
    .string({ error: 'Escriba un código o parte de la descripción' })
    .trim()
    .min(2, 'Escriba al menos 2 caracteres')
    .max(120),
  /**
   * Fecha de vigencia. Por defecto hoy.
   *
   * Existe porque una historia de hace tres años debe resolver sus diagnósticos
   * con el catálogo de ENTONCES: sin esto, un código retirado desde entonces
   * aparecería como inexistente en un documento médico-legal.
   */
  on: z.iso.date().optional(),
  /**
   * Incluir capítulos y grupos, que NO son diagnosticables.
   *
   * Por defecto no. Sirve para una pantalla de exploración del catálogo, nunca
   * para la caja de diagnóstico de una consulta.
   */
  includeGroups: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export class SearchCatalogDto extends createZodDto(searchCatalogSchema) {}

/**
 * La fecha con la que se resuelve UN código.
 *
 * Un esquema para un solo campo opcional, y no `@Query('on') on?: string`, que
 * es lo que había: un parámetro suelto no lo valida nadie —`on=cualquierCosa`
 * llegaba hasta un `new Date()` y de ahí a la consulta como fecha inválida— y
 * además NestJS lo documenta como OBLIGATORIO, así que el tipo generado en el
 * frontend exigía pasarlo siempre.
 */
export const resolveCatalogSchema = z.object({
  on: z.iso.date().optional(),
});
export class ResolveCatalogDto extends createZodDto(resolveCatalogSchema) {}

export const catalogConceptSchema = z.object({
  id: z.uuid(),
  /** Con punto, como se lee y como se imprime: `J30.1`. */
  code: z.string(),
  display: z.string(),
  /** Capítulo al que pertenece, para desambiguar dos textos parecidos. */
  chapter: z.string().nullable(),
  level: z.number().int().nonnegative(),
  /**
   * Si puede registrarse como diagnóstico. Un capítulo (`A00-B99`) no puede:
   * es un título, y el RDACAA lo rechaza.
   */
  selectable: z.boolean(),
});
export class CatalogConceptDto extends createZodDto(catalogConceptSchema) {}

export const catalogSearchResultSchema = z.object({
  items: z.array(catalogConceptSchema).readonly(),
});
export class CatalogSearchResultDto extends createZodDto(
  catalogSearchResultSchema,
) {}

export const catalogConceptDetailSchema = catalogConceptSchema.extend({
  /** De capítulo a padre inmediato, para situar el código en su rama. */
  ancestors: z.array(catalogConceptSchema).readonly(),
});
export class CatalogConceptDetailDto extends createZodDto(
  catalogConceptDetailSchema,
) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type CatalogSearchResponse = z.infer<typeof catalogSearchResultSchema>;
export type CatalogConceptDetailResponse = z.infer<
  typeof catalogConceptDetailSchema
>;
