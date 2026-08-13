import { z } from 'zod';

/**
 * Una bandera de consulta que SOLO enciende el literal `true`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO `z.coerce.boolean()`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un parámetro de consulta llega SIEMPRE como texto, y `z.coerce.boolean()`
 * aplica la veracidad de JavaScript: `Boolean('false')` es `true`, porque la
 * cadena no está vacía. Es decir, **la bandera no se puede apagar**. Escribir
 * `?flag=false` la enciende igual que `?flag=true`, y el cliente que la manda
 * explícitamente en `false` obtiene justo lo contrario de lo que pidió, sin
 * ningún error por ningún lado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ VIVE AQUÍ Y NO EN CADA MÓDULO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque ya se descubrió tres veces. `agenda`, `organization` y `auth` tenían
 * cada uno su copia de estas cuatro líneas con su propio comentario explicando
 * la misma trampa —y `catalogs` y `patients` seguían con la versión rota, que
 * es exactamente lo que pasa cuando un arreglo se copia en vez de compartirse:
 * el siguiente que escribe un DTO copia el módulo vecino equivocado.
 *
 * Lo que costaba de verdad:
 *
 *  - `catalogs`: la caja de diagnóstico manda `includeGroups=false` y recibía
 *    capítulos y grupos de la CIE-10 —`A00-B99` es un título, no una
 *    enfermedad—, que es precisamente el dato que el RDACAA rechaza. El
 *    comentario del esquema prometía «por defecto no» y hacía lo contrario.
 *  - `patients`: `includeMerged=false` devolvía las fichas FUSIONADAS, que son
 *    las que ya no deben usarse. Buscar un paciente ofrecía su historia muerta
 *    junto a la viva, sin distinguirlas.
 *
 * El texto de error va en español porque lo lee quien usa la API.
 */
export const explicitFlag = z
  .enum(['true', 'false'], { error: 'Indique verdadero o falso' })
  .default('false')
  .transform((value) => value === 'true');
