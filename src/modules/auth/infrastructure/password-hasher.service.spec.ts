import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import {
  PASSWORD_HASHING,
  UNUSABLE_PASSWORD_HASH,
} from '../domain/password-hashing';

import { PasswordHasher } from './password-hasher.service';

/**
 * AU-001 — «almacenar las contraseñas con Argon2id y NO DEBERÁ poder
 * recuperarlas en claro».
 *
 * ESTE ADAPTADOR NO TENÍA NINGUNA PRUEBA. Es el único sitio del sistema donde
 * se decide cómo se guarda una contraseña, y de él dependen tres propiedades
 * que ninguna otra prueba mira: que el algoritmo sea el que dice la política,
 * que el resultado no permita volver al texto, y que un hash corrupto se lea
 * como «contraseña incorrecta» en vez de reventar. Las pruebas de sesión
 * usaban un doble del puerto, así que verificaban la lógica de arriba con el
 * hasher sustituido — exactamente donde vive el requisito.
 *
 * SIN DOBLES AQUÍ: se llama a argon2 de verdad. Un doble de la librería que
 * hashea demostraría que el doble hashea.
 */
describe('AU-001 el almacenamiento de contraseñas', () => {
  const hasher = new PasswordHasher();
  const PASSWORD = 'el caballo come alfalfa';

  it('AU-001 hashea con Argon2id y con los parámetros que declara la política', async () => {
    const hash = await hasher.hash(PASSWORD);

    /**
     * La codificación PHC lleva dentro el algoritmo y su coste, y se
     * comprueban leyéndolos del hash y no de la constante: afirmar que la
     * constante vale lo que vale no comprueba que se haya USADO. `argon2i`
     * y `argon2d` empiezan igual hasta la `d`/`i` final, así que el prefijo
     * se afirma entero.
     */
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(`m=${PASSWORD_HASHING.memoryCost}`);
    expect(hash).toContain(`t=${PASSWORD_HASHING.timeCost}`);
    expect(hash).toContain(`p=${PASSWORD_HASHING.parallelism}`);
  });

  it('AU-001 no deja recuperar el texto en claro desde el hash', async () => {
    const hash = await hasher.hash(PASSWORD);

    // Ni entero ni por partes: un hash que contuviera cualquier fragmento
    // legible sería un filtrado, no un resumen.
    expect(hash).not.toContain(PASSWORD);
    for (const palabra of PASSWORD.split(' ')) {
      expect(hash).not.toContain(palabra);
    }
  });

  it('AU-001 dos veces la misma contraseña dan hashes distintos', async () => {
    // La sal va dentro. Sin ella, dos personas con la misma contraseña
    // comparten fila en una tabla precalculada, y quien lea la base ve de un
    // vistazo quiénes repiten contraseña.
    const [uno, otro] = await Promise.all([
      hasher.hash(PASSWORD),
      hasher.hash(PASSWORD),
    ]);

    expect(uno).not.toEqual(otro);
    expect(await hasher.verify(uno, PASSWORD)).toBe(true);
    expect(await hasher.verify(otro, PASSWORD)).toBe(true);
  });

  it('AU-001 acepta la contraseña correcta y rechaza la que no lo es', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(await hasher.verify(hash, PASSWORD)).toBe(true);
    expect(await hasher.verify(hash, 'el caballo come alfalf')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('AU-002 un hash corrupto se lee como contraseña incorrecta, no como avería', async () => {
    /**
     * Pertenece a AU-002 tanto como a AU-001: si una fila estropeada lanzara,
     * la respuesta dejaría de ser `INVALID_CREDENTIALS` y pasaría a ser un
     * 500 — que le dice a quien prueba correos que ESA cuenta existe y tiene
     * algo distinto a las demás.
     */
    for (const roto of ['', 'no-es-un-hash', '$argon2id$sin-sentido']) {
      expect(await hasher.verify(roto, PASSWORD)).toBe(false);
    }
  });

  it('AU-021 la credencial inutilizable no la valida ninguna contraseña', async () => {
    // El marcador con el que nace una cuenta antes de aceptar su invitación.
    // No es un hash de Argon2, así que `verify` cae por la rama de arriba —
    // y esa es justamente la garantía de que la cuenta no puede entrar.
    expect(await hasher.verify(UNUSABLE_PASSWORD_HASH, PASSWORD)).toBe(false);
    expect(await hasher.verify(UNUSABLE_PASSWORD_HASH, '')).toBe(false);
    expect(UNUSABLE_PASSWORD_HASH.startsWith('$argon2')).toBe(false);
  });

  it('AU-001 pide rehash cuando el hash trae parámetros más flojos', async () => {
    /**
     * Subir el coste cuando el hardware barato mejora es la razón de existir
     * de `needsRehash`, y la de que los parámetros viajen DENTRO del hash. Se
     * comprueba con un hash de verdad producido con parámetros bajos —no con
     * una cadena inventada—, porque lo que se afirma es que la comparación lee
     * el coste real y no cualquier otra cosa.
     */
    const flojo = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: PASSWORD_HASHING.memoryCost / 2,
      timeCost: PASSWORD_HASHING.timeCost,
      parallelism: PASSWORD_HASHING.parallelism,
    });

    expect(hasher.needsRehash(flojo)).toBe(true);
    // Y uno hecho con los parámetros vigentes se deja en paz: rehashear en
    // cada inicio de sesión sería pagar Argon2 dos veces por nada.
    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
    // Un hash ilegible fuerza el rehash en vez de conservarse tal cual.
    expect(hasher.needsRehash('no-es-un-hash')).toBe(true);
  });

  it('AU-002 quemar tiempo cuesta trabajo de verdad, sin comparar nada', async () => {
    // Es lo que iguala el tiempo de respuesta de un correo inexistente. Si se
    // convirtiera en un `return` vacío, el oráculo de temporización vuelve y
    // ninguna prueba de `AuthService` lo notaría: allí es un doble.
    const inicio = process.hrtime.bigint();
    await hasher.burnTime();
    const nanos = Number(process.hrtime.bigint() - inicio);

    // Un umbral flojo a propósito: lo que se afirma es que hay trabajo, no
    // cuánto. Una máquina cargada no puede hacer fallar esto.
    expect(nanos).toBeGreaterThan(1_000_000);
  });
});
