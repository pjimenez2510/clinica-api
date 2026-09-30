/**
 * Ports the ADMINISTRATION use cases depend on (A2: AU-020..AU-034).
 *
 * SEPARATE FROM `ports.ts`, which belongs to the session half built in phase 0.
 * The two halves share the `app_user` table and nothing else: one verifies
 * credentials and issues tokens, the other manages who exists and what they
 * may do. Putting eleven more methods on `AuthUserRepositoryPort` would have
 * meant every sign-in test faking a role listing.
 *
 * WHAT IS DELIBERATELY ABSENT: any «is this email free?» or «does this role
 * code exist?» query. Both are unique indexes, and a check-first method is an
 * invitation to read, decide and lose the race the index exists to close. The
 * adapters let PostgreSQL arbitrate and translate the refusals into
 * `EMAIL_ALREADY_REGISTERED` and `ROLE_CODE_DUPLICATE`.
 */

/** An account as the administration screen lists it. NEVER carries the hash. */
export interface AccountView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  cedula: string | null;
  active: boolean;
  /** AU-005: whether the second factor is confirmed, not its secret. */
  mfaEnabled: boolean;
  /**
   * AU-021: the account exists but cannot sign in yet, because no usable
   * credential has been set. The screen has to say so — an account that
   * silently cannot be used looks like a broken login to the person holding it.
   */
  credentialPending: boolean;
}

/**
 * What the adapter inserts. The email arrives already lowercased by
 * `AccountsService.create` — the normalisation sign-in applies too.
 */
export interface CreateAccountInput {
  email: string;
  firstName: string;
  lastName: string;
  cedula: string | null;
  /** Already hashed, or the unusable sentinel of AU-021. Never plaintext. */
  passwordHash: string;
}

/**
 * AU-025. Absent fields are left untouched; `cedula: null` clears it. The email
 * is deliberately absent — see the adapter's `update`.
 */
export interface AccountPatch {
  firstName?: string;
  lastName?: string;
  cedula?: string | null;
}

/**
 * AU-020, AU-022: the listing criteria the administration screen can ask for.
 */
export interface AccountListFilter {
  /** AU-022: deactivated accounts travel only when explicitly asked for. */
  includeInactive: boolean;
  /** Name or email. Never a cedula: that is a document, not a search box. */
  search?: string;
}

/** A role held by an account, at one site or everywhere (AU-032). */
export interface GrantView {
  roleId: string;
  roleCode: string;
  roleName: string;
  /** `null` = every site. */
  siteId: string | null;
}

/**
 * One desired grant for `replaceGrants`. `siteId: null` is a global grant —
 * every site, present and future — which AU-038 reserves to clinic-level
 * `user:manage`.
 */
export interface GrantInput {
  roleId: string;
  siteId: string | null;
}

/**
 * Who asked for the reset, so the trail entry can be written WITH it (AU-035).
 *
 * It travels into the port — rather than being recorded by the use case
 * afterwards — because the entry and the reset must land together. See
 * `resetMfa` for the argument.
 *
 * The SHAPE is what keeps AU-025 true: there is nowhere here to put a secret,
 * a hash or a backup code. Only who, from where, and with what.
 */
export interface MfaResetAuthor {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * The account half of administration (AU-020..AU-025, AU-032, AU-035). No «is
 * this email free?» method, on purpose — see the file header.
 */
export interface AccountAdminRepositoryPort {
  list(filter: AccountListFilter): Promise<readonly AccountView[]>;
  findById(id: string): Promise<AccountView | null>;
  /** Throws `EmailAlreadyRegisteredError` when the unique index refuses. */
  create(input: CreateAccountInput): Promise<AccountView>;
  /** `null` when the row is gone; the service owns the refusal. */
  update(id: string, patch: AccountPatch): Promise<AccountView | null>;
  setActive(id: string, active: boolean): Promise<AccountView | null>;
  /**
   * AU-035, AU-036. Removes the account's second factor, its backup codes and
   * its open sessions, AND writes the trail entry — ALL FOUR, OR NONE. `null`
   * when the row is gone.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE OPERATION, AND THE ATOMICITY IS THE REQUIREMENT, NOT AN OPTIMISATION.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Expressed here as a single method for the same reason as
   * `rotateCredentials` and `confirmMfaWithBackupCodes`: each pair of these
   * writes has a half-applied state that is worse than the failure.
   *
   *   - SECRET CLEARED, CODES ALIVE: ten credentials that open an account
   *     whose second factor the screen now reports as removed. They were
   *     printed for a phone that is gone, which is why the reset was asked
   *     for.
   *   - CODES DELETED, SECRET ALIVE: the person still needs the authenticator
   *     they just lost, and now has no backup either — the exact lockout A4
   *     exists to end, caused by the operation meant to fix it.
   *   - FACTOR GONE, SESSIONS ALIVE (AU-036): the sessions that only exist
   *     because that factor was satisfied outlive it. Same argument as
   *     `rotateCredentials`, where a revocation that fails after the password
   *     changed leaves the attacker's session alive.
   *   - RESET APPLIED, NOBODY RECORDED: the doctor loses their second factor
   *     and every session, and no row says who did it. THE ENTRY IS THE
   *     REQUIREMENT here, not bookkeeping — it is the only thing that makes
   *     granting `user:reset-mfa` defensible before the SPDP (REQ-110), and
   *     this permission is the one that lets somebody take over another
   *     person's account. So this act, alone in the module, FAILS CLOSED when
   *     it cannot be recorded. `AccessAuditRecorder` is the right policy for
   *     everything else — a database hiccup must not deny a doctor a chart —
   *     and its own comment already named this as the exception, so this write
   *     deliberately does not reuse that path.
   *
   * The transaction is the adapter's business. What the application declares
   * is that these cannot come apart.
   *
   * IT DOES NOT TOUCH THE PASSWORD, and there is no parameter for it: the
   * person still needs their own to sign in, and whoever resets never learns
   * any credential (AU-035).
   *
   * IDEMPOTENT ON PURPOSE. An account with no second factor is not a refusal:
   * what is being asked for is a STATE — «esta cuenta no tiene segundo
   * factor» — and it already holds. Two support staff clicking on the same
   * ticket, or a retried request, must not produce an error that reads like a
   * failure.
   */
  resetMfa(
    userId: string,
    revocationReason: string,
    author: MfaResetAuthor,
  ): Promise<AccountView | null>;

  listGrants(userId: string): Promise<readonly GrantView[]>;
  /**
   * Makes the account's live grants EXACTLY the ones given (AU-032).
   *
   * Expressed as a replacement rather than grant/revoke pairs because that is
   * what the screen does — it sends the checkbox state — and because doing it
   * in one transaction is what stops a half-applied change from leaving
   * somebody with neither the old role nor the new one.
   *
   * A grant is REVOKED, never deleted: who could do what and when is evidence
   * the LOPDP expects (REQ-110), and a deleted row cannot answer that.
   */
  replaceGrants(
    userId: string,
    desired: readonly GrantInput[],
    grantedById: string,
  ): Promise<readonly GrantView[]>;
}

export const ACCOUNT_ADMIN_REPOSITORY = Symbol('ACCOUNT_ADMIN_REPOSITORY');

/** A role as the administration screen lists it (AU-030). */
export interface RoleView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** AU-031: ships with the product; editable, never deletable. */
  isSystem: boolean;
  active: boolean;
  /** How many accounts hold it right now. Zero is what makes it deletable. */
  liveGrants: number;
}

/**
 * AU-030. The code is arbitrated by its unique index, which the adapter
 * translates into `ROLE_CODE_DUPLICATE`.
 */
export interface CreateRoleInput {
  code: string;
  name: string;
  description: string | null;
}

/**
 * AU-030, AU-031. The code is absent: it is the role's identity, and
 * deactivating (`active: false`) is how a role in use is retired instead of
 * deleted.
 */
export interface RolePatch {
  name?: string;
  description?: string | null;
  active?: boolean;
}

/**
 * The role half of administration (AU-030..AU-034). Permissions come in as
 * codes from the catalogue in the code (D-002); this port never creates one.
 */
export interface RoleAdminRepositoryPort {
  list(includeInactive: boolean): Promise<readonly RoleView[]>;
  findById(id: string): Promise<RoleView | null>;
  /** Throws `RoleCodeDuplicateError` when the unique index refuses (AU-030). */
  create(input: CreateRoleInput): Promise<RoleView>;
  update(id: string, patch: RolePatch): Promise<RoleView | null>;
  /**
   * Hard delete (AU-031). `false` when the row does not exist; throws
   * `RoleInUseError` when a grant still references it and
   * `SystemRoleProtectedError` when the trigger refuses.
   */
  delete(id: string): Promise<boolean>;

  listPermissions(roleId: string): Promise<readonly string[]>;
  /**
   * Which of these codes the `permission` mirror actually has (AU-033).
   *
   * The catalogue the screen shows is read from the CODE, and this table is a
   * mirror published by the authorisation sync. Between a deploy and that sync
   * the two disagree, and asking BEFORE writing is what turns a foreign-key
   * violation — «Datos inválidos», on a form where nothing was invalid — into
   * `PERMISSION_NOT_INSTALLED` naming the codes.
   */
  installedPermissions(codes: readonly string[]): Promise<readonly string[]>;
  /** Makes the role's permissions EXACTLY the ones given (AU-033). */
  replacePermissions(
    roleId: string,
    codes: readonly string[],
    grantedById: string,
  ): Promise<readonly string[]>;

  /**
   * ACTIVE roles that carry this permission. AU-024 is decided with it: the
   * last one may not be deleted, deactivated or emptied.
   */
  rolesGranting(permission: string): Promise<readonly RoleView[]>;

  /** Role ids the account holds through a live grant. */
  liveRoleIdsOf(userId: string): Promise<readonly string[]>;
}

export const ROLE_ADMIN_REPOSITORY = Symbol('ROLE_ADMIN_REPOSITORY');

/**
 * Dropping the role→permission cache the moment a role changes.
 *
 * A PORT and not the registry itself, because the application layer may not
 * import infrastructure — and because what the use case actually depends on is
 * «the change takes effect now», not «there is a Map with a 30-second TTL».
 *
 * AU-032 is what makes it necessary: without the call, an administrator's
 * change waits out the TTL, and the person testing it concludes it did not
 * work and does it again.
 */
export interface RolePermissionCachePort {
  invalidate(): void;
}

export const ROLE_PERMISSION_CACHE = Symbol('ROLE_PERMISSION_CACHE');
