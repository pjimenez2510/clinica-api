import { describe, expect, it } from 'vitest';

import { proposeServiceCode } from './service-code';

describe('the code proposed for a new service (BI-280)', () => {
  it('BI-280 proposes the prefix of the kind and the name in capitals, without accents', () => {
    expect(proposeServiceCode('LAB_EXAM', 'Glucosa en ayunas', new Set())).toBe(
      'LAB-GLUCOSA-EN-AYUNAS',
    );
    expect(
      proposeServiceCode(
        'CONSULTATION',
        'Consulta de cardiología · Control',
        new Set(),
      ),
    ).toBe('CONS-CARDIOLOGIA-CONTROL');
    expect(
      proposeServiceCode('SUPPLY', 'Gasa estéril (paquete)', new Set()),
    ).toBe('INS-GASA-ESTERIL-PAQUETE');
  });

  it('BI-280 never exceeds the 25 characters the SRI admits (BI-171)', () => {
    const code = proposeServiceCode(
      'PROCEDURE',
      'Aplicación de toxina botulínica con fin estético',
      new Set(),
    );
    expect(code.length).toBeLessThanOrEqual(25);
    expect(code.startsWith('PROC-APLICACION-DE')).toBe(true);
    expect(code.endsWith('-')).toBe(false);
  });

  it('BI-280 never proposes a code already taken: the first free suffix wins', () => {
    const taken = new Set(['PROC-SUTURA', 'PROC-SUTURA-2']);
    expect(proposeServiceCode('PROCEDURE', 'Sutura', taken)).toBe(
      'PROC-SUTURA-3',
    );
    // Control: free, it is the plain one.
    expect(proposeServiceCode('PROCEDURE', 'Sutura', new Set())).toBe(
      'PROC-SUTURA',
    );
  });

  it('BI-280 names something even when the name has no letter or digit', () => {
    expect(proposeServiceCode('OTHER', '···', new Set())).toBe('OTR-SERVICIO');
  });
});
