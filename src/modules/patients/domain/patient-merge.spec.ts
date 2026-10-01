import { describe, expect, it } from 'vitest';

import { restOverlapNoticeOf } from './patient-merge';

describe('PA-062 el aviso de reposos solapados al fusionar', () => {
  it('PA-062 sin solapes no hay aviso', () => {
    expect(restOverlapNoticeOf(0)).toBeNull();
  });

  it('PA-062 dice cuántos reposos se solapan con una maternidad y qué hacer, en singular y en plural', () => {
    expect(restOverlapNoticeOf(1)).toBe(
      'La fusión junta 1 reposo que se solapa con una maternidad. Anule desde su atención el que no corresponda.',
    );
    expect(restOverlapNoticeOf(3)).toBe(
      'La fusión junta 3 reposos que se solapan con una maternidad. Anule desde su atención los que no correspondan.',
    );
  });
});
