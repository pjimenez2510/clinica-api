import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';

import {
  ClinicalRecordCopyInvalidError,
  ConsentAlreadyCorrectedError,
  DataRequestPartyNotAllowedError,
  DataRequestPatientNotDeceasedError,
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

describe('los errores de la copia de la historia clínica (PD-052, PD-053)', () => {
  it('PD-052 DATA_REQUEST_PARTY_NOT_ALLOWED es un 422 que nombra a quien la presenta', () => {
    const error = new DataRequestPartyNotAllowedError();
    expect(error.code).toBe('DATA_REQUEST_PARTY_NOT_ALLOWED');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toBe(
      'Un apoderado, una persona autorizada, una autoridad o un familiar sólo pueden pedir la copia de la historia clínica',
    );
    expect(error.fieldErrors?.[0]?.field).toBe('requestedBy');
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('PD-052 DATA_REQUEST_PATIENT_NOT_DECEASED es un 422 que dice que la ficha no registra el fallecimiento', () => {
    const error = new DataRequestPatientNotDeceasedError();
    expect(error.code).toBe('DATA_REQUEST_PATIENT_NOT_DECEASED');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toContain('no registra el fallecimiento');
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('PD-053 CLINICAL_RECORD_COPY_INVALID es un 422 que nombra el campo y dice qué falta', () => {
    const error = new ClinicalRecordCopyInvalidError('documentsChecked');
    expect(error.code).toBe('CLINICAL_RECORD_COPY_INVALID');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toBe(
      'Marque que recibió la solicitud firmada y la copia de la cédula',
    );
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'documentsChecked' }),
    ]);
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });
});
