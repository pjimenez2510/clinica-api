import { describe, expect, it } from 'vitest';

import { invoiceDocumentNumber } from './document-number';

describe('invoiceDocumentNumber', () => {
  // 30/09/2026 · 01 · 1790001563001 · 1 · 001 002 · 000000123 · 00456789 · 1 · 7
  const KEY = '3009202601179000156300110010020000001230045678917';

  it('SRI-019 con clave, la serie y el secuencial salen de la clave aunque la sede cambie', () => {
    expect(
      invoiceDocumentNumber({
        accessKey: KEY,
        establishmentCode: '005',
        emissionPointCode: '009',
        sequential: '000000999',
      }),
    ).toBe('001-002-000000123');
  });

  it('SRI-070 sin clave, el código de la sede; sin código, ??? y nunca un 001 inventado', () => {
    const base = {
      accessKey: null,
      emissionPointCode: '002',
      sequential: '000000123',
    };
    expect(invoiceDocumentNumber({ ...base, establishmentCode: '003' })).toBe(
      '003-002-000000123',
    );
    expect(invoiceDocumentNumber({ ...base, establishmentCode: null })).toBe(
      '???-002-000000123',
    );
  });
});
