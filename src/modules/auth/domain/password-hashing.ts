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
 * `needsRehash` compares only the cost parameters — it does not accept the
 * algorithm. Derived from the object above so the two cannot drift apart.
 */
export const REHASH_CHECK_OPTIONS = {
  memoryCost: PASSWORD_HASHING.memoryCost,
  timeCost: PASSWORD_HASHING.timeCost,
  parallelism: PASSWORD_HASHING.parallelism,
};
