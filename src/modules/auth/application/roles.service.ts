import { Inject, Injectable } from '@nestjs/common';

import {
  PERMISSION_CATALOGUE,
  PERMISSIONS,
  type PermissionDefinition,
} from '../../../shared/authorisation/permission.catalogue';
import {
  CannotDemoteSelfError,
  RoleNotFoundError,
  SystemRoleProtectedError,
  UnknownPermissionError,
} from '../domain/auth.errors';
import { warningsFor } from '../domain/role-risk';

import {
  ROLE_ADMIN_REPOSITORY,
  type RoleAdminRepositoryPort,
  ROLE_PERMISSION_CACHE,
  type RolePermissionCachePort,
  type RoleView,
} from './admin-ports';
import { AuthAdminAuditTrail, type Requester } from './auth-admin-audit.trail';

/** The permission whose loss locks the installation (AU-024). */
const ADMINISTERS_USERS = 'user:manage';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

export interface CreateRoleCommand {
  code: string;
  name: string;
  description?: string | null;
}

export interface UpdateRoleCommand {
  name?: string;
  description?: string | null;
  active?: boolean;
}

/**
 * What a role is and what it carries: AU-030, AU-031, AU-033, AU-034, and the
 * two shapes of AU-024 that are about roles rather than about accounts.
 *
 * ROLES ARE DATA; PERMISSIONS ARE CODE. That asymmetry is the whole design and
 * it shows up in every method here: a clinic invents a role — an external
 * auditor, an insurance liaison — without a deploy, and cannot invent a
 * permission, because a permission only protects something if a route asks for
 * it. `UNKNOWN_PERMISSION` is what enforces the second half (AU-033, D-002).
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(ROLE_ADMIN_REPOSITORY)
    private readonly roles: RoleAdminRepositoryPort,
    @Inject(ROLE_PERMISSION_CACHE)
    private readonly cache: RolePermissionCachePort,
    private readonly trail: AuthAdminAuditTrail,
  ) {}

  /** AU-031: deactivated roles travel only when explicitly asked for. */
  async list(includeInactive: boolean): Promise<readonly RoleView[]> {
    return this.roles.list(includeInactive);
  }

  /**
   * AU-033. The catalogue WITH its resource and its description, because
   * whoever assigns a permission has to know what they are granting — a screen
   * showing `record:sign` and nothing else is a screen where people tick boxes
   * by their shape.
   *
   * Read from the CODE and not from the `permission` table: the table is a
   * mirror kept for referential integrity, and if the two ever drift, the code
   * is the one that decides what a route actually checks.
   */
  catalogue(): readonly PermissionDefinition[] {
    return PERMISSION_CATALOGUE;
  }

  /** AU-030. `ROLE_CODE_DUPLICATE` comes from the unique index, not a read. */
  async create(
    command: CreateRoleCommand,
    requester: Requester,
  ): Promise<RoleView> {
    const created = await this.roles.create({
      code: command.code,
      name: command.name,
      description: command.description ?? null,
    });

    await this.trail.record('CREATE', created.id, requester);
    return created;
  }

  /**
   * AU-030, AU-031, AU-024.
   *
   * The CODE is not patchable, and neither is `isSystem`. The code identifies
   * the role in seeds, in logs and in support conversations, and the database
   * refuses to change it on a system role anyway (`trg_role_protect_system`);
   * the name is what an administrator actually wants to change.
   */
  async update(
    id: string,
    command: UpdateRoleCommand,
    requester: Requester,
  ): Promise<RoleView> {
    const role = await this.roles.findById(id);
    if (!role) throw new RoleNotFoundError();

    // AU-024, shape three. Deactivating a role stops it granting ANYTHING from
    // the next request — `role-permission.registry.ts` excludes inactive roles
    // in the query — so deactivating the last one that administers users is
    // the same catastrophe as deleting it, arrived at more quietly.
    if (command.active === false) {
      await this.assertNotTheLastAdministrator(
        id,
        'deactivated',
        requester.userId,
      );
    }

    const updated = await this.roles.update(id, {
      name: command.name,
      description: command.description,
      active: command.active,
    });
    if (!updated) throw new RoleNotFoundError();

    this.cache.invalidate();
    await this.trail.record('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * AU-031, AU-024.
   *
   * Two refusals, both offering deactivation, and the SERVICE checks them
   * before the database does. The base has the final word — the trigger and
   * the RESTRICT foreign key are what make the guarantee real against a script
   * — but an answer that depends on a PostgreSQL message is an answer whose
   * wording changes with a minor version.
   */
  async delete(id: string, requester: Requester): Promise<void> {
    const role = await this.roles.findById(id);
    if (!role) throw new RoleNotFoundError();
    if (role.isSystem) throw new SystemRoleProtectedError();

    await this.assertNotTheLastAdministrator(id, 'deleted', requester.userId);

    const deleted = await this.roles.delete(id);
    if (!deleted) throw new RoleNotFoundError();

    this.cache.invalidate();
    await this.trail.record('UPDATE', id, requester);
  }

  /** AU-033. */
  async listPermissions(roleId: string): Promise<readonly string[]> {
    const role = await this.roles.findById(roleId);
    if (!role) throw new RoleNotFoundError();

    return this.roles.listPermissions(roleId);
  }

  /**
   * AU-033, AU-034, AU-024, AU-012.
   *
   * THE WARNINGS DO NOT BLOCK. AU-034 is explicit about it, and the reason is
   * that refusing outright pushes a small clinic — where the owner is also the
   * doctor — to share one account, which is strictly worse for the trail. The
   * warning travels in the response so the screen can show it, and the change
   * is already saved when it does.
   */
  async replacePermissions(
    roleId: string,
    codes: readonly string[],
    requester: Requester,
  ): Promise<{ permissions: readonly string[]; warnings: readonly string[] }> {
    const role = await this.roles.findById(roleId);
    if (!role) throw new RoleNotFoundError();

    // AU-033. Unknown codes are refused BEFORE anything is written: a role
    // half-updated because the fourth code was a typo is worse than a refusal.
    const unknown = [...new Set(codes)].filter(
      (code) => !KNOWN_PERMISSIONS.has(code),
    );
    if (unknown.length > 0) throw new UnknownPermissionError(unknown);

    const desired = [...new Set(codes)];

    // AU-024, shapes two and three at once: taking `user:manage` off a role
    // may leave nobody administering the system, and it may leave the CALLER
    // unable to put it back — which is the same disaster reached by a
    // different door.
    if (!desired.includes(ADMINISTERS_USERS)) {
      await this.assertAdministrationSurvivesWithout(roleId, requester.userId);
    }

    const permissions = await this.roles.replacePermissions(
      roleId,
      desired,
      requester.userId,
    );

    // AU-012, AU-032: permissions are resolved per request with a short cache,
    // so this is what makes the change take effect NOW instead of within the
    // TTL — and «within the TTL» is long enough for whoever changed it to
    // conclude it did not work and change it again.
    this.cache.invalidate();

    await this.trail.record('UPDATE', roleId, requester);

    // AU-034: computed on what was actually saved, not on what was asked for.
    return { permissions, warnings: warningsFor(permissions) };
  }

  /**
   * AU-024. Refuses when losing this role would leave the installation with
   * no administration that anybody actually holds.
   *
   * COUNTING ROLES IS NOT ENOUGH, and the first version of this counted them.
   * A role that nobody holds administers nothing, so three ordinary screen
   * actions bricked the installation: create `SUPERVISOR`, give it
   * `user:manage` — allowed, it grants nothing to nobody — and now the count
   * is two, so deactivating the real administrator role passes silently.
   * `role-permission.registry.ts` drops inactive roles in the query, so the
   * caller loses every permission on their very next request and nobody holds
   * `SUPERVISOR`. Unrecoverable without `psql`.
   *
   * The database does not catch it either: `trg_role_permission_keep_admin`
   * fires on `role_permission`, and deactivating a `role` row never reaches
   * it. So the check has to be right here.
   *
   * The standard is the one its sibling below already applies: what survives
   * has to be ACTIVE, HELD by somebody, and held by the CALLER — otherwise an
   * administrator locks themselves out while the installation technically
   * survives.
   */
  private async assertNotTheLastAdministrator(
    roleId: string,
    verb: string,
    callerId: string,
  ): Promise<void> {
    const administering = await this.roles.rolesGranting(ADMINISTERS_USERS);
    if (!administering.some((role) => role.id === roleId)) return;

    // `liveGrants` is what turns «a role exists» into «somebody administers».
    const remaining = administering.filter((role) => role.id !== roleId);
    if (remaining.length === 0) {
      throw new CannotDemoteSelfError(
        `The last active role granting ${ADMINISTERS_USERS} cannot be ${verb}`,
      );
    }

    const held = new Set(await this.roles.liveRoleIdsOf(callerId));
    if (remaining.some((role) => held.has(role.id))) return;
    // The caller does not hold this one either, so nothing of theirs changes.
    if (!held.has(roleId)) return;

    throw new CannotDemoteSelfError(
      `An administrator cannot leave themselves without administration by having it ${verb}`,
    );
  }

  /**
   * AU-024. Refuses when removing `user:manage` from this role would leave
   * either the installation or the CALLER without administration.
   *
   * The two are checked together because they fail together in practice: the
   * administrator editing the role they themselves hold is the ordinary way
   * this happens, not an exotic one.
   */
  private async assertAdministrationSurvivesWithout(
    roleId: string,
    callerId: string,
  ): Promise<void> {
    const administering = await this.roles.rolesGranting(ADMINISTERS_USERS);
    const remaining = administering.filter((role) => role.id !== roleId);

    if (remaining.length === 0) {
      throw new CannotDemoteSelfError(
        `The last active role granting ${ADMINISTERS_USERS} cannot lose it`,
      );
    }

    const held = new Set(await this.roles.liveRoleIdsOf(callerId));
    if (remaining.some((role) => held.has(role.id))) return;
    // The caller does not hold this role either, so nothing of theirs changes.
    if (!held.has(roleId)) return;

    throw new CannotDemoteSelfError(
      'An administrator cannot remove their own user administration',
    );
  }
}
