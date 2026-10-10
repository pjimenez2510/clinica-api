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
  DataRequestPatientDeceasedError,
  ClinicalRecordCopyReviewRequiredError,
  ClinicalRecordCopyAlreadyReviewedError,
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

  it('PD-065 answers DATA_REQUEST_PATIENT_DECEASED as a 422 on who presents it', () => {
    const error = new DataRequestPatientDeceasedError();
    expect(error.code).toBe('DATA_REQUEST_PATIENT_DECEASED');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toBe(
      'La ficha registra el fallecimiento: la solicitud la presenta un familiar o quien fue su representante legal',
    );
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('PD-062 answers CLINICAL_RECORD_COPY_REVIEW_REQUIRED as a 409 that does not say what the record holds', () => {
    const error = new ClinicalRecordCopyReviewRequiredError();
    expect(error.code).toBe('CLINICAL_RECORD_COPY_REVIEW_REQUIRED');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'Esta copia necesita el visto bueno de un profesional antes de autorizarla: pídaselo desde la ficha del paciente',
    );
    expect(error.userTitle).not.toMatch(/violencia|VIH|tamizaje|diagn/i);
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('PD-061 answers CLINICAL_RECORD_COPY_ALREADY_REVIEWED as a 409', () => {
    const error = new ClinicalRecordCopyAlreadyReviewedError();
    expect(error.code).toBe('CLINICAL_RECORD_COPY_ALREADY_REVIEWED');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe('Esta copia ya tiene el visto bueno');
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });
});
