import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import {
  PASSWORD_HASHING,
  REHASH_CHECK_OPTIONS,
} from '../domain/password-hashing';

/**
 * The domain names the algorithm; this maps it to the library constant.
 * That indirection is what keeps `argon2` out of the domain.
 *
 * THE IMPORT ABOVE MUST STAY ABOVE THIS CONSTANT. It used to sit below, and
 * the difference is invisible until deployment: SWC compiles to ESM and hoists
 * imports, so all 137 unit tests passed, while `tsc` emitting CommonJS leaves
 * the `require` where it was written — `argon2` in the temporal dead zone, and
 * the API dead on startup with `Cannot access 'argon2' before initialization`.
 * A build that only the production output breaks is the worst kind.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: PASSWORD_HASHING.memoryCost,
  timeCost: PASSWORD_HASHING.timeCost,
  parallelism: PASSWORD_HASHING.parallelism,
} satisfies argon2.HashOptions;

/**
 * OWASP recommended Argon2id parameters.
 *
 * Argon2id and not bcrypt: bcrypt caps at 72 bytes and is cheap to attack on
 * GPUs. Argon2id is memory-hard, which is what makes a GPU farm expensive.
 *
 * These values live inside the resulting hash, so they can be raised later
 * without migrating existing rows: `needsRehash` detects the outdated ones.
 */
@Injectable()
export class PasswordHasher {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  /**
   * Verifies a password.
   *
   * Returns false instead of throwing on a malformed hash: a corrupted record
   * must read as "wrong password", never as a 500 that tells an attacker the
   * account exists but something else broke.
   */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * True when the hash was produced with weaker parameters than the current
   * ones. Call it after a successful sign-in and rehash transparently: that is
   * the only moment the plaintext password is available.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, REHASH_CHECK_OPTIONS);
    } catch {
      // Unparseable hash: force a rehash rather than keep something unknown.
      return true;
    }
  }

  /**
   * Burns roughly the same CPU as a real verification, without comparing
   * anything.
   *
   * Used when the email does not exist. Without it, sign-in answers noticeably
   * faster for unknown accounts, and that timing difference is a user
   * enumeration oracle — in a clinical system, a way to find out who is a
   * patient or a member of staff.
   */
  async burnTime(): Promise<void> {
    await argon2.hash('timing-equalizer', ARGON2_OPTIONS);
  }
}
