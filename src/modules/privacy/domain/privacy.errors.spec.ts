import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';

import {
  ConsentAlreadyCorrectedError,
  ConsentNotFoundError,
  DataRequestNotAnsweredError,
} from './privacy.errors';

/**
 * The contract of the codes D-127 brings to `privacy`: stable `code`, the HTTP
 * status (asserted by the category the problem filter reads) and the sentence
 * whoever is at the screen reads. None names a datum of the patient.
 */
describe('los errores de corregir en privacidad', () => {
  it('PD-044 answers CONSENT_NOT_FOUND as a 404 that says to refresh the list', () => {
    const error = new ConsentNotFoundError();
    expect(error.code).toBe('CONSENT_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.userTitle).toBe(
      'No se encontró ese consentimiento en la ficha. Actualice la lista',
    );
  });

  it('PD-044 answers CONSENT_ALREADY_CORRECTED as a 409 that points at the standing one', () => {
    const error = new ConsentAlreadyCorrectedError();
    expect(error.code).toBe('CONSENT_ALREADY_CORRECTED');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'Ese consentimiento ya se corrigió. Actualice la lista y corrija el vigente',
    );
  });

  it('PD-047 answers DATA_REQUEST_NOT_ANSWERED as a 409 that says to answer it', () => {
    const error = new DataRequestNotAnsweredError();
    expect(error.code).toBe('DATA_REQUEST_NOT_ANSWERED');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'Esta solicitud todavía no tiene respuesta: respóndala en lugar de corregirla',
    );
  });

  it('PD-044 PD-047 registers the three codes in the frozen catalogue', () => {
    for (const code of [
      'CONSENT_ALREADY_CORRECTED',
      'CONSENT_NOT_FOUND',
      'DATA_REQUEST_NOT_ANSWERED',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});
