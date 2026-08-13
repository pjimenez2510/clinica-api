import { createHash, randomBytes } from 'node:crypto';

/**
 * What a first-credential token IS: how much entropy, and how it is stored.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN THE DOMAIN AND NOT IN THE ADAPTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exactly the reason `PASSWORD_HASHING` gives, and the same failure it avoids.
 * The development seed has to be able to produce an invitation — that is the
 * only way to try «este enlace ya no sirve» by hand, since neither an expired
 * nor a spent link can be reached through the interface — and Node runs those
 * seeds with type stripping, which cannot handle an `@Injectable()` class. Put
 * the generation in the adapter and the seed has to hash the token itself,
 * which is a SECOND definition of how a credential is stored: change the
 * algorithm here and the seeded links silently stop matching.
 *
 * `node:crypto` is a Node builtin, not a framework: the architecture check
 * forbids npm dependencies in this layer, and this is not one.
 */

/**
 * Bytes of entropy in the token.
 *
 * THE SAME 32 AS A REFRESH TOKEN, for a stronger reason. This one travels in a
 * URL, sits in a mailbox and is reachable by an ANONYMOUS caller for 72 hours;
 * guessing it sets the password of an account that may read medical records.
 * 256 bits is not guessable at any rate an attacker can reach, which is what
 * makes the rate limit on the public endpoints a second line of defence rather
 * than the only one.
 */
export const CREDENTIAL_TOKEN_BYTES = 32;

/**
 * SHA-256, NOT Argon2, exactly as `TokenService.hashRefreshToken` explains:
 * the value has 256 bits of entropy so there is no dictionary to attack, and a
 * slow hash would only add latency to every check of a link. Argon2 is for
 * passwords — which is what this link is used to set.
 */
export function hashCredentialToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A fresh token and the hash that is stored IN ITS PLACE.
 *
 * `base64url` because the token goes in a query string: base64 proper brings
 * `+` and `/`, which have to be percent-encoded and get mangled by every mail
 * client that decides to «helpfully» rewrite a URL.
 */
export function generateCredentialToken(): { token: string; hash: string } {
  const token = randomBytes(CREDENTIAL_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashCredentialToken(token) };
}
