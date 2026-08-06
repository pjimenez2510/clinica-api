import { createHash, randomBytes } from 'node:crypto';

import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { RoleAssignment } from '../domain/principal';
import { ConfigService } from '@nestjs/config';
import {
  type CryptoKey,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from 'jose';

import type { Env } from '../../../shared/config/env.schema';
import { UnauthorizedError } from '../../../shared/domain/errors/domain-error';

export class InvalidTokenError extends UnauthorizedError {
  readonly code = 'INVALID_TOKEN';

  constructor(reason: string) {
    super(`Invalid access token: ${reason}`, { reason });
  }
}

/** Claims carried by the access token. */
export interface AccessTokenClaims {
  /** Subject: internal user id. NEVER the cedula. */
  sub: string;
  /** Session family, so a token can be tied to the refresh chain it came from. */
  fam: string;
  /**
   * Roles held, each scoped to a site or global (`siteId: null`).
   *
   * The GRANTS travel, not the permissions. Permissions are derived from the
   * role in code, so widening a role does not require reissuing every live
   * token — and the token stays small. The cost is up to one access-token
   * lifetime (15 minutes) of staleness after a role changes, which ADR-007
   * accepts and bounds.
   */
  grants: RoleAssignment[];
  /** Whether the second factor was already satisfied in this session. */
  mfa: boolean;
}

const ISSUER = 'clinica-api';
const AUDIENCE = 'clinica-web';

/** Bytes of entropy for the opaque refresh token. */
const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: CryptoKey;
  private publicKey!: CryptoKey;
  private accessTtl!: string;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit(): Promise<void> {
    // PEM keys carry escaped newlines in the environment variable.
    const privatePem = this.config
      .get('JWT_PRIVATE_KEY', { infer: true })
      .replace(/\\n/g, '\n');
    const publicPem = this.config
      .get('JWT_PUBLIC_KEY', { infer: true })
      .replace(/\\n/g, '\n');

    this.privateKey = await importPKCS8(privatePem, 'EdDSA');
    this.publicKey = await importSPKI(publicPem, 'EdDSA');
    this.accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
  }

  /**
   * Issues a short-lived access token signed with EdDSA (Ed25519).
   *
   * EdDSA and not HS256: with an asymmetric key, workers and future services
   * verify tokens using only the public key and cannot issue them. With HMAC,
   * whoever can verify can also forge.
   */
  async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({
      fam: claims.fam,
      grants: claims.grants,
      mfa: claims.mfa,
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(this.accessTtl)
      .setJti(randomBytes(16).toString('hex'))
      .sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['EdDSA'], // pinned: stops an `alg: none` downgrade
      });

      return {
        sub: payload.sub!,
        fam: payload.fam as string,
        grants: (payload.grants as RoleAssignment[]) ?? [],
        mfa: payload.mfa === true,
      };
    } catch (error) {
      // The library's reason is not propagated: it distinguishes "expired" from
      // "bad signature", and that difference is useful to an attacker.
      const reason =
        error instanceof Error ? error.name : 'verification failed';
      throw new InvalidTokenError(reason);
    }
  }

  /**
   * Generates an opaque refresh token and its storage hash.
   *
   * It is deliberately NOT a JWT: a refresh token must be revocable, and a
   * self-contained JWT cannot be revoked before it expires. Being opaque
   * forces a database lookup on every use — which is exactly where reuse gets
   * detected.
   *
   * Only the hash is stored. If the database is stolen, active sessions are not.
   */
  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return { token, hash: TokenService.hashRefreshToken(token) };
  }

  /**
   * SHA-256 and not Argon2: this value has 256 bits of entropy, so there is no
   * dictionary to attack and a slow hash would only add latency to every
   * refresh. Argon2 is for passwords, which are low entropy.
   */
  static hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
