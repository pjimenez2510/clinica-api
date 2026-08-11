import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Ningún DTO de parámetros puede haberse borrado al compilar.
 *
 * EL FALLO QUE ESTO ATRAPA NO SE VE POR NINGÚN OTRO SITIO. Escribir
 *
 *     import { type SearchCatalogDto } from './dto/catalog.dto';
 *     async search(@Query() query: SearchCatalogDto) { … }
 *
 * en lugar de importar la clase como valor compila, arranca y responde
 * correctamente a `?q=neumonia`. Lo único que cambia es que TypeScript borra la
 * clase al emitir, `design:paramtypes` guarda `Object` en su lugar, y NestJS
 * documenta el endpoint SIN sus parámetros. Después `openapi-typescript` los
 * tipa como `never` en el frontend y la llamada no compila al otro lado — a
 * cinco pasos de la causa, y con el backend funcionando perfectamente.
 *
 * Ya pasó exactamente así con `GET /catalogs/:system`.
 *
 * Es la misma familia que dejó desaparecer `user` de la respuesta de refresco:
 * el contrato se degradó en silencio porque nada comprobaba el contrato. Este
 * test recorre TODOS los controladores, presentes y futuros, en vez de fijar
 * los endpoints de hoy — una lista escrita a mano se queda atrás justo en el
 * módulo nuevo, que es donde vuelve a ocurrir.
 */

/**
 * Índices del enum `RouteParamtypes` de NestJS.
 *
 * A mano y no importados: viven en `@nestjs/common/enums`, que es interno. Son
 * parte del formato en el que Nest guarda la metadata, así que un cambio de
 * numeración rompería este test de forma ruidosa, que es como debe romperse.
 */
const ENLACES_CON_CUERPO = { 3: '@Body()', 4: '@Query()' } as const;

/** Donde NestJS guarda qué decorador va en qué posición. */
const METADATA_ARGUMENTOS = '__routeArguments__';

interface EnlaceDeArgumento {
  index: number;
  /** La clave del decorador: `@Query('on')` la trae, `@Query()` no. */
  data?: string | object;
}

async function ficherosDeControladores(directorio: string): Promise<string[]> {
  const entradas = await readdir(directorio, { withFileTypes: true });
  const encontrados = await Promise.all(
    entradas.map(async (entrada) => {
      const ruta = join(directorio, entrada.name);
      if (entrada.isDirectory()) return ficherosDeControladores(ruta);
      return entrada.name.endsWith('.controller.ts') ? [ruta] : [];
    }),
  );
  return encontrados.flat();
}

describe('contrato de parámetros de las rutas', () => {
  it('ningún @Query() ni @Body() recibe un tipo borrado', async () => {
    /**
     * Desde el directorio de trabajo, que Vitest fija en la raíz del proyecto.
     *
     * NI `import.meta.dirname` NI `__dirname`, y no por gusto: este fichero se
     * compila a CommonJS —donde `import.meta` es un error de TypeScript— pero
     * Vitest lo ejecuta como ESM, donde `__dirname` no existe. Sólo `cwd()`
     * vale en los dos.
     */
    const ficheros = await ficherosDeControladores(
      resolve(process.cwd(), 'src'),
    );

    // Si el descubrimiento se rompiera, el test pasaría sin comprobar nada:
    // cero controladores es cero fallos.
    expect(ficheros.length).toBeGreaterThan(0);

    const borrados: string[] = [];

    for (const fichero of ficheros) {
      const modulo: Record<string, unknown> = await import(fichero);

      for (const exportado of Object.values(modulo)) {
        if (typeof exportado !== 'function') continue;
        const prototipo: object = exportado.prototype;
        if (prototipo == null) continue;

        for (const metodo of Object.getOwnPropertyNames(prototipo)) {
          if (metodo === 'constructor') continue;

          const enlaces = Reflect.getMetadata(
            METADATA_ARGUMENTOS,
            exportado,
            metodo,
          ) as Record<string, EnlaceDeArgumento> | undefined;
          if (!enlaces) continue;

          const tipos = Reflect.getMetadata(
            'design:paramtypes',
            prototipo,
            metodo,
          ) as unknown[] | undefined;
          if (!tipos) continue;

          for (const [clave, enlace] of Object.entries(enlaces)) {
            const tipoDecorador = Number(clave.split(':')[0]);
            const decorador =
              ENLACES_CON_CUERPO[
                tipoDecorador as keyof typeof ENLACES_CON_CUERPO
              ];
            if (!decorador) continue;

            // `@Query('on') on: string` pide UN parámetro suelto, no un
            // objeto: ahí `String` es lo correcto y no hay nada que borrar.
            if (enlace.data != null) continue;

            if (tipos[enlace.index] === Object) {
              borrados.push(
                `${exportado.name}.${metodo}: ${decorador} en la posición ${enlace.index} ` +
                  `llega como Object — impórtelo como valor, no con \`import type\``,
              );
            }
          }
        }
      }
    }

    expect(borrados).toEqual([]);
  });
});
