import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

/** Minimal valid configuration. Every test starts here and changes one thing. */
const base = {
  DATABASE_URL: 'postgresql://clinica:pwd@localhost:5432/clinica',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  // 32 zero bytes in base64. It must DECODE to 32 bytes, not merely be 44
  // characters: `'a'.repeat(44)` is 44 characters and decodes to 33.
  MFA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  SMTP_HOST: 'localhost',
  SMTP_FROM: 'no-reply@clinica.local',
};

describe('validateEnv', () => {
  it('accepts the minimal configuration and applies defaults', () => {
    const env = validateEnv(base);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.TZ).toBe('UTC');
    expect(env.DEFAULT_TIMEZONE).toBe('America/Guayaquil');
  });

  it('defaults to the SRI testing environment, never production', () => {
    // Requiring an explicit decision for production is intentional: a
    // forgotten default must not end up issuing real invoices.
    expect(validateEnv(base).SRI_ENVIRONMENT).toBe('1');
  });

  it('turns CORS_ORIGINS into an array and drops empty entries', () => {
    const env = validateEnv({
      ...base,
      CORS_ORIGINS: 'http://a.com, http://b.com , ',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com']);
  });

  it('coerces PORT from text to number', () => {
    expect(validateEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  describe('timezone', () => {
    it('accepts both real Ecuadorian timezones', () => {
      for (const tz of ['America/Guayaquil', 'Pacific/Galapagos']) {
        expect(
          validateEnv({ ...base, DEFAULT_TIMEZONE: tz }).DEFAULT_TIMEZONE,
        ).toBe(tz);
      }
    });

    it('rejects America/Galapagos, which does not exist in the IANA database', () => {
      // The classic mistake. Without this validation it blows up with a
      // RangeError at runtime when formatting the first date.
      expect(() =>
        validateEnv({ ...base, DEFAULT_TIMEZONE: 'America/Galapagos' }),
      ).toThrow(/invalid IANA timezone/);
    });
  });

  describe('fails fast with a readable message', () => {
    it('names every missing variable', () => {
      try {
        validateEnv({ NODE_ENV: 'production' });
        expect.unreachable('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('DATABASE_URL');
        expect(msg).toContain('JWT_PRIVATE_KEY');
        expect(msg).toContain('.env.example');
      }
    });

    it('rejects a DATABASE_URL that is not postgres', () => {
      expect(() =>
        validateEnv({ ...base, DATABASE_URL: 'mysql://x/y' }),
      ).toThrow();
    });

    it('rejects an MFA encryption key that is too short', () => {
      expect(() =>
        validateEnv({ ...base, MFA_ENCRYPTION_KEY: 'short' }),
      ).toThrow(/MFA_ENCRYPTION_KEY/);
    });

    it('rejects a TZ other than UTC', () => {
      // Allowing another server timezone would make conversions depend on the
      // host, the root cause of the hardest date bugs.
      expect(() => validateEnv({ ...base, TZ: 'America/Guayaquil' })).toThrow(
        /TZ/,
      );
    });
  });

  it('REFUSES a key that is 44 characters but not 32 bytes', () => {
    // The exact failure the old `.min(44)` let through, and which TotpService
    // then rejected from its constructor — the right outcome, from the wrong
    // place, with the wrong message.
    expect(() =>
      validateEnv({ ...base, MFA_ENCRYPTION_KEY: 'a'.repeat(44) }),
    ).toThrow(/32 bytes/);
  });

  it('REFUSES a token TTL that is not a duration', () => {
    // `z.string()` accepted "banana", and the failure surfaced when the first
    // token was issued rather than at startup.
    expect(() => validateEnv({ ...base, JWT_ACCESS_TTL: 'banana' })).toThrow(
      /duración/,
    );
    expect(validateEnv({ ...base, JWT_ACCESS_TTL: '2h' }).JWT_ACCESS_TTL).toBe(
      '2h',
    );
  });

  it('REFUSES an origin that is not a URL', () => {
    // A missing scheme or a stray character silently stopped that origin from
    // working, and the only symptom was a CORS failure in the browser.
    expect(() =>
      validateEnv({ ...base, CORS_ORIGINS: 'https://clinica.ec, no-soy-url' }),
    ).toThrow();
  });

  it('DEMANDS an explicit trust-proxy setting in production', () => {
    // The default of 0 is right in development and dangerous in production,
    // where it puts the whole clinic in one rate-limit bucket and records the
    // proxy as every user's address.
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /TRUST_PROXY_HOPS/,
    );

    expect(
      validateEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' })
        .TRUST_PROXY_HOPS,
    ).toBe(1);
  });

  it('does not demand storage or mail configuration yet', () => {
    // Requiring configuration for features that do not exist teaches people to
    // invent values, and a fail-fast that cries wolf gets worked around. The
    // base fixture supplies them, so they are removed here on purpose.
    const withoutOptionalServices = { ...base };
    for (const key of [
      'S3_ENDPOINT',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'SMTP_HOST',
      'SMTP_FROM',
    ]) {
      delete (withoutOptionalServices as Record<string, unknown>)[key];
    }

    const env = validateEnv(withoutOptionalServices);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.SMTP_HOST).toBeUndefined();
  });
});
