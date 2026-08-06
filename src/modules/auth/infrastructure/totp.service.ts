import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Secret, TOTP } from 'otpauth';

import type { Env } from '../../../shared/config/env.schema';
import { UnauthorizedError } from '../../../shared/domain/errors/domain-error';

export class InvalidTotpCodeError extends UnauthorizedError {
  readonly code = 'INVALID_TOTP_CODE';

  constructor() {
    super('TOTP code is invalid or already used');
  }
}

const ISSUER = 'Clinica';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Validation window, in steps before and after the current one.
 *
 * 1 means +/- 30 seconds, which absorbs normal clock drift between the phone
 * and the server. Every extra step widens the brute-force surface, so this
 * stays at the minimum that still works in practice.
 */
const WINDOW = 1;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

@Injectable()
export class TotpService {
  private readonly encryptionKey: Buffer;

  constructor(config: ConfigService<Env, true>) {
    // Annotated explicitly: without it `Buffer.from` cannot pick an overload,
    // because the inferred type from ConfigService is wider than `string`.
    const key: string = config.get('MFA_ENCRYPTION_KEY', { infer: true });
    this.encryptionKey = Buffer.from(key, 'base64');

    if (this.encryptionKey.length !== 32) {
      throw new Error(
        'MFA_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM',
      );
    }
  }

  /**
   * Creates a secret for enrolment and returns the URI for the QR code.
   *
   * The secret is returned in clear so it can be shown once; what gets stored
   * is `encrypted`.
   */
  enroll(email: string): { secret: string; encrypted: string; uri: string } {
    const secret = new Secret({ size: 20 });
    const totp = this.build(secret, email);

    return {
      secret: secret.base32,
      encrypted: this.encrypt(secret.base32),
      uri: totp.toString(),
    };
  }

  /**
   * Verifies a code and returns the time step it consumed.
   *
   * THE CALLER MUST PERSIST that step and reject any code whose step is less
   * than or equal to the last stored one. Without that check an intercepted
   * code stays usable for the full 30 seconds it remains valid — which is
   * exactly the window a phishing proxy needs.
   *
   * Returning the step instead of doing the check here keeps this service free
   * of database access, so it stays trivially testable.
   */
  verify(
    encryptedSecret: string,
    code: string,
    email: string,
    lastUsedStep: bigint | null,
  ): bigint {
    const secret = Secret.fromBase32(this.decrypt(encryptedSecret));
    const totp = this.build(secret, email);

    // `validate` returns the delta in steps, or null when it does not match.
    const delta = totp.validate({ token: code, window: WINDOW });
    if (delta === null) throw new InvalidTotpCodeError();

    const currentStep = BigInt(Math.floor(Date.now() / 1000 / PERIOD_SECONDS));
    const usedStep = currentStep + BigInt(delta);

    // Replay: this step was already consumed.
    if (lastUsedStep !== null && usedStep <= lastUsedStep) {
      throw new InvalidTotpCodeError();
    }

    return usedStep;
  }

  private build(secret: Secret, email: string): TOTP {
    return new TOTP({
      issuer: ISSUER,
      label: email,
      algorithm: 'SHA1', // what every authenticator app supports
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret,
    });
  }

  /**
   * AES-256-GCM. GCM and not CBC because it authenticates: a tampered
   * ciphertext fails to decrypt instead of yielding garbage that then gets
   * treated as a valid secret.
   */
  private encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    // iv | authTag | ciphertext, all in one base64 string.
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
  }

  private decrypt(payload: string): string {
    const buffer = Buffer.from(payload, 'base64');
    const iv = buffer.subarray(0, IV_BYTES);
    const authTag = buffer.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = buffer.subarray(IV_BYTES + AUTH_TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
