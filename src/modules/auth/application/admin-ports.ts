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

export interface CreateAccountInput {
  email: string;
  firstName: string;
  lastName: string;
  cedula: string | null;
  /** Already hashed, or the unusable sentinel of AU-021. Never plaintext. */
  passwordHash: string;
}

export interface AccountPatch {
  firstName?: string;
  lastName?: string;
  cedula?: string | null;
}

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

export interface GrantInput {
  roleId: string;
  siteId: string | null;
}

export interface AccountAdminRepositoryPort {
  list(filter: AccountListFilter): Promise<readonly AccountView[]>;
  findById(id: string): Promise<AccountView | null>;
  /** Throws `EmailAlreadyRegisteredError` when the unique index refuses. */
  create(input: CreateAccountInput): Promise<AccountView>;
  /** `null` when the row is gone; the service owns the refusal. */
  update(id: string, patch: AccountPatch): Promise<AccountView | null>;
  setActive(id: string, active: boolean): Promise<AccountView | null>;

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

export interface CreateRoleInput {
  code: string;
  name: string;
  description: string | null;
}

export interface RolePatch {
  name?: string;
  description?: string | null;
  active?: boolean;
}

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
