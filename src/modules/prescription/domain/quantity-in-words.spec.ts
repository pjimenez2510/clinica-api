import { describe, expect, it } from 'vitest';

import { MAX_SPELLABLE_QUANTITY, spellQuantity } from './quantity-in-words';

/**
 * PR-030. «Cantidad del medicamento en números y letras» — art. 5.c.v.
 *
 * ⚠️ THE CASES ARE ENUMERATED AND NOT SAMPLED, and the SPEC says why: Spanish
 * cardinals are irregular at eleven different places, and enumerating only the
 * ones somebody remembers is how «veinte y uno» gets printed on a legal
 * document. Every irregularity has a case here: the teens, the twenties with
 * their accents, `cien` versus `ciento`, the five irregular hundreds, `mil`
 * without `un`, and the apocope before `mil`.
 */
describe('la cantidad en letras', () => {
  it('PR-030 escribe los números de una cifra', () => {
    expect(spellQuantity(0)).toBe('cero');
    expect(spellQuantity(1)).toBe('uno');
    expect(spellQuantity(9)).toBe('nueve');
  });

  it('PR-030 escribe del diez al quince, que tienen nombre propio', () => {
    expect(spellQuantity(10)).toBe('diez');
    expect(spellQuantity(11)).toBe('once');
    expect(spellQuantity(15)).toBe('quince');
  });

  it('PR-030 escribe los adolescentes con la tilde de «dieciséis»', () => {
    expect(spellQuantity(16)).toBe('dieciséis');
    expect(spellQuantity(17)).toBe('diecisiete');
    expect(spellQuantity(19)).toBe('diecinueve');
  });

  it('PR-030 escribe los veintitantos en una sola palabra y con sus tildes', () => {
    // La forma de dos palabras —«veinte y uno»— es la que un desplegable mal
    // hecho produce, y es la que una inspección lee como error de redacción.
    expect(spellQuantity(20)).toBe('veinte');
    expect(spellQuantity(21)).toBe('veintiuno');
    expect(spellQuantity(22)).toBe('veintidós');
    expect(spellQuantity(26)).toBe('veintiséis');
    expect(spellQuantity(29)).toBe('veintinueve');
  });

  it('PR-030 separa con «y» a partir de treinta y sólo a partir de treinta', () => {
    expect(spellQuantity(30)).toBe('treinta');
    expect(spellQuantity(31)).toBe('treinta y uno');
    expect(spellQuantity(99)).toBe('noventa y nueve');
  });

  it('PR-030 distingue «cien» de «ciento»', () => {
    // «cien» solo cuando no le sigue nada. Es la regla que más se falla.
    expect(spellQuantity(100)).toBe('cien');
    expect(spellQuantity(101)).toBe('ciento uno');
    expect(spellQuantity(115)).toBe('ciento quince');
  });

  it('PR-030 escribe las centenas irregulares', () => {
    expect(spellQuantity(200)).toBe('doscientos');
    expect(spellQuantity(500)).toBe('quinientos');
    expect(spellQuantity(700)).toBe('setecientos');
    expect(spellQuantity(900)).toBe('novecientos');
    expect(spellQuantity(999)).toBe('novecientos noventa y nueve');
  });

  it('PR-030 escribe «mil» y nunca «un mil»', () => {
    expect(spellQuantity(1000)).toBe('mil');
    expect(spellQuantity(1001)).toBe('mil uno');
    expect(spellQuantity(1100)).toBe('mil cien');
  });

  it('PR-030 apocopa el «uno» delante de «mil»', () => {
    // «veintiún mil», no «veintiuno mil». En español el cardinal pierde la
    // vocal final delante del sustantivo que cuenta, y «mil» lo es.
    expect(spellQuantity(21_000)).toBe('veintiún mil');
    expect(spellQuantity(31_000)).toBe('treinta y un mil');
    expect(spellQuantity(201_000)).toBe('doscientos un mil');
    expect(spellQuantity(2000)).toBe('dos mil');
  });

  it('PR-030 escribe la cantidad ordinaria de una receta', () => {
    // Lo que de verdad se receta: veinte tabletas, treinta cápsulas, un frasco.
    expect(spellQuantity(20)).toBe('veinte');
    expect(spellQuantity(30)).toBe('treinta');
    expect(spellQuantity(1)).toBe('uno');
  });

  it('PR-030 lee los decimales dígito a dígito después de «coma»', () => {
    // «uno y medio» significa cosas distintas según qué se cuente; «uno coma
    // cinco» no. Y el cero final se cae, porque `Decimal(10,2)` lo escribe.
    expect(spellQuantity(1.5)).toBe('uno coma cinco');
    expect(spellQuantity(1.05)).toBe('uno coma cero cinco');
    expect(spellQuantity(0.25)).toBe('cero coma dos cinco');
  });

  it('PR-030 rechaza lo que no puede escribir, en vez de imprimir un hueco', () => {
    // Un documento que imprimiera «demasiado» donde la norma exige la cantidad
    // en letras sería una receta inválida que nada señaló.
    expect(() => spellQuantity(-1)).toThrow(RangeError);
    expect(() => spellQuantity(MAX_SPELLABLE_QUANTITY + 1)).toThrow(RangeError);
    expect(() => spellQuantity(Number.NaN)).toThrow(RangeError);
  });
});
