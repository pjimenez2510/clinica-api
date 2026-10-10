import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
} from '../../../shared/domain/errors/domain-error';
import {
  ClinicalRecordCopyNotAvailableError,
  DocumentImageNotFoundError,
  DocumentVerificationNotFoundError,
  EncounterSummaryNotAvailableError,
} from './document.errors';

/**
 * The contract of this branch's two new errors: stable code, the category the
 * problem filter turns into 404, and the sentence a person reads.
 */
describe('los errores nuevos de documents', () => {
  it('DOC-061 DOCUMENT_IMAGE_NOT_FOUND es un 404 que dice que todavía no hay imagen', () => {
    const error = new DocumentImageNotFoundError();
    expect(error.code).toBe('DOCUMENT_IMAGE_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.userTitle).toBe('Todavía no se ha subido esta imagen');
  });

  it('DOC-096 DOCUMENT_VERIFICATION_NOT_FOUND es un 404 que no dice nada de por qué', () => {
    const error = new DocumentVerificationNotFoundError();
    expect(error.code).toBe('DOCUMENT_VERIFICATION_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.userTitle).toBe(
      'No hay ningún documento con ese código de verificación',
    );
  });

  it('DOC-111 ENCOUNTER_SUMMARY_NOT_AVAILABLE es un 409 que dice qué falta, sin datos del paciente', () => {
    const error = new EncounterSummaryNotAvailableError('OPEN');
    expect(error.code).toBe('ENCOUNTER_SUMMARY_NOT_AVAILABLE');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'Esta atención todavía no tiene la nota firmada, o fue anulada: no hay resumen que descargar',
    );
  });

  it('DOC-118 CLINICAL_RECORD_COPY_NOT_AVAILABLE es un 409 que dice que hace falta atender la solicitud', () => {
    const error = new ClinicalRecordCopyNotAvailableError();
    expect(error.code).toBe('CLINICAL_RECORD_COPY_NOT_AVAILABLE');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'La copia de la historia clínica se descarga cuando la solicitud de copia está atendida',
    );
  });
});
