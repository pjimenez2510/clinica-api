import { describe, expect, it } from 'vitest';

import { UnauthorizedError } from '../../../shared/domain/errors/domain-error';

import { SessionExpiredError, SessionRevokedError } from './auth.errors';

/**
 * AU-040. The contract of `SESSION_EXPIRED`: code, status class and the
 * sentence. The integration tests (`session-lifecycle.spec.ts`) see the 401
 * and the code over HTTP, from the refresh and from the guard; this pins the
 * sentence, which the interface does not show but a problem-details client
 * reading `title` would.
 */
describe('AU-040 SessionExpiredError', () => {
  it('AU-040 es un 401 con código estable y una frase que dice qué pasó y qué hacer', () => {
    const error = new SessionExpiredError();

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.code).toBe('SESSION_EXPIRED');
    expect(error.userTitle).toMatch(/caducó/);
    expect(error.userTitle).toMatch(/vuelva a iniciar sesión/i);
  });

  it('AU-040 no dice lo mismo que una sesión cerrada: nadie la cerró', () => {
    expect(new SessionExpiredError().code).not.toBe(
      new SessionRevokedError().code,
    );
    expect(new SessionExpiredError().userTitle).not.toMatch(/contraseña/i);
  });
});
