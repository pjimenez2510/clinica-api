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
  items: z.array(catalogConceptSchema),
});
export class CatalogSearchResultDto extends createZodDto(
  catalogSearchResultSchema,
) {}

export const catalogConceptDetailSchema = catalogConceptSchema.extend({
  /** De capítulo a padre inmediato, para situar el código en su rama. */
  ancestors: z.array(catalogConceptSchema),
});
export class CatalogConceptDetailDto extends createZodDto(
  catalogConceptDetailSchema,
) {}
