import { randomBytes } from 'node:crypto';

/**
 * AU-005 — the half of the second factor that works when the phone does not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN THE DOMAIN AND NOT IN THE ADAPTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same reason `credential-token.ts` and `password-hashing.ts` give: this
 * file states WHAT a backup code is — how many, which alphabet, how much
 * entropy — and none of that is a detail of PostgreSQL, of Argon2 or of HTTP.
 * A second definition of the format anywhere else is how a code that was typed
 * correctly ends up refused.
 *
 * `node:crypto` is a Node builtin, not an npm dependency: the architecture
 * check forbids the latter in this layer and this is not one.
 *
 * WHAT IS NOT HERE: the hashing. A backup code is a CREDENTIAL, so it is
 * stored with Argon2id like a password (see `BackupCode` in `schema.prisma`)
 * and the application asks `PasswordHasherPort` for it — the same port and the
 * same parameters as the password, so raising the cost raises it for both.
 * Deliberately NOT the SHA-256 of `TokenService.hashRefreshToken`: that one is
 * justified by 256 bits of entropy in the token, and 50 bits printed on paper
 * is a very different thing to leave in a stolen dump.
 */

/**
 * Crockford base32: the digits and the capitals minus `I`, `L`, `O` and `U`.
 *
 * EXACTLY 32 SYMBOLS, AND THAT IS LOAD-BEARING. 256 is divisible by 32, so
 * `byte % 32` draws every symbol with the same probability. Any other size
 * needs rejection sampling, and getting that wrong removes entropy from every
 * code without changing how a single one of them looks.
 *
 * `I`, `L` and `O` are out because this is read off paper by somebody who
 * cannot get into the clinic — they map onto `1`, `1` and `0` when the code is
 * typed back, which is what `normalizeBackupCode` does. `U` is out because
 * Crockford leaves it out, so that a random draw cannot spell something the
 * clinic would rather not print.
 */
export const BACKUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Symbols per code. Ten of them, in two groups of five. */
export const BACKUP_CODE_LENGTH = 10;

/**
 * 50 bits — ten symbols out of an alphabet of 32, five bits each.
 *
 * LESS THAN A REFRESH TOKEN'S 256 ON PURPOSE, because a human types this one.
 * What makes 50 enough is that guessing is not a free activity: a wrong backup
 * code counts towards `MAX_MFA_ATTEMPTS` exactly like a wrong TOTP, so an
 * account locks after three, and the per-IP throttle bounds the rate on top.
 * Against a batch of ten live codes, a single blind guess lands with
 * probability 10/2^50 — one in a hundred thousand billion.
 */
export const BACKUP_CODE_BITS = BACKUP_CODE_LENGTH * 5;

/**
 * Codes handed over per enrolment.
 *
 * TEN, and the number is a compromise between two costs that pull opposite
 * ways.
 *
 *   - Too few and the requirement fails on its own terms: whoever lost the
 *     phone needs one to sign in, one more the next morning, and several more
 *     while an administrator arranges a new device. Running out puts them back
 *     where they started, which is locked out of the medical records.
 *   - Too many and every verification gets slower, because there is no way to
 *     look a code up. See the cost note below.
 *
 * ⚠️ WHAT VERIFYING ONE COSTS — read before raising this number. The stored
 * hash is Argon2id, which is SALTED, so a presented code cannot be hashed and
 * looked up: it has to be tried against each live hash in turn. A wrong code
 * therefore costs N Argon2 verifications at the password parameters (19 MiB,
 * t=2 — about 50 ms each on the target hardware), so N=10 means roughly half a
 * second of CPU per failed attempt, and about half of that on average for a
 * successful one, which stops at the match.
 *
 * That is bounded, and here is by what: three failures lock the account
 * (`MAX_MFA_ATTEMPTS`), and the route is throttled per IP. Raising this to
 * fifty would turn a single throttled attacker into a permanent 40 % of one
 * core, so the number is not free and must not be raised without redoing this
 * arithmetic.
 */
export const BACKUP_CODE_COUNT = 10;

/** How the ten symbols are split for printing. */
const GROUP_LENGTH = 5;

/**
 * A generated code in its two shapes.
 *
 * They exist as one value rather than as a string plus a convention because
 * the two are not interchangeable: `display` is what the person copies off the
 * screen, `canonical` is what gets hashed. Returning only one of them puts a
 * `normalizeBackupCode(...)!` in the calling service, and a non-null assertion
 * is exactly the kind of claim that stops being true later.
 */
export interface GeneratedBackupCode {
  /** `ABCDE-FGHJK` — shown once, printed, kept in a wallet. */
  readonly display: string;
  /** `ABCDEFGHJK` — what is hashed and what a presented code normalises to. */
  readonly canonical: string;
}

/** `ABCDEFGHJK` → `ABCDE-FGHJK`. */
export function formatBackupCode(canonical: string): string {
  return `${canonical.slice(0, GROUP_LENGTH)}-${canonical.slice(GROUP_LENGTH)}`;
}

/**
 * A fresh batch. The plaintext exists for the length of one HTTP response and
 * is never stored, so this is the only moment it can be shown.
 */
export function generateBackupCodes(
  count: number = BACKUP_CODE_COUNT,
): GeneratedBackupCode[] {
  const codes: GeneratedBackupCode[] = [];

  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(BACKUP_CODE_LENGTH);
    let canonical = '';
    for (const byte of bytes) {
      // Unbiased because the alphabet has exactly 32 symbols; see above.
      canonical += BACKUP_CODE_ALPHABET[byte % BACKUP_CODE_ALPHABET.length];
    }
    codes.push({ canonical, display: formatBackupCode(canonical) });
  }

  return codes;
}

/**
 * What a person typed → the canonical form, or `null` if it is not a backup
 * code at all.
 *
 * ⚠️ THE `null` IS A DECISION ABOUT THE INPUT, NEVER ABOUT THE ACCOUNT. It
 * says «this string is not shaped like a backup code», which depends only on
 * what the caller sent and therefore tells them nothing they did not already
 * know. It is what lets a wrong six-digit TOTP skip the Argon2 loop entirely.
 * Whether the account HAS live codes must not change anything an attacker can
 * observe — not the response, and as far as it can be helped, not the timing
 * either; that part is handled where the loop is.
 *
 * The Crockford readings (`O`→`0`, `I`/`L`→`1`) and the tolerance for case,
 * spaces and the hyphen are the whole point of choosing this alphabet: the
 * person doing the typing is locked out and reading their own handwriting.
 */
export function normalizeBackupCode(input: string): string | null {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  if (canonical.length !== BACKUP_CODE_LENGTH) return null;

  for (const symbol of canonical) {
    if (!BACKUP_CODE_ALPHABET.includes(symbol)) return null;
  }

  return canonical;
}
