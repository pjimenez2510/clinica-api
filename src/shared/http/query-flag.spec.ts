import { describe, expect, it } from 'vitest';

import { explicitFlag } from './query-flag';

/**
 * La bandera que se puede APAGAR.
 *
 * Parece una prueba trivial y es la que faltaba cinco veces. `z.coerce.boolean()`
 * estaba en `catalogs` y en `patients`, y en los dos sitios el efecto era el
 * contrario del que promete el comentario del esquema — sin ningún error, sin
 * ninguna prueba en rojo, y con el cliente mandando `false` explícitamente.
 */
describe('explicitFlag', () => {
  it('`false` APAGA la bandera, que es lo que `z.coerce.boolean()` no hacía', () => {
    // `Boolean('false')` es `true`: la cadena no está vacía. Toda la prueba
    // existe por esta línea.
    expect(explicitFlag.parse('false')).toBe(false);
  });

  it('solo el literal `true` la enciende', () => {
    expect(explicitFlag.parse('true')).toBe(true);
  });

  it('ausente queda apagada: lo que no se pide no viaja', () => {
    expect(explicitFlag.parse(undefined)).toBe(false);
  });

  it('rechaza cualquier otra cosa en vez de adivinar', () => {
    // `1`, `sí`, `on` y la cadena vacía son formas de escribirlo que un cliente
    // podría inventar. Aceptarlas devolvería la adivinación por la puerta de
    // atrás; el 422 dice qué se espera.
    for (const raro of ['1', '0', 'sí', 'on', '', 'TRUE', 'False']) {
      expect(() => explicitFlag.parse(raro), raro).toThrow();
    }
  });

  it('el mensaje de rechazo lo lee una persona', () => {
    const resultado = explicitFlag.safeParse('quizá');

    expect(resultado.success).toBe(false);
    expect(resultado.error?.issues[0]?.message).toBe(
      'Indique verdadero o falso',
    );
  });
});
