import { describe, expect, it } from 'vitest';

import { parseDocumentSearch } from './document-search';

describe('BI-233 la búsqueda de una factura o una nota de crédito', () => {
  it('BI-233 el número completo del papel es un número y nada más', () => {
    expect(parseDocumentSearch(' 001-002-123 ')).toEqual({
      kind: 'number',
      establishment: '001',
      emissionPoint: '002',
      sequential: '000000123',
    });
  });

  it('BI-233 unos dígitos son un secuencial o el principio de una identificación', () => {
    expect(parseDocumentSearch('123')).toEqual({
      kind: 'digits',
      sequential: '000000123',
      identificationPrefix: '123',
    });
    // A full cedula cannot be a nine-digit sequential.
    expect(parseDocumentSearch('1710034065')).toEqual({
      kind: 'digits',
      sequential: null,
      identificationPrefix: '1710034065',
    });
  });

  it('BI-233 lo demás es el nombre del comprador, y vacío no filtra', () => {
    expect(parseDocumentSearch('Guamán')).toEqual({
      kind: 'name',
      text: 'Guamán',
    });
    expect(parseDocumentSearch('   ')).toBeNull();
    expect(parseDocumentSearch(undefined)).toBeNull();
  });
});
