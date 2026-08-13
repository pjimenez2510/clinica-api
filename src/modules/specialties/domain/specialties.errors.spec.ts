import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import {
  ServiceTypeNotFoundError,
  SpecialtyNotFoundError,
} from '../../../shared/domain/errors/master-data.errors';
import {
  ServiceTypeDuplicateError,
  ServiceTypeInUseError,
  SpecialtyDuplicateError,
  SpecialtyInUseError,
} from './specialties.errors';

/**
 * The error contract of the specialties module: stable code, category (the
 * category IS the HTTP status), and a user sentence with nothing sensitive in
 * it. The SPEC fixes the four public codes in its error table.
 *
 * The two «not found» classes are asserted from `shared/domain` since
 * 13-08-2026: `staff` must answer the same two codes for ST-008 and ST-009,
 * and no module may import another. Their contract is still this module's to
 * defend — it is the catalogue they name.
 */
describe('specialties errors', () => {
  it('SP-006 responde SPECIALTY_DUPLICATE como conflicto señalando el campo que chocó', () => {
    const byCode = new SpecialtyDuplicateError('code');
    const byName = new SpecialtyDuplicateError('name');

    expect(byCode).toBeInstanceOf(ConflictError);
    expect(byCode.code).toBe('SPECIALTY_DUPLICATE');
    expect(byCode.fieldErrors?.[0]?.field).toBe('code');
    expect(byName.fieldErrors?.[0]?.field).toBe('name');
    // The rejected value never travels: it reaches logs and screenshots.
    expect(byName.message).not.toMatch(/pediatr/i);
  });

  it('SP-003 responde SPECIALTY_IN_USE como conflicto y ofrece desactivar en la frase', () => {
    const error = new SpecialtyInUseError();

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('SPECIALTY_IN_USE');
    expect(error.userTitle).toContain('desactivarla');
  });

  it('SP-026 responde SERVICE_TYPE_DUPLICATE como conflicto apuntando al nombre', () => {
    const error = new ServiceTypeDuplicateError();

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('SERVICE_TYPE_DUPLICATE');
    expect(error.fieldErrors?.[0]?.field).toBe('name');
  });

  it('SP-025 responde SERVICE_TYPE_IN_USE como conflicto y ofrece desactivar', () => {
    const error = new ServiceTypeInUseError();

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('SERVICE_TYPE_IN_USE');
    expect(error.userTitle).toContain('desactivarlo');
  });

  it('SP-003/SP-025 los que no existen responden como 404 sin decir si existieron', () => {
    for (const error of [
      new SpecialtyNotFoundError(),
      new ServiceTypeNotFoundError(),
    ]) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).not.toMatch(/existed|deleted/i);
    }
  });

  it('SP-002 registra cada código nuevo en el catálogo público congelado', () => {
    for (const code of [
      'SPECIALTY_NOT_FOUND',
      'SERVICE_TYPE_NOT_FOUND',
      'SPECIALTY_DUPLICATE',
      'SPECIALTY_IN_USE',
      'SERVICE_TYPE_DUPLICATE',
      'SERVICE_TYPE_IN_USE',
    ] as const) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});
