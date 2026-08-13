import { Inject, Injectable } from '@nestjs/common';

import { RevocationReason } from '../../../shared/request/client-context';
import {
  CannotDemoteSelfError,
  CannotGrantToSelfError,
  RoleNotFoundError,
  UserNotFoundError,
} from '../domain/auth.errors';
import { UNUSABLE_PASSWORD_HASH } from '../domain/password-hashing';

import {
  ACCOUNT_ADMIN_REPOSITORY,
  type AccountAdminRepositoryPort,
  type AccountListFilter,
  type AccountView,
  type GrantInput,
  type GrantView,
  ROLE_ADMIN_REPOSITORY,
  type RoleAdminRepositoryPort,
  ROLE_PERMISSION_CACHE,
  type RolePermissionCachePort,
} from './admin-ports';
import { AuthAdminAuditTrail, type Requester } from './auth-admin-audit.trail';
import { REFRESH_TOKENS, type RefreshTokenPort } from './ports';

/** The permission whose loss locks the installation (AU-024). */
const ADMINISTERS_USERS = 'user:manage';

export interface CreateAccountCommand {
  email: string;
  firstName: string;
  lastName: string;
  cedula?: string | null;
}

export interface UpdateAccountCommand {
  firstName?: string;
  lastName?: string;
  cedula?: string | null;
}

/**
 * Accounts and their role grants: AU-020 to AU-025, AU-032.
 *
 * SPLIT FROM `RolesService` per ADR-008 §2. Together they are twelve public
 * use cases, over the eight the convention allows, and they change for
 * different reasons — this one for how a person is hired and let go, that one
 * for what the clinic's roles mean. What they genuinely share is AU-024, and
 * that is why the check lives in a place both can reach: the repository query
 * `permissionsOf`, not a copied `if`.
 *
 * ⚠️ AU-021 IS NOT FINISHED, AND CANNOT BE. `create` makes an account that
 * CANNOT SIGN IN — see `UNUSABLE_PASSWORD_HASH` for the whole reasoning — and
 * whatever delivers the first credential is **D-013, still unanswered**. Until
 * it is, giving somebody an account is a two-step process whose second step
 * does not exist yet in software.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(ACCOUNT_ADMIN_REPOSITORY)
    private readonly accounts: AccountAdminRepositoryPort,
    @Inject(ROLE_ADMIN_REPOSITORY)
    private readonly roles: RoleAdminRepositoryPort,
    @Inject(REFRESH_TOKENS)
    private readonly refreshTokens: RefreshTokenPort,
    @Inject(ROLE_PERMISSION_CACHE)
    private readonly cache: RolePermissionCachePort,
    private readonly trail: AuthAdminAuditTrail,
  ) {}

  /** AU-022: deactivated accounts travel only when explicitly asked for. */
  async list(filter: AccountListFilter): Promise<readonly AccountView[]> {
    return this.accounts.list(filter);
  }

  async get(id: string): Promise<AccountView> {
    const account = await this.accounts.findById(id);
    if (!account) throw new UserNotFoundError();

    return account;
  }

  /**
   * AU-020, AU-021, AU-025.
   *
   * The account is created WITHOUT a usable credential, on purpose and not as
   * a stub: AU-021 forbids the administrator choosing somebody else's
   * password, and how the first one reaches the person is D-013 — a policy
   * decision that is not an agent's to take. The account exists, can be given
   * roles, and cannot sign in until a credential is set.
   */
  async create(
    command: CreateAccountCommand,
    requester: Requester,
  ): Promise<AccountView> {
    const created = await this.accounts.create({
      // Stored lowercase so signing in does not depend on how it was typed —
      // the same normalisation `login` applies, and the unique index is what
      // makes the two agree.
      email: command.email.trim().toLowerCase(),
      firstName: command.firstName,
      lastName: command.lastName,
      cedula: command.cedula?.trim() || null,
      // ⚠️ D-013's seam. See `UNUSABLE_PASSWORD_HASH`.
      passwordHash: UNUSABLE_PASSWORD_HASH,
    });

    await this.trail.record('CREATE', created.id, requester);
    return created;
  }

  /** AU-025. The email is not patchable — see the DTO for why. */
  async update(
    id: string,
    command: UpdateAccountCommand,
    requester: Requester,
  ): Promise<AccountView> {
    const updated = await this.accounts.update(id, {
      firstName: command.firstName,
      lastName: command.lastName,
      // `undefined` leaves it alone, `null` clears it; collapsing the two
      // would erase a practitioner's cedula on every rename, and without the
      // cedula they cannot sign a prescription.
      cedula:
        command.cedula === undefined
          ? undefined
          : command.cedula?.trim() || null,
    });
    if (!updated) throw new UserNotFoundError();

    await this.trail.record('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * AU-022, AU-023, AU-024, AU-025.
   *
   * DEACTIVATE, NEVER DELETE: the accesses of this person are in the trail,
   * and deleting the account would orphan the evidence the LOPDP requires
   * (REQ-110). There is no `delete` on this service at all, which is how the
   * requirement is enforced rather than remembered.
   *
   * AU-023 is the second half and it is not optional: revoking the refresh
   * tokens is what actually ENDS the open sessions. Without it, a deactivated
   * account keeps refreshing indefinitely and «desactivar» means nothing until
   * the person signs out voluntarily.
   */
  async deactivate(id: string, requester: Requester): Promise<AccountView> {
    // AU-024, shape one. Checked FIRST, before touching anything: an
    // administrator who deactivates their own account is locked out by the
    // very next request, and there is nobody left with a session to undo it.
    if (id === requester.userId) {
      throw new CannotDemoteSelfError(
        'An administrator cannot deactivate their own account',
      );
    }

    const updated = await this.accounts.setActive(id, false);
    if (!updated) throw new UserNotFoundError();

    // AU-023. After the flag, not before: if this failed first the account
    // would still be active and the caller would think nothing happened.
    await this.refreshTokens.revokeAllForUser(
      id,
      RevocationReason.ACCOUNT_DEACTIVATED,
    );

    await this.trail.record('UPDATE', updated.id, requester);
    return updated;
  }

  /** AU-022, AU-025. Reactivating does not restore any session, only access. */
  async activate(id: string, requester: Requester): Promise<AccountView> {
    const updated = await this.accounts.setActive(id, true);
    if (!updated) throw new UserNotFoundError();

    await this.trail.record('UPDATE', updated.id, requester);
    return updated;
  }

  /** AU-032. Revoked grants do not travel: they are trail, not state. */
  async listGrants(userId: string): Promise<readonly GrantView[]> {
    await this.get(userId);
    return this.accounts.listGrants(userId);
  }

  /**
   * AU-032, AU-024, AU-025.
   *
   * WHY A REPLACEMENT AND NOT grant/revoke: the screen sends the checkbox
   * state, and expressing it as a set makes «lo que esta persona tiene» a
   * single fact rather than the outcome of a sequence somebody could
   * interrupt halfway.
   *
   * THE SITE SCOPE IS PART OF THE IDENTITY of a grant: the same role at two
   * sites is two grants, and «todas las sedes» (`siteId: null`) is a third
   * thing that is not the union of them — it keeps applying when a new site
   * opens.
   */
  async replaceGrants(
    userId: string,
    desired: readonly GrantInput[],
    requester: Requester,
  ): Promise<readonly GrantView[]> {
    const account = await this.accounts.findById(userId);
    if (!account) throw new UserNotFoundError();

    // Every role has to exist before anything is written. Doing it inside the
    // replacement would leave the account with the roles that happened to be
    // processed before the bad one.
    for (const grant of desired) {
      const role = await this.roles.findById(grant.roleId);
      if (!role) throw new RoleNotFoundError();
    }

    // AU-024, shape two: the caller changing their OWN grants must not end up
    // without `user:manage`. Computed on the RESULT, because a grant can carry
    // the permission through any of several roles and losing one is only a
    // problem if no other one carries it.
    if (userId === requester.userId) {
      await this.assertKeepsAdministration(desired);
      await this.assertGrantsNothingToSelf(userId, desired);
    }

    const grants = await this.accounts.replaceGrants(
      userId,
      desired,
      requester.userId,
    );

    // AU-012, AU-032: the change has to be in force NOW, not in thirty
    // seconds. The token carries the role IDS, so a grant added here reaches
    // the caller's own requests as soon as their token is refreshed; what this
    // makes immediate is the resolution of those roles into permissions.
    this.cache.invalidate();

    await this.trail.record('UPDATE', userId, requester);
    return grants;
  }

  /**
   * AU-024. Would the caller still administer users with exactly these grants?
   *
   * Resolved through the ROLES, not through a copy of the permission list: a
   * role's permissions are data an administrator edits, and a check written
   * against yesterday's copy would let the last administrator out on a
   * technicality.
   */
  private async assertKeepsAdministration(
    desired: readonly GrantInput[],
  ): Promise<void> {
    const administering = await this.roles.rolesGranting(ADMINISTERS_USERS);
    const administeringIds = new Set(administering.map((role) => role.id));

    if (desired.some((grant) => administeringIds.has(grant.roleId))) return;

    throw new CannotDemoteSelfError(
      'An administrator cannot remove their own user administration',
    );
  }

  /**
   * Separation of duties, from `user_role_grant_no_self_grant`.
   *
   * The CHECK has been in the base since the roles migration, with its reason
   * beside it: the audit question «who gave this person access to clinical
   * records» must never answer «they did». Reaching it produces a bare
   * `CHECK_FAILED`, which tells a clinic nothing, so the refusal is made here
   * and the constraint stays as the net for a write that arrives another way.
   *
   * Only ADDITIONS are refused. Revoking one of your own roles is a legitimate
   * thing to do — an administrator who also happens to be a doctor giving up
   * the clinical half — and AU-024 is what stops you revoking the one that
   * matters.
   */
  private async assertGrantsNothingToSelf(
    userId: string,
    desired: readonly GrantInput[],
  ): Promise<void> {
    const identity = (grant: {
      roleId: string;
      siteId: string | null;
    }): string => `${grant.roleId}@${grant.siteId ?? 'ALL'}`;

    const current = new Set(
      (await this.accounts.listGrants(userId)).map(identity),
    );

    if (desired.every((grant) => current.has(identity(grant)))) return;

    throw new CannotGrantToSelfError();
  }
}
