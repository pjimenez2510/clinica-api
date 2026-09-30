import { describe, expect, it } from 'vitest';

import {
  MAX_SPELLABLE_QUANTITY,
  OUTPATIENT_VALIDITY_DAYS,
  ageText,
  quantityText,
  routeText,
  spellQuantity,
} from './prescription-wording';

/**
 * The wording art. 5 of the Resolución ACESS-2023-0030 demands, exercised
 * without a clock and without a database.
 */

describe('DOC-072 la edad como la exige el art. 5.b.ii', () => {
  it('DOC-072 dice años y meses por debajo de los cinco años', () => {
    // The threshold is not a courtesy: a paediatric dose is milligrams per
    // kilogram, and «2 años» covers a range in which the correct dose of the
    // same syrup nearly doubles.
    expect(ageText(1, 2)).toBe('1 año 2 meses');
    expect(ageText(4, 11)).toBe('4 años 11 meses');
    expect(ageText(0, 1)).toBe('0 años 1 mes');
  });

  it('DOC-072 dice sólo años a partir de los cinco', () => {
    expect(ageText(5, 3)).toBe('5 años');
    expect(ageText(34, 7)).toBe('34 años');
  });

  it('DOC-072 no inventa una edad que nadie registró', () => {
    // NOT «0 años». A document asserting an age nobody recorded is worse than
    // one with a gap somebody notices.
    expect(ageText(null, null)).toBeNull();
  });

  it('DOC-072 imprime los años solos cuando no hay meses registrados', () => {
    expect(ageText(3, null)).toBe('3 años');
  });
});

describe('DOC-072 la cantidad en números y letras (art. 5.c.v)', () => {
  it('DOC-072 deletrea las decenas irregulares del español', () => {
    // These are the ones a naive composer gets wrong: single words with their
    // own accents, and the «y» that only appears from thirty upwards.
    expect(spellQuantity(16)).toBe('dieciséis');
    expect(spellQuantity(21)).toBe('veintiuno');
    expect(spellQuantity(22)).toBe('veintidós');
    expect(spellQuantity(30)).toBe('treinta');
    expect(spellQuantity(31)).toBe('treinta y uno');
    expect(spellQuantity(99)).toBe('noventa y nueve');
  });

  it('DOC-072 dice «cien» solo y «ciento» acompañado', () => {
    expect(spellQuantity(100)).toBe('cien');
    expect(spellQuantity(101)).toBe('ciento uno');
    expect(spellQuantity(115)).toBe('ciento quince');
    expect(spellQuantity(500)).toBe('quinientos');
    expect(spellQuantity(999)).toBe('novecientos noventa y nueve');
  });

  it('DOC-072 dice «mil» y nunca «uno mil»', () => {
    expect(spellQuantity(1000)).toBe('mil');
    expect(spellQuantity(1001)).toBe('mil uno');
    expect(spellQuantity(2000)).toBe('dos mil');
    expect(spellQuantity(12345)).toBe('doce mil trescientos cuarenta y cinco');
  });

  it('DOC-072 se niega a deletrear lo que no puede decir con honestidad', () => {
    // A gap is a visible defect; a wrong word on a legal document is not.
    expect(spellQuantity(-1)).toBeNull();
    expect(spellQuantity(2.5)).toBeNull();
    expect(spellQuantity(MAX_SPELLABLE_QUANTITY + 1)).toBeNull();
  });

  it('DOC-072 imprime la cifra Y la letra juntas, que es lo que pide la norma', () => {
    // The rule is a forgery control: a «2» becomes a «20» with one stroke of a
    // pen and «dos» does not.
    expect(quantityText(20)).toBe('20 (veinte)');
    expect(quantityText(null)).toBe('');
  });

  it('DOC-072 imprime la cifra sola cuando no hay letra posible', () => {
    expect(quantityText(1_500_000)).toBe('1500000');
  });
});

describe('DOC-074 la vía de administración, sin abreviaturas', () => {
  it('DOC-074 escribe «Vía oral» y nunca «VO»', () => {
    // Art. 13: an electronic prescription is issued «sin siglas o abreviaturas».
    expect(routeText('ORAL')).toBe('Vía oral');
    expect(routeText('INTRAMUSCULAR')).toBe('Vía intramuscular');
  });

  it('DOC-074 no imprime un código que no sabe nombrar', () => {
    // A code this system cannot name is a code it must not print: leaking a
    // database value onto a legal document is worse than an empty box.
    expect(routeText('SOMETHING_NEW')).toBeNull();
    expect(routeText(null)).toBeNull();
  });
});

describe('DOC-072 la vigencia derivada de los arts. 17 a 19', () => {
  it('DOC-072 son tres días, los de consulta externa', () => {
    // This clinic is ambulatory (A.M. 00030-2020, «centro de especialidades»),
    // so art. 18 applies. Emergency and hospitalisation are one day, and the
    // day either enters the portfolio this stops being a constant.
    expect(OUTPATIENT_VALIDITY_DAYS).toBe(3);
  });
});
