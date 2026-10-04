import { describe, expect, it } from 'vitest';

import { frozenDiagnoses } from './form-117-source';

describe('CER-027 la copia congelada de los diagnósticos, al leerla', () => {
  it('CER-027 lee la certeza que la emisión copió', () => {
    expect(
      frozenDiagnoses([
        {
          code: 'J00',
          display: 'Rinofaringitis aguda',
          certainty: 'DEFINITIVE',
        },
        { code: 'R50.9', display: 'Fiebre', certainty: 'PRESUMPTIVE' },
      ]),
    ).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda', certainty: 'DEFINITIVE' },
      { code: 'R50.9', display: 'Fiebre', certainty: 'PRESUMPTIVE' },
    ]);
  });

  it('CER-027 una copia anterior, sin certeza, la deja vacía: no la deduce', () => {
    expect(
      frozenDiagnoses([{ code: 'J00', display: 'Rinofaringitis aguda' }]),
    ).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda', certainty: null },
    ]);
  });

  it('CER-027 una certeza que no es del esquema no se imprime como si lo fuera', () => {
    expect(
      frozenDiagnoses([
        { code: 'J00', display: 'Rinofaringitis', certainty: 'SEGURO' },
      ]),
    ).toEqual([{ code: 'J00', display: 'Rinofaringitis', certainty: null }]);
  });

  it('CER-027 lo que no es una lista de diagnósticos no se lee como uno', () => {
    expect(frozenDiagnoses(null)).toEqual([]);
    expect(frozenDiagnoses([{ code: 'J00' }, 'J00'])).toEqual([]);
  });
});
