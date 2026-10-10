import { describe, expect, it } from 'vitest';

import { splitPair, splitRegistryName } from './registry-name';

describe('the SRI registry name, split by the order of the cedula', () => {
  it('IL-005 puts the two surnames first and the names after them', () => {
    expect(splitRegistryName('GUAMAN QUISPE MARIA JOSE')).toEqual({
      familyName: 'GUAMAN',
      secondFamilyName: 'QUISPE',
      givenName: 'MARIA',
      secondGivenName: 'JOSE',
    });
  });

  it('IL-005 keeps «DE LA TORRE» as one surname and «DE LOS ANGELES» with its name', () => {
    expect(splitRegistryName('DE LA TORRE ALBA MARIA DE LOS ANGELES')).toEqual({
      familyName: 'DE LA TORRE',
      secondFamilyName: 'ALBA',
      givenName: 'MARIA',
      secondGivenName: 'DE LOS ANGELES',
    });
  });

  it('IL-005 reads three words as both surnames and one name', () => {
    expect(splitRegistryName('  PEREZ   LOPEZ JUAN ')).toEqual({
      familyName: 'PEREZ',
      secondFamilyName: 'LOPEZ',
      givenName: 'JUAN',
      secondGivenName: null,
    });
  });

  it('IL-005 reads two words as a surname and a name, and one as a surname', () => {
    expect(splitRegistryName('PEREZ JUAN')).toMatchObject({
      familyName: 'PEREZ',
      secondFamilyName: null,
      givenName: 'JUAN',
    });
    expect(splitRegistryName('PEREZ')).toEqual({
      familyName: 'PEREZ',
      secondFamilyName: null,
      givenName: null,
      secondGivenName: null,
    });
  });

  it('IL-005 joins every name past the third word into the second name', () => {
    expect(
      splitRegistryName('VERA MORA ANA LUCIA ISABEL').secondGivenName,
    ).toBe('LUCIA ISABEL');
  });

  it('IL-005 keeps a trailing particle with the last word', () => {
    expect(splitRegistryName('MORA DE')).toMatchObject({
      familyName: 'MORA DE',
    });
  });
});

describe('a pair of surnames or of names written in one string', () => {
  it('IL-005 splits at the first word, keeping its particles', () => {
    expect(splitPair('DE LA TORRE ALBA')).toEqual(['DE LA TORRE', 'ALBA']);
    expect(splitPair('MARIA DE LOS ANGELES')).toEqual([
      'MARIA',
      'DE LOS ANGELES',
    ]);
    expect(splitPair('ANA')).toEqual(['ANA', null]);
    expect(splitPair(undefined)).toEqual([null, null]);
  });
});
