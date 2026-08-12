import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MfaAlreadyEnrolledError,
  MfaNotEnrolledError,
  SessionUserMissingError,
} from '../domain/auth.errors';
import { MfaEnrolmentService } from './mfa-enrolment.service';
import type { AuthUser, AuthUserRepositoryPort } from './ports';

const user = (overrides: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 'user-1',
    email: 'medico@clinica.ec',
    mfaEnabledAt: null,
    mfaSecretEncrypted: null,
    ...overrides,
  }) as AuthUser;

describe('MfaEnrolmentService', () => {
  const findById = vi.fn();
  const savePendingMfaSecret = vi.fn();
  const confirmMfa = vi.fn();
  const enroll = vi.fn();
  const verify = vi.fn();
  let service: MfaEnrolmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    enroll.mockReturnValue({
      secret: 'plain-secret',
      encrypted: 'encrypted-secret',
      uri: 'otpauth://totp/x',
    });
    verify.mockReturnValue(42);

    service = new MfaEnrolmentService(
      {
        findById,
        savePendingMfaSecret,
        confirmMfa,
      } as unknown as AuthUserRepositoryPort,
      { enroll, verify },
      { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger,
    );
  });

  it('stores the pending secret server-side and returns the plaintext exactly once', async () => {
    findById.mockResolvedValue(user());

    const result = await service.enroll('user-1');

    expect(savePendingMfaSecret).toHaveBeenCalledWith(
      'user-1',
      'encrypted-secret',
    );
    expect(result).toEqual({ secret: 'plain-secret', uri: 'otpauth://totp/x' });
  });

  it('refuses to enrol a user who already has a second factor', async () => {
    findById.mockResolvedValue(
      user({ mfaEnabledAt: new Date('2026-01-01T00:00:00Z') }),
    );

    await expect(service.enroll('user-1')).rejects.toBeInstanceOf(
      MfaAlreadyEnrolledError,
    );
    expect(savePendingMfaSecret).not.toHaveBeenCalled();
  });

  it('confirms only when a pending secret exists and records the used step', async () => {
    findById.mockResolvedValue(
      user({ mfaSecretEncrypted: 'encrypted-secret' }),
    );

    await service.confirm('user-1', '123456');

    // The step is recorded so the SAME code cannot both confirm the enrolment
    // and pass the first verification: replay inside the 30-second window.
    expect(verify).toHaveBeenCalledWith(
      'encrypted-secret',
      '123456',
      'medico@clinica.ec',
      null,
    );
    expect(confirmMfa).toHaveBeenCalledWith('user-1', 42);
  });

  it('refuses to confirm without a pending secret, and refuses twice', async () => {
    findById.mockResolvedValue(user());
    await expect(service.confirm('user-1', '123456')).rejects.toBeInstanceOf(
      MfaNotEnrolledError,
    );

    findById.mockResolvedValue(
      user({
        mfaSecretEncrypted: 'encrypted-secret',
        mfaEnabledAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    await expect(service.confirm('user-1', '123456')).rejects.toBeInstanceOf(
      MfaAlreadyEnrolledError,
    );
    expect(confirmMfa).not.toHaveBeenCalled();
  });

  it('answers the same for an unknown user as for a missing session', async () => {
    findById.mockResolvedValue(null);

    await expect(service.enroll('ghost')).rejects.toBeInstanceOf(
      SessionUserMissingError,
    );
  });
});
