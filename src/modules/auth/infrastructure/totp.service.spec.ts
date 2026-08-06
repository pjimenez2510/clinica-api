import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Secret, TOTP } from 'otpauth';
import { beforeEach, describe, expect, it } from 'vitest';

import { InvalidTotpCodeError, TotpService } from './totp.service';

const EMAIL = 'medico@clinica.ec';

function buildService(key = randomBytes(32).toString('base64')): TotpService {
  const config = {
    get: () => key,
  } as unknown as ConfigService<never, true>;
  return new TotpService(config);
}

/** Generates the code an authenticator app would show right now. */
function currentCode(secretBase32: string): string {
  return new TOTP({
    issuer: 'Clinica',
    label: EMAIL,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

describe('TotpService', () => {
  let service: TotpService;

  beforeEach(() => {
    service = buildService();
  });

  it('refuses to start with a key that is not 32 bytes', () => {
    // AES-256 needs exactly 32 bytes. Failing at boot is much better than
    // discovering it when the first user enrolls.
    expect(() => buildService(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });

  describe('enroll', () => {
    it('returns a usable otpauth URI for the QR code', () => {
      const { uri } = service.enroll(EMAIL);
      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      expect(uri).toContain('Clinica');
    });

    it('encrypts the secret and never stores it in clear', () => {
      const { secret, encrypted } = service.enroll(EMAIL);
      expect(encrypted).not.toContain(secret);
      expect(encrypted.length).toBeGreaterThan(secret.length);
    });

    it('produces a different ciphertext each time for the same secret', () => {
      // A random IV per encryption. Without it, identical secrets would be
      // visible as identical rows in the database.
      const a = service.enroll(EMAIL);
      const b = service.enroll(EMAIL);
      expect(a.encrypted).not.toBe(b.encrypted);
    });
  });

  describe('verify', () => {
    it('accepts the current code and returns the consumed step', () => {
      const { secret, encrypted } = service.enroll(EMAIL);
      const step = service.verify(encrypted, currentCode(secret), EMAIL, null);

      const expected = BigInt(Math.floor(Date.now() / 1000 / 30));
      expect(step).toBe(expected);
    });

    it('rejects a wrong code', () => {
      const { encrypted } = service.enroll(EMAIL);
      expect(() => service.verify(encrypted, '000000', EMAIL, null)).toThrow(
        InvalidTotpCodeError,
      );
    });

    it('rejects a replayed code even while it is still time-valid', () => {
      // THE KEY TEST. Without this check an intercepted code stays usable for
      // the whole 30 second window, which is exactly what a phishing proxy
      // needs.
      const { secret, encrypted } = service.enroll(EMAIL);
      const code = currentCode(secret);

      const firstStep = service.verify(encrypted, code, EMAIL, null);

      // Same code, now with the step already recorded as consumed.
      expect(() => service.verify(encrypted, code, EMAIL, firstStep)).toThrow(
        InvalidTotpCodeError,
      );
    });

    it('rejects a step older than the last one consumed', () => {
      const { secret, encrypted } = service.enroll(EMAIL);
      const futureStep = BigInt(Math.floor(Date.now() / 1000 / 30)) + 10n;

      expect(() =>
        service.verify(encrypted, currentCode(secret), EMAIL, futureStep),
      ).toThrow(InvalidTotpCodeError);
    });

    it('fails on a secret encrypted with a different key', () => {
      // GCM authenticates: tampering or a wrong key fails loudly instead of
      // yielding garbage that would then be treated as a valid secret.
      const { encrypted } = service.enroll(EMAIL);
      const other = buildService();

      expect(() => other.verify(encrypted, '123456', EMAIL, null)).toThrow();
    });
  });
});
