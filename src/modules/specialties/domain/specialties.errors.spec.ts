import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import { SpecialtyNotFoundError } from '../../../shared/domain/errors/master-data.errors';
import {
  SpecialtyDuplicateError,
  SpecialtyInUseError,
} from './specialties.errors';

/**
 * The error contract of the specialties module: stable code, category (the
 * category IS the HTTP status), and a user sentence with nothing sensitive in
 * it. The SPEC fixes the four public codes in its error table.
 *
 * The «not found» class is asserted from `shared/domain` since 13-08-2026:
 * `staff` must answer the same code for ST-008, and no module may import
 * another. Its contract is still this module's to defend.
 */
describe('specialties errors', () => {
  it('SP-006 responde SPECIALTY_DUPLICATE como conflicto apuntando siempre al nombre', () => {
    const byCode = new SpecialtyDuplicateError('code');
    const byName = new SpecialtyDuplicateError('name');

    expect(byCode).toBeInstanceOf(ConflictError);
    expect(byCode.code).toBe('SPECIALTY_DUPLICATE');
    // SP-009: no queda ninguna casilla de código que iluminar.
    expect(byCode.fieldErrors?.[0]?.field).toBe('name');
    expect(byName.fieldErrors?.[0]?.field).toBe('name');
    // The rejected value never travels: it reaches logs and screenshots.
    expect(byName.message).not.toMatch(/pediatr/i);
  });

  it('SP-009 el choque del código derivado no le dice «código» a quien solo escribió un nombre', () => {
    const derived = new SpecialtyDuplicateError('code');

    for (const text of [
      derived.userTitle ?? '',
      derived.fieldErrors?.[0]?.message ?? '',
    ]) {
      expect(text).not.toMatch(/c[oó]digo/i);
      expect(text.length).toBeGreaterThan(0);
    }
    // Y no afirma que el nombre esté repetido, porque no lo está: son dos
    // nombres distintos que el sistema no podría distinguir.
    expect(derived.fieldErrors?.[0]?.message).not.toMatch(/ya pertenece/i);
  });

  it('SP-003 responde SPECIALTY_IN_USE como conflicto y ofrece desactivar en la frase', () => {
    const error = new SpecialtyInUseError();

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('SPECIALTY_IN_USE');
    expect(error.userTitle).toContain('desactivarla');
  });

  it('SP-003 la que no existe responde como 404 sin decir si existió', () => {
    const error = new SpecialtyNotFoundError();
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe('SPECIALTY_NOT_FOUND');
    expect(error.message).not.toMatch(/existed|deleted/i);
  });

  it('SP-002 registra cada código nuevo en el catálogo público congelado', () => {
    for (const code of [
      'SPECIALTY_NOT_FOUND',
      'SPECIALTY_DUPLICATE',
      'SPECIALTY_IN_USE',
    ] as const) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
    // ADR-013: the service type's codes left with its table.
    for (const code of [
      'SERVICE_TYPE_DUPLICATE',
      'SERVICE_TYPE_IN_USE',
      'SERVICE_TYPE_NOT_FOUND',
      'CONSULTATION_BILLING_UNAVAILABLE',
    ]) {
      expect(DOMAIN_ERROR_CODES as readonly string[]).not.toContain(code);
    }
  });
});
