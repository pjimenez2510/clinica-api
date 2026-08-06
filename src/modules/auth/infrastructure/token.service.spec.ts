import { generateKeyPairSync } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { beforeAll, describe, expect, it } from 'vitest';

import { InvalidTokenError, TokenService } from './token.service';

function buildService(overrides: Record<string, string> = {}): TokenService {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const values: Record<string, string> = {
    JWT_PRIVATE_KEY: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    JWT_PUBLIC_KEY: publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    JWT_ACCESS_TTL: '15m',
    ...overrides,
  };

  return new TokenService({
    get: (key: string) => values[key],
  } as unknown as ConfigService<never, true>);
}

const CLAIMS = { sub: 'u-1', fam: 'f-1', grants: [], mfa: true };

describe('TokenService', () => {
  let service: TokenService;

  beforeAll(async () => {
    service = buildService();
    await service.onModuleInit();
  });

  describe('access token', () => {
    it('signs with EdDSA, never with a symmetric algorithm', async () => {
      // With an asymmetric key, workers verify without being able to issue.
      // With HMAC, whoever can verify can forge.
      const jwt = await service.issueAccessToken(CLAIMS);
      const header = JSON.parse(
        Buffer.from(jwt.split('.')[0], 'base64url').toString(),
      ) as { alg: string };

      expect(header.alg).toBe('EdDSA');
    });

    it('round-trips the claims', async () => {
      const jwt = await service.issueAccessToken(CLAIMS);
      expect(await service.verifyAccessToken(jwt)).toEqual(CLAIMS);
    });

    it('rejects a tampered signature', async () => {
      const jwt = await service.issueAccessToken(CLAIMS);
      const forged = `${jwt.slice(0, -6)}AAAAAA`;

      await expect(service.verifyAccessToken(forged)).rejects.toThrow(
        InvalidTokenError,
      );
    });

    it('rejects a token signed by a different key', async () => {
      // The scenario where an attacker runs their own issuer.
      const other = buildService();
      await other.onModuleInit();
      const foreign = await other.issueAccessToken(CLAIMS);

      await expect(service.verifyAccessToken(foreign)).rejects.toThrow(
        InvalidTokenError,
      );
    });

    it('rejects an expired token', async () => {
      const expired = buildService({ JWT_ACCESS_TTL: '0s' });
      await expired.onModuleInit();
      const jwt = await expired.issueAccessToken(CLAIMS);

      await expect(expired.verifyAccessToken(jwt)).rejects.toThrow(
        InvalidTokenError,
      );
    });

    it('does not reveal why verification failed', async () => {
      // Telling "expired" apart from "bad signature" only helps an attacker.
      // Both surface as the same stable code.
      const expired = buildService({ JWT_ACCESS_TTL: '0s' });
      await expired.onModuleInit();
      const jwt = await expired.issueAccessToken(CLAIMS);

      await expect(expired.verifyAccessToken(jwt)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
      await expect(
        service.verifyAccessToken('not.a.token'),
      ).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });
  });

  describe('refresh token', () => {
    it('is opaque, not a JWT', () => {
      // It must be revocable, and a self-contained JWT cannot be revoked
      // before it expires.
      const { token } = service.generateRefreshToken();
      expect(token.split('.')).toHaveLength(1);
    });

    it('carries 256 bits of entropy', () => {
      // 32 bytes in base64url -> 43 characters.
      const { token } = service.generateRefreshToken();
      expect(token).toHaveLength(43);
    });

    it('never repeats', () => {
      const tokens = new Set(
        Array.from({ length: 500 }, () => service.generateRefreshToken().token),
      );
      expect(tokens.size).toBe(500);
    });

    it('cannot be recovered from its stored hash', () => {
      // If the database is stolen, active sessions are not.
      const { token, hash } = service.generateRefreshToken();
      expect(hash).toHaveLength(64); // sha256 in hex
      expect(hash).not.toContain(token);
    });

    it('hashes deterministically so lookup works', () => {
      const { token, hash } = service.generateRefreshToken();
      expect(TokenService.hashRefreshToken(token)).toBe(hash);
    });
  });
});
