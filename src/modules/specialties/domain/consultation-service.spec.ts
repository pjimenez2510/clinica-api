import { describe, expect, it } from 'vitest';

import {
  consultationServiceCode,
  consultationServiceName,
} from './consultation-service';

describe('la prestación que nace con un tipo de atención', () => {
  it('SP-030 se llama «especialidad · tipo»', () => {
    expect(consultationServiceName('Medicina General', ' Control ')).toBe(
      'Medicina General · Control',
    );
  });

  it('SP-030 se codifica con las iniciales y el tipo, sin tildes, en 25 caracteres', () => {
    expect(consultationServiceCode('medicina-general', 'Primera vez')).toBe(
      'CONS-MG-PRIMERA-VEZ',
    );
    expect(consultationServiceCode('ginecologia-obstetricia', 'Ecografía obstétrica de control')).toHaveLength(25); // prettier-ignore
    expect(consultationServiceCode('pediatria', 'Niño sano', 3)).toBe(
      'CONS-P-NINO-SANO-3',
    );
  });

  it('SP-030 deja sitio al sufijo sin pasar de 25 ni acabar en guion', () => {
    const code = consultationServiceCode('medicina-familiar', 'Valoración geriátrica integral', 12); // prettier-ignore
    expect(code.length).toBeLessThanOrEqual(25);
    expect(code.endsWith('-12')).toBe(true);
    expect(code).not.toMatch(/--/);
  });
});
