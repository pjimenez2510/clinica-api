import { describe, expect, it } from 'vitest';

import { splitPair, splitRegistryName } from './registry-name';

describe('the SRI registry name, split by the order of the cedula', () => {
  it('IL-005 puts the two surnames first and the names after them', () => {
    expect(splitRegistryName('GUAMAN QUISPE MARIA JOSE')).toEqual({
      familyName: 'Guaman',
      secondFamilyName: 'Quispe',
      givenName: 'Maria',
      secondGivenName: 'Jose',
    });
  });

  it('IL-005 keeps «DE LA TORRE» as one surname and «DE LOS ANGELES» with its name', () => {
    expect(splitRegistryName('DE LA TORRE ALBA MARIA DE LOS ANGELES')).toEqual({
      familyName: 'De la Torre',
      secondFamilyName: 'Alba',
      givenName: 'Maria',
      secondGivenName: 'De los Angeles',
    });
  });

  it('IL-005 reads three words as both surnames and one name', () => {
    expect(splitRegistryName('  PEREZ   LOPEZ JUAN ')).toEqual({
      familyName: 'Perez',
      secondFamilyName: 'Lopez',
      givenName: 'Juan',
      secondGivenName: null,
    });
  });

  it('IL-005 reads two words as a surname and a name, and one as a surname', () => {
    expect(splitRegistryName('PEREZ JUAN')).toMatchObject({
      familyName: 'Perez',
      secondFamilyName: null,
      givenName: 'Juan',
    });
    expect(splitRegistryName('Perez')).toEqual({
      familyName: 'Perez',
      secondFamilyName: null,
      givenName: null,
      secondGivenName: null,
    });
  });

  it('IL-005 joins every name past the third word into the second name', () => {
    expect(
      splitRegistryName('VERA MORA ANA LUCIA ISABEL').secondGivenName,
    ).toBe('Lucia Isabel');
  });

  it('IL-005 keeps a trailing particle with the last word', () => {
    expect(splitRegistryName('Mora de')).toMatchObject({
      familyName: 'Mora de',
    });
  });
});

describe('a pair of surnames or of names written in one string', () => {
  it('IL-005 splits at the first word, keeping its particles', () => {
    expect(splitPair('DE LA TORRE ALBA')).toEqual(['De la Torre', 'Alba']);
    expect(splitPair('MARIA DE LOS ANGELES')).toEqual([
      'Maria',
      'De los Angeles',
    ]);
    expect(splitPair('Ana')).toEqual(['Ana', null]);
    expect(splitPair(undefined)).toEqual([null, null]);
  });
});
