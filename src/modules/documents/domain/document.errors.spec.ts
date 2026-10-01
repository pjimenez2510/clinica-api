import { describe, expect, it } from 'vitest';

import { NotFoundError } from '../../../shared/domain/errors/domain-error';
import {
  DocumentImageNotFoundError,
  DocumentVerificationNotFoundError,
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
});
