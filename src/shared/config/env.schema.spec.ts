import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

/** Minimal valid configuration. Every test starts here and changes one thing. */
const base = {
  DATABASE_URL: 'postgresql://clinica:pwd@localhost:5432/clinica',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  MFA_ENCRYPTION_KEY: 'a'.repeat(44),
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
});
