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

  it('AU-040 la vida de una sesión vale 7 días por defecto y no pasa de 7', () => {
    // D-063: the author fixed the ceiling at seven days from sign-in. An
    // installation may shorten it — a shift, say — but a longer life is a
    // longer stretch for a stolen branch, so it must fail at startup.
    expect(validateEnv(base).JWT_REFRESH_TTL_DAYS).toBe(7);
    expect(
      validateEnv({ ...base, JWT_REFRESH_TTL_DAYS: '1' }).JWT_REFRESH_TTL_DAYS,
    ).toBe(1);
    for (const outOfRange of ['8', '0', '1.5']) {
      expect(() =>
        validateEnv({ ...base, JWT_REFRESH_TTL_DAYS: outOfRange }),
      ).toThrow(/JWT_REFRESH_TTL_DAYS/);
    }
  });

  it('AU-039 la gracia de la rotación vale 30 s por defecto y no pasa de 60', () => {
    // 30 and 0–60 are Okta's default and range: the only sourced figure. A
    // larger window is a longer stretch in which a stolen copy raises no alarm,
    // so it must fail at startup rather than be accepted silently.
    expect(validateEnv(base).JWT_REFRESH_REUSE_GRACE_SECONDS).toBe(30);
    expect(
      validateEnv({ ...base, JWT_REFRESH_REUSE_GRACE_SECONDS: '0' })
        .JWT_REFRESH_REUSE_GRACE_SECONDS,
    ).toBe(0);
    for (const outOfRange of ['61', '-1', '2.5']) {
      expect(() =>
        validateEnv({ ...base, JWT_REFRESH_REUSE_GRACE_SECONDS: outOfRange }),
      ).toThrow(/JWT_REFRESH_REUSE_GRACE_SECONDS/);
    }
  });

  it('REFUSES an origin that is not a URL', () => {
    // A missing scheme or a stray character silently stopped that origin from
    // working, and the only symptom was a CORS failure in the browser.
    expect(() =>
      validateEnv({ ...base, CORS_ORIGINS: 'https://clinica.ec, no-soy-url' }),
    ).toThrow();
  });

  describe('AS-006 AS-017 the assistant', () => {
    it('AS-006 is born closed: no remote provider, no exchange log, no ceiling', () => {
      const env = validateEnv(base);

      expect(env.ASSISTANT_ALLOW_REMOTE).toBe(false);
      expect(env.ASSISTANT_EXCHANGE_LOG).toBe(false);
      expect(env.ASSISTANT_MONTHLY_SPEND_CEILING_USD).toBeUndefined();
      expect(env.ASSISTANT_GEMINI_API_KEY).toBeUndefined();
      expect(env.ASSISTANT_PROVIDER_TIMEOUT_MS).toBe(60_000);
    });

    it('AS-006 reads an empty key as not declared, and only `true` opens the remote switch', () => {
      const env = validateEnv({
        ...base,
        ASSISTANT_GEMINI_API_KEY: '',
        ASSISTANT_ALLOW_REMOTE: 'true',
      });

      expect(env.ASSISTANT_GEMINI_API_KEY).toBeUndefined();
      expect(env.ASSISTANT_ALLOW_REMOTE).toBe(true);
      expect(() =>
        validateEnv({ ...base, ASSISTANT_ALLOW_REMOTE: 'yes' }),
      ).toThrow(/ASSISTANT_ALLOW_REMOTE/);
    });

    it('AS-017 accepts a positive monthly ceiling and refuses zero or a negative one', () => {
      expect(
        validateEnv({ ...base, ASSISTANT_MONTHLY_SPEND_CEILING_USD: '50' })
          .ASSISTANT_MONTHLY_SPEND_CEILING_USD,
      ).toBe(50);
      for (const value of ['0', '-1', 'mucho']) {
        expect(() =>
          validateEnv({ ...base, ASSISTANT_MONTHLY_SPEND_CEILING_USD: value }),
        ).toThrow(/ASSISTANT_MONTHLY_SPEND_CEILING_USD/);
      }
    });
  });

  describe('AS-031 AS-032 the local pseudonymizer, clinica-ai', () => {
    const SECRET = 'a'.repeat(64);

    it('AS-031 is born without it: no secret, no service', () => {
      const env = validateEnv(base);

      expect(env.ASSISTANT_AI_SERVICE_SECRET).toBeUndefined();
      expect(env.ASSISTANT_AI_SERVICE_URL).toBe('http://127.0.0.1:8100');
      expect(env.ASSISTANT_AI_SERVICE_TIMEOUT_MS).toBe(10_000);
      expect(
        validateEnv({ ...base, ASSISTANT_AI_SERVICE_SECRET: '' })
          .ASSISTANT_AI_SERVICE_SECRET,
      ).toBeUndefined();
    });

    it('AS-031 refuses to start with a secret shorter than 32 characters', () => {
      expect(() =>
        validateEnv({ ...base, ASSISTANT_AI_SERVICE_SECRET: 'corto' }),
      ).toThrow(/ASSISTANT_AI_SERVICE_SECRET/);
      expect(
        validateEnv({ ...base, ASSISTANT_AI_SERVICE_SECRET: SECRET })
          .ASSISTANT_AI_SERVICE_SECRET,
      ).toBe(SECRET);
    });

    it('AS-032 accepts http only to this machine, and https anywhere', () => {
      for (const url of [
        'http://127.0.0.1:8100',
        'http://localhost:8100',
        'http://[::1]:8100',
        'https://ia.clinica.lan',
      ]) {
        expect(
          validateEnv({ ...base, ASSISTANT_AI_SERVICE_URL: url })
            .ASSISTANT_AI_SERVICE_URL,
        ).toBe(url);
      }
      for (const url of [
        'http://192.168.1.20:8100',
        'http://ia.clinica.lan',
        'http://clinica.test:8100',
        'ftp://127.0.0.1/ia',
      ]) {
        expect(() =>
          validateEnv({ ...base, ASSISTANT_AI_SERVICE_URL: url }),
        ).toThrow(/ASSISTANT_AI_SERVICE_URL/);
      }
    });
  });

  describe('IL-008 the identity provider', () => {
    const REMOTE = 'https://provider.example.com/v3/database-validation/';

    it('IL-008 refuses a remote provider unless IDENTITY_PROVIDER_ALLOW_REMOTE says so, and accepts a local double', () => {
      expect(() =>
        validateEnv({ ...base, IDENTITY_PROVIDER_URL: REMOTE }),
      ).toThrow(/IDENTITY_PROVIDER_ALLOW_REMOTE/);
      expect(
        validateEnv({
          ...base,
          IDENTITY_PROVIDER_ALLOW_REMOTE: 'true',
          IDENTITY_PROVIDER_URL: REMOTE,
        }).IDENTITY_PROVIDER_URL,
      ).toBe(REMOTE);
      expect(
        validateEnv({
          ...base,
          IDENTITY_PROVIDER_URL:
            'http://localhost:8601/v3/database-validation/',
        }).IDENTITY_PROVIDER_ALLOW_REMOTE,
      ).toBe(false);
    });

    it('IL-008 toward a remote provider, only https', () => {
      expect(() =>
        validateEnv({
          ...base,
          IDENTITY_PROVIDER_ALLOW_REMOTE: 'true',
          IDENTITY_PROVIDER_URL: 'http://provider.example.com/v3/',
        }),
      ).toThrow(/https/);
    });

    it('IL-006 refuses a digest key too short to hide a ten-digit number', () => {
      expect(() =>
        validateEnv({ ...base, IDENTITY_LOOKUP_DIGEST_KEY: 'corta' }),
      ).toThrow(/IDENTITY_LOOKUP_DIGEST_KEY/);
      expect(
        validateEnv({ ...base, IDENTITY_LOOKUP_DIGEST_KEY: 'x'.repeat(32) })
          .IDENTITY_LOOKUP_DIGEST_KEY,
      ).toHaveLength(32);
    });
  });

  describe('SRI-053 SRI-055 the SRI web service', () => {
    const PATH = '/comprobantes-electronicos-ws/RecepcionComprobantesOffline';

    it('SRI-053 refuses a remote SRI unless SRI_ALLOW_REMOTE says so, and accepts a local double', () => {
      expect(() =>
        validateEnv({
          ...base,
          SRI_RECEPTION_URL: `https://celcer.sri.gob.ec${PATH}`,
        }),
      ).toThrow(/SRI_ALLOW_REMOTE/);
      expect(
        validateEnv({
          ...base,
          SRI_RECEPTION_URL: `http://localhost:8099${PATH}`,
        }).SRI_RECEPTION_URL,
      ).toContain('localhost');
    });

    it('SRI-053 toward the real SRI, only https', () => {
      expect(() =>
        validateEnv({
          ...base,
          SRI_ALLOW_REMOTE: 'true',
          SRI_RECEPTION_URL: `http://celcer.sri.gob.ec${PATH}`,
        }),
      ).toThrow(/https/);
    });

    it('SRI-055 refuses an environment that is not the one of the SRI host, and accepts the matching one', () => {
      expect(() =>
        validateEnv({
          ...base,
          SRI_ALLOW_REMOTE: 'true',
          SRI_ENVIRONMENT: '1',
          SRI_RECEPTION_URL: `https://cel.sri.gob.ec${PATH}`,
        }),
      ).toThrow(/ambiente 2/);
      expect(
        validateEnv({
          ...base,
          SRI_ALLOW_REMOTE: 'true',
          SRI_ENVIRONMENT: '1',
          SRI_RECEPTION_URL: `https://celcer.sri.gob.ec${PATH}`,
        }).SRI_ENVIRONMENT,
      ).toBe('1');
    });
  });

  it('DEMANDS an explicit trust-proxy setting in production', () => {
    // The default of 0 is right in development and dangerous in production,
    // where it puts the whole clinic in one rate-limit bucket and records the
    // proxy as every user's address.
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /TRUST_PROXY_HOPS/,
    );

    expect(
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        TRUST_PROXY_HOPS: '1',
        WEB_BASE_URL: 'https://clinica.example',
      }).TRUST_PROXY_HOPS,
    ).toBe(1);
  });

  it('DOC-083 en producción exige WEB_BASE_URL con https: va impresa en el QR de documentos inmutables', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      TRUST_PROXY_HOPS: '1',
    };
    const withoutWeb: Record<string, string> = { ...production };
    delete withoutWeb.WEB_BASE_URL;

    expect(() => validateEnv(withoutWeb)).toThrow(/WEB_BASE_URL/);
    expect(() =>
      validateEnv({ ...production, WEB_BASE_URL: 'http://clinica.example' }),
    ).toThrow(/WEB_BASE_URL/);
    expect(
      validateEnv({ ...production, WEB_BASE_URL: 'https://clinica.example' })
        .WEB_BASE_URL,
    ).toBe('https://clinica.example');
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
