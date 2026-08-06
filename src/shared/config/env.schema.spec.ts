import { describe, expect, it } from 'vitest';

import { validarEnv } from './env.schema';

/** Configuración mínima válida. Cada test parte de aquí y altera una cosa. */
const base = {
  DATABASE_URL: 'postgresql://clinica:pwd@localhost:5432/clinica',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  MFA_ENCRYPTION_KEY: 'a'.repeat(44),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  SMTP_HOST: 'localhost',
  SMTP_FROM: 'no-responder@clinica.local',
};

describe('validarEnv', () => {
  it('acepta la configuración mínima y aplica los valores por defecto', () => {
    const env = validarEnv(base);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.TZ).toBe('UTC');
    expect(env.ZONA_HORARIA_DEFECTO).toBe('America/Guayaquil');
  });

  it('emite contra pruebas del SRI por defecto, nunca contra producción', () => {
    // Que producción exija una decisión explícita es intencional: un valor por
    // defecto olvidado no puede acabar emitiendo comprobantes reales.
    expect(validarEnv(base).SRI_AMBIENTE).toBe('1');
  });

  it('convierte CORS_ORIGINS en array y descarta entradas vacías', () => {
    const env = validarEnv({
      ...base,
      CORS_ORIGINS: 'http://a.com, http://b.com , ',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com']);
  });

  it('coacciona PORT de texto a número', () => {
    expect(validarEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  describe('zona horaria', () => {
    it('acepta las dos zonas reales de Ecuador', () => {
      for (const zona of ['America/Guayaquil', 'Pacific/Galapagos']) {
        expect(
          validarEnv({ ...base, ZONA_HORARIA_DEFECTO: zona })
            .ZONA_HORARIA_DEFECTO,
        ).toBe(zona);
      }
    });

    it('rechaza America/Galapagos, que no existe en la base IANA', () => {
      // Es el error clásico. Sin esta validación, revienta con RangeError en
      // tiempo de ejecución al formatear la primera fecha.
      expect(() =>
        validarEnv({ ...base, ZONA_HORARIA_DEFECTO: 'America/Galapagos' }),
      ).toThrow(/zona horaria IANA inválida/);
    });
  });

  describe('falla rápido y con un mensaje legible', () => {
    it('nombra cada variable que falta', () => {
      try {
        validarEnv({ NODE_ENV: 'production' });
        expect.unreachable('debió lanzar');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('DATABASE_URL');
        expect(msg).toContain('JWT_PRIVATE_KEY');
        expect(msg).toContain('.env.example');
      }
    });

    it('rechaza una DATABASE_URL que no sea de postgres', () => {
      expect(() =>
        validarEnv({ ...base, DATABASE_URL: 'mysql://x/y' }),
      ).toThrow();
    });

    it('rechaza una clave de cifrado MFA demasiado corta', () => {
      expect(() =>
        validarEnv({ ...base, MFA_ENCRYPTION_KEY: 'corta' }),
      ).toThrow(/MFA_ENCRYPTION_KEY/);
    });

    it('rechaza TZ distinto de UTC', () => {
      // Permitir otra zona en el servidor haría que las conversiones dependieran
      // del host, que es la causa raíz de los bugs de fecha más difíciles.
      expect(() => validarEnv({ ...base, TZ: 'America/Guayaquil' })).toThrow(
        /TZ/,
      );
    });
  });
});
