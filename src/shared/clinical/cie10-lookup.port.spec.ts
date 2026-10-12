import { describe, expect, it } from 'vitest';

import { candidateCodes } from './cie10-lookup.port';

describe('candidateCodes', () => {
  it('AS-035 reads a written code with or without its dot, in any case', () => {
    expect(candidateCodes('J02.9')).toEqual(['J02.9']);
    expect(candidateCodes(' j029 ')).toEqual(['J02.9']);
    expect(candidateCodes('i10.x')).toEqual(['I10.X']);
  });

  it('AS-035 tries a three-character category as itself and as its .X', () => {
    expect(candidateCodes('I10')).toEqual(['I10', 'I10.X']);
  });

  it('AS-035 anything that is not a CIE-10 shape yields nothing to look up', () => {
    for (const written of [
      '',
      'faringitis',
      'J0',
      'J02.95',
      '102.9',
      'J02.9; DROP',
    ]) {
      expect(candidateCodes(written)).toEqual([]);
    }
  });
});
