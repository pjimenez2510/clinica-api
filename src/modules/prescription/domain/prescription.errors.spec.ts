import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import { ForbiddenError } from '../../../shared/domain/errors/domain-error';

import { PrescriptionOfAnotherPrescriberError } from './prescription.errors';

/**
 * The error contract of what PR-109 added: a stable code, the CATEGORY that
 * decides the HTTP status (`ForbiddenError` is 403 in
 * `problem-details.filter.ts`) and a sentence that says what to do instead.
 */
describe('el contrato de errores de la receta', () => {
  it('PR-109 corregir la receta de otro profesional: código, 403 y la salida', () => {
    const error = new PrescriptionOfAnotherPrescriberError();

    expect(error.code).toBe('PRESCRIPTION_OF_ANOTHER_PRESCRIBER');
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
    expect(error).toBeInstanceOf(ForbiddenError);
    // La salida existe y se nombra: anular (PR-108) y componer una propia.
    expect(error.userTitle).toBe(
      'Esta receta la emitió otro profesional y sólo él puede corregirla. Puede anularla y componer una receta propia',
    );
    // PR-094. Lo que va al registro no nombra paciente ni medicamento.
    expect(error.message).toBe(
      'The issued prescription belongs to another prescriber',
    );
  });
});
