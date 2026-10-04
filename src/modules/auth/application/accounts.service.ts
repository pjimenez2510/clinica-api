import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared/authorisation/principal';
import { assertScopesInScope } from '../../../shared/authorisation/site-scope';
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
  type AccountListItem,
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
import {
  CredentialInvitationsService,
  type IssuedInvitation,
} from './credential-invitations.service';
import { REFRESH_TOKENS, type RefreshTokenPort } from './ports';

/** The permission whose loss locks the installation (AU-024). */
const ADMINISTERS_USERS = 'user:manage';

/**
 * AU-020. No password field: AU-021 forbids the administrator choosing one. The
 * cedula is optional because reception and billing sign nothing; when present
 * it is validated by the `Cedula` value object in the DTO.
 */
export interface CreateAccountCommand {
  email: string;
  firstName: string;
  lastName: string;
  cedula?: string | null;
}

/**
 * AU-025. No `email`: it is the sign-in identifier and appears in every audit
 * row this person produced. For `cedula`, `undefined` leaves it alone and
 * `null` clears it — see `update`.
 */
export interface UpdateAccountCommand {
  firstName?: string;
  lastName?: string;
  cedula?: string | null;
}

/** AU-021, AU-026, AU-029: the account, and what happened to its invitation. */
export interface CreatedAccount {
  account: AccountView;
  invitation: IssuedInvitation;
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
 * AU-021 IS NOW COMPLETE (D-013, resolved 13-08-2026). `create` still writes
 * `UNUSABLE_PASSWORD_HASH` — the administrator does not choose anybody's
 * password, which is the prohibition AU-021 actually states — and it now also
 * issues a single-use invitation that is mailed to the person, who sets their
 * own. The delivery itself belongs to `CredentialInvitationsService`; this one
 * only asks for it, and reports whether it left.
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
    /**
     * A COLLABORATOR, like `AuthAdminAuditTrail`, and not a port.
     *
     * Both are application services of this same module, so there is no layer
     * being crossed and nothing to invert: what would be gained by a port is
     * the ability to swap the invitation flow for another one, and D-013 is
     * the decision that says there is only one. Delivery is already behind a
     * port where it matters — `MAILER` — which is the boundary that will
     * actually move.
     */
    private readonly invitations: CredentialInvitationsService,
  ) {}

  /**
   * AU-022: deactivated accounts travel only when explicitly asked for.
   * AU-047: each with its live grants.
   */
  async list(filter: AccountListFilter): Promise<readonly AccountListItem[]> {
    return this.accounts.list(filter);
  }

  /**
   * 404 when the id names no account; never a view of the hash (`AccountView`
   * has no field for it).
   */
  async get(id: string): Promise<AccountView> {
    const account = await this.accounts.findById(id);
    if (!account) throw new UserNotFoundError();

    return account;
  }

  /**
   * AU-020, AU-021, AU-025, AU-026, AU-029.
   *
   * The account is created WITHOUT a usable credential and that is not a stub:
   * AU-021 forbids the administrator choosing somebody else's password,
   * because then they know it and the trail's non-repudiation evaporates. What
   * makes the account usable is the invitation — a single-use link mailed to
   * the institutional address, from which the person sets their own password
   * (D-013).
   *
   * ⚠️ AN E-MAIL FAILURE DOES NOT UNDO THE ACCOUNT (AU-029). It is issued
   * after the row exists and its outcome travels back in the response instead
   * of becoming an exception, because the alternatives are both worse: rolling
   * the account back turns a mail outage into «no puede darse de alta a
   * nadie», and failing the request while keeping the row leaves the
   * administrator convinced nothing happened, so they try again and get
   * `EMAIL_ALREADY_REGISTERED` — a message about e-mail addresses for a
   * problem about mail servers.
   */
  async create(
    command: CreateAccountCommand,
    requester: Requester,
  ): Promise<CreatedAccount> {
    const created = await this.accounts.create({
      // Stored lowercase so signing in does not depend on how it was typed —
      // the same normalisation `login` applies, and the unique index is what
      // makes the two agree.
      email: command.email.trim().toLowerCase(),
      firstName: command.firstName,
      lastName: command.lastName,
      cedula: command.cedula?.trim() || null,
      // AU-021: never a password an administrator chose. The invitation below
      // is what replaces this value, and only the person themselves can do it.
      passwordHash: UNUSABLE_PASSWORD_HASH,
    });

    await this.trail.record('CREATE', created.id, requester);

    const invitation = await this.invitations.issue(created.id, requester);
    return { account: created, invitation };
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
   *
   * AU-038, D-023 (option A, decided 15-08-2026). WHICH IS WHY THE SCOPE OF
   * EACH GRANT IS CHECKED HERE AND NOT BY THE GUARD: `grants[].siteId` travels
   * in the body, guards run before the pipes, and the route declared `global`.
   * That was not a missing site check on an agenda — it was PRIVILEGE
   * ESCALATION. Whoever held `user:manage` at one site could hand a second
   * account a grant with `siteId: null`, and from there the site dimension
   * means nothing anywhere in the system. `user_role_grant_no_self_grant`
   * stopped them doing it to themselves; it never stopped the second account.
   *
   * BOTH ENDS, like ST-047. The replacement is a set, so sending only the
   * caller's own site would SILENTLY REVOKE another site's grants — leaving a
   * city's reception without a role is as much theirs as granting it. What is
   * being set and what is being replaced both have to be in scope, and the
   * deliberate consequence is that a one-site administrator does not
   * administer the roles of somebody who also holds them elsewhere.
   */
  async replaceGrants(
    userId: string,
    desired: readonly GrantInput[],
    requester: Requester,
    caller: Principal,
  ): Promise<readonly GrantView[]> {
    const account = await this.accounts.findById(userId);
    if (!account) throw new UserNotFoundError();

    // AU-038, before the roles are even looked up: nothing is written, and the
    // refusal names the permission and never a site.
    assertScopesInScope(caller, 'user:manage', [
      ...desired.map((grant) => grant.siteId),
      ...(await this.accounts.listGrants(userId)).map((grant) => grant.siteId),
    ]);

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
