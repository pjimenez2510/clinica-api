import { describe, expect, it } from 'vitest';

import {
  pruneToAllowlist,
  sanitizeErrorMessage,
  sanitizeUrl,
} from './log-privacy';

/**
 * Canary values. If any of these shows up in a log it is a reportable health
 * data leak. This file is the net that stops the protection from eroding.
 */
const CANARIES = [
  '1712345678', // cedula
  'paciente@ejemplo.com',
  '0991234567', // mobile
  'Juan Pérez Andrade',
  'J45.9', // ICD-10
];

function containsCanary(output: string): string | null {
  return CANARIES.find((c) => output.includes(c)) ?? null;
}

describe('pruneToAllowlist', () => {
  it('drops nested patient data and keeps internal identifiers', () => {
    const result = pruneToAllowlist({
      encounter_id: 'A-1',
      duration_ms: 42,
      patient: {
        cedula: '1712345678',
        firstName: 'Juan',
        lastName: 'Pérez Andrade',
        email: 'paciente@ejemplo.com',
        diagnosis: 'J45.9',
      },
    });

    expect(containsCanary(JSON.stringify(result))).toBeNull();
    expect(result).toEqual({ encounter_id: 'A-1', duration_ms: 42 });
  });

  it('PA-025 keeps the MRN of a registration and drops the name and the document', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL OBJETO ES EL QUE `PatientsService` CONSTRUYE DE VERDAD, MÁS RUIDO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Las dos mitades del requisito en una sola aserción, porque separarlas es
     * lo que dejó pasar el defecto: la primera —que no salga nombre, documento
     * ni dato clínico— pasaba con la lista blanca comiéndose TAMBIÉN el número
     * de historia, y entonces la línea decía «patient registered» sin decir
     * cuál. Un registro que no se puede seguir no cumple la mitad que sí exige
     * REQ-116: poder reconstruir un acceso.
     *
     * El MRN es la excepción declarada y lo es por lo que es: un número
     * interno, no un identificador nacional.
     */
    const result = pruneToAllowlist({
      patient_mrn: 'HC0000000801',
      action: 'PATIENT_REGISTERED',
      familyName: 'Pérez Andrade',
      cedula: '1712345678',
      diagnosis: 'J45.9',
    });

    expect(result).toEqual({
      patient_mrn: 'HC0000000801',
      action: 'PATIENT_REGISTERED',
    });
    expect(containsCanary(JSON.stringify(result))).toBeNull();
  });

  it('PA-025 keeps both MRNs of a merge, which is what support traces it by', () => {
    // Mismo criterio y mismo defecto: `patient-merge.service.ts` los construye
    // creyendo que viajan, y sin declararlos la lista blanca los tiraba.
    const result = pruneToAllowlist({
      source_mrn: 'HC0000000801',
      target_mrn: 'HC0000000802',
      action: 'PATIENTS_MERGED',
    });

    expect(result).toEqual({
      source_mrn: 'HC0000000801',
      target_mrn: 'HC0000000802',
      action: 'PATIENTS_MERGED',
    });
  });

  it('drops NEW undeclared fields: fails closed', () => {
    // Simulates the sprint that adds a field to the Patient entity and nobody
    // remembers to touch the logging config. A denylist would leak this.
    const result = pruneToAllowlist({
      fieldInventedInSprint12: '1712345678',
      user_id: 'u-1',
    });

    expect(JSON.stringify(result)).not.toContain('1712345678');
    expect(result).toEqual({ user_id: 'u-1' });
  });

  it('is not fooled by casing or key-name variants', () => {
    // Pino's `redact` paths are case sensitive: `Cedula` != `cedula`. The
    // allowlist does not have that problem because it never enumerates what is
    // forbidden.
    const result = pruneToAllowlist({
      Cedula: '1712345678',
      CEDULA: '1712345678',
      identificationNumber: '1712345678',
    });

    expect(result).toEqual({});
  });

  it('stops recursion on very deep objects', () => {
    let nested: Record<string, unknown> = { state: 'end' };
    for (let i = 0; i < 12; i++) nested = { req: nested };

    expect(JSON.stringify(pruneToAllowlist(nested))).toContain('MAX_DEPTH');
  });

  it('trims long arrays and reports how many were omitted', () => {
    const result = pruneToAllowlist(
      Array.from({ length: 30 }, (_, i) => ({ encounter_id: `A-${i}` })),
    ) as unknown[];

    expect(result).toHaveLength(21); // 20 plus the marker
    expect(result.at(-1)).toBe('[+10 items omitted]');
  });

  it('keeps primitives and serialises dates', () => {
    expect(pruneToAllowlist('text')).toBe('text');
    expect(pruneToAllowlist(42)).toBe(42);
    expect(pruneToAllowlist(null)).toBeNull();
    expect(pruneToAllowlist(new Date('2026-08-06T00:00:00Z'))).toBe(
      '2026-08-06T00:00:00.000Z',
    );
  });
});

describe('sanitizeUrl', () => {
  it('removes the query string, which usually carries the cedula', () => {
    expect(sanitizeUrl('/api/v1/patients?cedula=1712345678')).toBe(
      '/api/v1/patients',
    );
  });

  it('normalises numeric identifiers to keep cardinality low', () => {
    expect(sanitizeUrl('/api/v1/patients/123456/encounters')).toBe(
      '/api/v1/patients/:id/encounters',
    );
  });

  it('leaves routes without identifiers untouched', () => {
    expect(sanitizeUrl('/api/v1/health')).toBe('/api/v1/health');
  });

  it('AU-021 masks the first-credential token, which is a live credential in the path', () => {
    // The link is valid for 72 hours and anybody holding it can set the
    // password of an account that may read medical records. Logging it puts a
    // working credential in front of everybody who can read logs — a much
    // wider audience than the person it was mailed to.
    const token = '6VMKaPl8xyCbAkl2BGi1J7XprpqdseKTayxvAqGzYVA';

    expect(sanitizeUrl(`/api/v1/auth/credential/${token}`)).toBe(
      '/api/v1/auth/credential/:token',
    );
  });

  it('AU-021 does not confuse the credential route with anything else', () => {
    // Matched literally, so no other route loses a segment to this rule.
    expect(
      sanitizeUrl('/api/v1/auth/users/019ffbaf-5cbc-7c02-a945-782313'),
    ).toBe('/api/v1/auth/users/019ffbaf-5cbc-7c02-a945-782313');
  });
});

describe('sanitizeErrorMessage', () => {
  it('masks Ecuadorian identification patterns', () => {
    const cleaned = sanitizeErrorMessage(
      'duplicate key: cedula 1712345678, email paciente@ejemplo.com, mobile 0991234567',
    );
    expect(containsCanary(cleaned)).toBeNull();
    expect(cleaned).toContain('[CEDULA]');
    expect(cleaned).toContain('[EMAIL]');
    expect(cleaned).toContain('[PHONE]');
  });

  it('tells a RUC apart from a cedula by length', () => {
    expect(sanitizeErrorMessage('ruc 1712345678001')).toContain('[RUC]');
  });

  it('hides the detail of a PostgreSQL constraint violation', () => {
    // pg returns literally: Key (cedula)=(1712345678) already exists.
    expect(
      sanitizeErrorMessage('Key (cedula)=(1712345678) already exists.'),
    ).not.toContain('1712345678');
  });

  it('truncates oversized messages', () => {
    expect(sanitizeErrorMessage('x'.repeat(2000))).toHaveLength(500);
  });
});

describe('known limitation: interpolation into the message', () => {
  it('documents that a template literal DOES leak, hence the ESLint rule', () => {
    // Pino's `redact` works on the object PROPERTIES, never on the `msg`
    // string. It is the number one leak vector in Node and no configuration
    // covers it.
    //
    //   logger.info({ cedula })                  -> redacted
    //   logger.info(`consulta de ${cedula}`)     -> FULL LEAK
    //
    // The defence is the `no-restricted-syntax` ESLint rule banning template
    // literals in log calls. This test exists so the limitation is written
    // down and nobody discovers it in production.
    const interpolatedMessage = `consulta de la cedula 1712345678`;
    expect(containsCanary(interpolatedMessage)).not.toBeNull();

    // Sanitising by hand does work, but relies on somebody remembering:
    expect(
      containsCanary(sanitizeErrorMessage(interpolatedMessage)),
    ).toBeNull();
  });
});
