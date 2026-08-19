import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { explicitFlag } from '../../../shared/http/query-flag';

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
 *
 * LOS TRES ÚLTIMOS ENTRAN CON P2 DE `patients` (PA-026, PA-027, PA-029). El
 * modelo `CatalogSystem` ya los nombraba y la ficha ya tenía sus columnas; lo
 * que faltaba era esta lista, así que ni se podían sembrar ni leer y REQ-022
 * figuraba cubierto e incumplido a la vez. Son catálogos PLANOS —no tienen
 * capítulos ni grupos—, que es lo que obliga a que «seleccionable» dependa de
 * si el sistema es jerárquico y no de la profundidad; ver
 * `prisma-catalog.repository.ts`.
 *
 * `COUNTRY` ES EL PAÍS EMISOR DE UN DOCUMENTO, POR SU NOMBRE. La columna
 * `patient_identifier.issuing_country` guarda `ISO 3166-1 alpha-3` y sigue
 * guardándolo; lo que faltaba era de dónde saca la pantalla los 249 nombres,
 * porque el formulario venía pidiendo «código de tres letras: ECU, COL, VEN» y
 * en el mostrador nadie sabe el alpha-3 de un pasaporte. También PLANO: un país
 * no cuelga de nada.
 */
export const catalogSystemSchema = z.enum([
  'CIE10',
  'CNMB',
  'TARIFF',
  'DPA',
  'ETHNICITY',
  'NATIONALITY',
  'GENDER_IDENTITY',
  'COUNTRY',
]);

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
  includeGroups: explicitFlag,
  /**
   * Buscar SÓLO dentro de una rama del árbol.
   *
   * «Busca SANTA en este cantón» en vez de «busca SANTA en las 1401 parroquias
   * del país». Sin esto, acotar obliga al cliente a traerse el cantón entero y
   * filtrar en memoria — que es exactamente el trabajo que esta ruta existe
   * para no hacer en el navegador.
   *
   * Alcanza a TODA la descendencia y no sólo a los hijos: una parroquia es
   * nieta de una provincia, así que acotar por provincia con hijos directos
   * devolvería cantones y ninguna parroquia.
   */
  parentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export class SearchCatalogDto extends createZodDto(searchCatalogSchema) {}

/**
 * Recorrer el árbol por niveles: qué hay debajo de esto, y cuánto falta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ `pageSize` LLEGA A 500 CUANDO EL DE PACIENTES SE QUEDA EN 50
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque son listas de naturaleza distinta. El registro de pacientes crece sin
 * final y por eso se le pone un tope bajo; un nivel de un catálogo es una lista
 * CERRADA y corta, y el nodo más grande que existe de verdad son los 249 países
 * —la lista entera, porque un catálogo plano no tiene más nivel que sus
 * raíces— y las 65 parroquias del cantón Quito. Un tope de 50 obligaría a
 * paginar un desplegable de países en cinco viajes, o peor: a que el cliente se
 * quede con los cincuenta primeros sin darse cuenta.
 *
 * El valor por defecto sí es 100, y ése es el que protege del otro extremo: un
 * catálogo plano de miles de conceptos —la CNMB de medicamentos lo será— no
 * debe llegar entero por no haberlo pedido.
 */
export const browseCatalogSchema = z.object({
  /** Vigencia, igual que en la búsqueda: una parroquia retirada no se ofrece. */
  on: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export class BrowseCatalogDto extends createZodDto(browseCatalogSchema) {}

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
  /**
   * Capítulo al que pertenece, para desambiguar dos textos parecidos.
   *
   * EL CÓDIGO —`A00-B99`, `17`— que sigue viajando porque en la CIE-10 se
   * maneja: quien diagnostica lo dicta y lo teclea.
   */
  chapter: z.string().nullable(),
  /**
   * Cómo se llama ese capítulo: «Ciertas enfermedades infecciosas y
   * parasitarias», «Pichincha».
   *
   * ADR-005 §5: un código que quien lo lee no puede interpretar no es
   * información. `A00-B99` no desambigua nada, que es justo lo que el capítulo
   * está aquí para hacer. No se esconde el código, se le pone el nombre al
   * lado — y tiene que mandarlo el backend, porque la interfaz no puede
   * resolverlo sola. `null` si el catálogo es plano o si no hay fila de
   * capítulo que consultar.
   */
  chapterDisplay: z.string().nullable(),
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

/**
 * Un nivel del árbol, con el total para poder pedir el resto.
 *
 * EL `total` ES LA MITAD QUE FALTABA. La búsqueda devuelve como mucho 50 filas
 * y no dice cuántas hay: quien teclea «SANTA» sobre 1401 parroquias recibe un
 * puñado y no sabe si la suya está entre las que no cupieron. Aquí el cliente
 * sabe siempre si le falta algo y puede pedirlo.
 */
export const catalogPageSchema = z.object({
  items: z.array(catalogConceptSchema).readonly(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export class CatalogPageDto extends createZodDto(catalogPageSchema) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type CatalogSearchResponse = z.infer<typeof catalogSearchResultSchema>;
export type CatalogPageResponse = z.infer<typeof catalogPageSchema>;
export type CatalogConceptDetailResponse = z.infer<
  typeof catalogConceptDetailSchema
>;
