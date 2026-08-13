/**
 * How expensive a password must be to verify. OWASP's interactive baseline.
 *
 * NO IMPORT OF `argon2` HERE, and `dependency-cruiser` is right to insist: the
 * domain states the POLICY — which algorithm, and how much work — while the
 * adapter is what knows the library constant that expresses it. The first
 * version of this file imported argon2 for `argon2.argon2id` and the
 * architecture check caught it.
 *
 * It lives in the domain, free of decorators, for a second reason: the
 * development seed imports these so it hashes with the SAME parameters the
 * application does. Node runs that seed with type stripping, which cannot
 * handle an `@Injectable()` class — so keeping them in the adapter made the
 * seed unrunnable.
 *
 * WHY ONE DEFINITION MATTERS: raising `memoryCost` is exactly the scenario
 * `needsRehash` exists to support. With a second copy in the seed, the
 * development password would keep being hashed with the old parameters and
 * silently rehashed on every single login.
 */
export const PASSWORD_HASHING = {
  /** Argon2id: resists both GPU cracking and side-channel attacks. */
  algorithm: 'argon2id',
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * AU-021 — the placeholder that means «esta cuenta todavía no puede entrar».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEAM WHERE D-013 PLUGS IN. READ BEFORE CHANGING ANYTHING HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AU-021 fixes what must NOT happen: the administrator does not choose another
 * person's password, because then they know it and the trail's non-repudiation
 * evaporates. What it does not fix is HOW the first credential reaches the
 * person — by email, or handed over on screen — and that is **D-013, still
 * unanswered**. Inventing a delivery mechanism here would be exactly the kind
 * of policy decision an agent does not take (constitution §8).
 *
 * So `POST /auth/users` creates the account with THIS value as its hash, and
 * the account cannot sign in: `PasswordHasher.verify` runs `argon2.verify`
 * against a string that is not an Argon2 hash, which throws, which that method
 * turns into `false`. The account therefore answers `INVALID_CREDENTIALS` like
 * any wrong password — with no way to tell it apart, which is AU-002.
 *
 * A LEADING `!` AND NOT AN EMPTY STRING, and not a random value either. Argon2
 * hashes always start with `$argon2`, so no hash the hasher can ever produce
 * collides with this; an empty string would be indistinguishable from a column
 * somebody forgot to fill, and a random value would be a credential nobody
 * knows — which looks identical but cannot be DETECTED, so the screen could
 * not tell the administrator the account is still unusable.
 *
 * WHEN D-013 IS ANSWERED: the account creation flow keeps writing this value
 * and additionally issues whatever D-013 chose — a single-use link, or a code
 * shown once on screen — and the redemption of that credential is what
 * replaces this hash. Nothing else in the system needs to change: everything
 * already treats an unusable hash as "cannot sign in".
 */
export const UNUSABLE_PASSWORD_HASH = '!no-usable-credential';

/**
 * `needsRehash` compares only the cost parameters — it does not accept the
 * algorithm. Derived from the object above so the two cannot drift apart.
 */
export const REHASH_CHECK_OPTIONS = {
  memoryCost: PASSWORD_HASHING.memoryCost,
  timeCost: PASSWORD_HASHING.timeCost,
  parallelism: PASSWORD_HASHING.parallelism,
};
