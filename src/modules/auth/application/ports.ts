/**
 * Ports the authentication use cases depend on.
 *
 * WHY THESE EXIST — and why there are only four.
 *
 * The dependency rule (application must not import infrastructure) is not
 * bureaucracy here: it is what makes `AuthService` testable. Without these
 * ports, testing sign-in means running real Argon2 at ~100 ms per hash and a
 * real PostgreSQL, so the tests covering the most security-critical logic in
 * the system become slow enough that people stop running them.
 *
 * They are plain interfaces plus injection tokens. No extra classes: the
 * existing infrastructure services satisfy them as they are.
 *
 * TypeScript interfaces vanish at runtime, so a `Symbol` token is required —
 * you cannot inject by interface.
 */

/** Minimum a use case needs to know about a user. */
export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  cedula: string | null;
  active: boolean;
  mfaSecretEncrypted: string | null;
  mfaEnabledAt: Date | null;
  mfaLastStep: bigint | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface PasswordHasherPort {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** Spends the same CPU as a real verification, to flatten sign-in timing. */
  burnTime(): Promise<void>;
}

export interface AccessTokenClaimsInput {
  sub: string;
  fam: string;
  roles: string[];
  mfa: boolean;
}

export interface TokenIssuerPort {
  issueAccessToken(claims: AccessTokenClaimsInput): Promise<string>;
}

export interface IssuedRefreshTokenResult {
  token: string;
  familyId: string;
  expiresAt: Date;
}

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

export interface RefreshTokenPort {
  issueForNewSession(
    userId: string,
    ctx?: ClientContext,
  ): Promise<IssuedRefreshTokenResult>;
  rotate(
    presentedToken: string,
    ctx?: ClientContext,
  ): Promise<IssuedRefreshTokenResult>;
  revokeFamily(familyId: string, reason: string): Promise<void>;
  revokeAllForUser(userId: string, reason: string): Promise<void>;
}

export interface TotpPort {
  enroll(email: string): { secret: string; encrypted: string; uri: string };
  /** Returns the consumed time step; the caller must persist it. */
  verify(
    encryptedSecret: string,
    code: string,
    email: string,
    lastUsedStep: bigint | null,
  ): bigint;
}

/** Everything the use cases need from persistence. */
export interface AuthUserRepositoryPort {
  findByEmail(email: string): Promise<AuthUser | null>;
  findById(id: string): Promise<AuthUser | null>;
  findByRefreshFamily(familyId: string): Promise<AuthUser | null>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  recordFailedAttempt(
    userId: string,
    failures: number,
    lockedUntil: Date | null,
  ): Promise<void>;
  clearFailedAttempts(userId: string): Promise<void>;
  savePendingMfaSecret(userId: string, encryptedSecret: string): Promise<void>;
  confirmMfa(userId: string, usedStep: bigint): Promise<void>;
  recordMfaStep(userId: string, usedStep: bigint): Promise<void>;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');
export const REFRESH_TOKENS = Symbol('REFRESH_TOKENS');
export const TOTP = Symbol('TOTP');
export const AUTH_USER_REPOSITORY = Symbol('AUTH_USER_REPOSITORY');
