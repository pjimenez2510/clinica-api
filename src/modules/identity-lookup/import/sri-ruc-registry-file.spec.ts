import { describe, expect, it } from 'vitest';

import { Cedula } from '../../../shared/domain/value-objects/cedula.vo';

import {
  RegistryHeaderError,
  detectEncoding,
  readHeader,
  readRow,
  splitLine,
} from './sri-ruc-registry-file';

/** Synthetic cedulas with a computed check digit; never a real person's. */
const CEDULA = '1710034065';
const OTHER = '0926687856';
const isCedula = (digits: string) => Cedula.isValid(digits);

describe('reading a file of the SRI RUC registry', () => {
  it('IL-009 finds the columns by name, whatever the delimiter and the order', () => {
    expect(readHeader('NUMERO_RUC|RAZON_SOCIAL|TIPO_CONTRIBUYENTE')).toEqual({
      delimiter: '|',
      ruc: 0,
      name: 1,
      type: 2,
    });
    expect(readHeader('\uFEFF"Provincia";"Apellidos Nombres";"RUC"')).toEqual({
      delimiter: ';',
      ruc: 2,
      name: 1,
      type: null,
    });
    expect(readHeader('RUC\tRazón social').delimiter).toBe('\t');
  });

  it('IL-009 refuses a file whose header lacks the RUC or the name', () => {
    expect(() => readHeader('NUMERO_RUC,ACTIVIDAD')).toThrow(
      RegistryHeaderError,
    );
  });

  it('IL-009 keeps a natural person with only the cedula and the name', () => {
    const columns = readHeader(
      'NUMERO_RUC|RAZON_SOCIAL|ACTIVIDAD|TIPO_CONTRIBUYENTE',
    );
    expect(readRow(`${CEDULA}001|  MORA   VERA ANA |VENTA AL POR MENOR|PERSONA NATURAL`, columns, isCedula)).toEqual({ kept: { cedula: CEDULA, registryName: 'MORA VERA ANA' } }); // prettier-ignore
  });

  it('IL-009 drops companies, establishments other than 001, bad check digits and blank names', () => {
    const typed = readHeader('NUMERO_RUC|RAZON_SOCIAL|TIPO_CONTRIBUYENTE');
    expect(readRow(`${OTHER}001|EMPRESA SA|SOCIEDAD`, typed, isCedula)).toEqual({ skipped: 'NOT_A_NATURAL_PERSON' }); // prettier-ignore

    const untyped = readHeader('NUMERO_RUC|RAZON_SOCIAL');
    expect(readRow('1790012345001|EMPRESA SA', untyped, isCedula)).toEqual({ skipped: 'INVALID_RUC' }); // prettier-ignore
    expect(readRow(`${CEDULA}002|MORA ANA`, untyped, isCedula)).toEqual({ skipped: 'INVALID_RUC' }); // prettier-ignore
    expect(readRow('1710034066001|MORA ANA', untyped, isCedula)).toEqual({ skipped: 'INVALID_RUC' }); // prettier-ignore
    expect(readRow(`${CEDULA}001|   `, untyped, isCedula)).toEqual({
      skipped: 'NO_NAME',
    });
  });

  it('IL-009 drops a name field with control characters, digits or markup, and keeps a real one', () => {
    const untyped = readHeader('NUMERO_RUC|RAZON_SOCIAL');
    expect(readRow(`${CEDULA}001|MORA <b>ANA</b>`, untyped, isCedula)).toEqual({ skipped: 'NO_NAME' }); // prettier-ignore
    expect(readRow(`${CEDULA}001|MORA ANA 2`, untyped, isCedula)).toEqual({ skipped: 'NO_NAME' }); // prettier-ignore
    // A real name with a tilde, apostrophe or hyphen is kept.
    expect(readRow(`${CEDULA}001|O'CONNOR MUÑOZ ANA-MARÍA`, untyped, isCedula)).toEqual({ kept: { cedula: CEDULA, registryName: "O'CONNOR MUÑOZ ANA-MARÍA" } }); // prettier-ignore
  });

  it('IL-009 reads quoted fields with the delimiter and a doubled quote inside', () => {
    expect(splitLine('"A,B","C ""D""",E', ',')).toEqual(['A,B', 'C "D"', 'E']);
  });

  it('IL-009 tells UTF-8 from Latin-1, without tripping on a character cut by the sample', () => {
    expect(detectEncoding(new TextEncoder().encode('MUÑOZ'))).toBe('utf8');
    expect(detectEncoding(new TextEncoder().encode('MUÑ').subarray(0, 3))).toBe(
      'utf8',
    );
    expect(
      detectEncoding(Uint8Array.from([0x4d, 0x55, 0xd1, 0x4f, 0x5a])),
    ).toBe('latin1');
  });
});
