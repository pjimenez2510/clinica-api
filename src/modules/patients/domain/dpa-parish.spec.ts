import { describe, expect, it } from 'vitest';

import { parishLocationOf } from './dpa-parish';

describe('where a DPA parish code sits', () => {
  it('PA-028 derives province and canton from the six-digit code', () => {
    // 170150: province 17 (Pichincha), canton 1701 (Quito).
    expect(parishLocationOf('170150')).toEqual({
      provinceCode: '17',
      cantonCode: '1701',
    });
  });

  it('PA-028 derives them for a canton whose file row names another one', () => {
    // Two rows of the INEC file declare a canton their own code contradicts —
    // parishes of Durán filed under Daule. The code wins, which is the whole
    // reason province and canton are not columns.
    expect(parishLocationOf('090850')).toEqual({
      provinceCode: '09',
      cantonCode: '0908',
    });
  });

  it('PA-028 invents no prefixes for a code that is not six digits', () => {
    // Slicing blindly would answer province "17" and canton "17" for a
    // two-digit input: a location that reads like a real one all the way to
    // the ministry.
    for (const code of ['17', '1701', '1701501', '17015a', '']) {
      expect(parishLocationOf(code), `for "${code}"`).toEqual({
        provinceCode: null,
        cantonCode: null,
      });
    }
  });
});
