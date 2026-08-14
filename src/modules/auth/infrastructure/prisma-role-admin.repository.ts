import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CreateRoleInput,
  RoleAdminRepositoryPort,
  RolePatch,
  RoleView,
} from '../application/admin-ports';
import {
  CannotDemoteSelfError,
  RoleInUseError,
  SystemRoleProtectedError,
} from '../domain/auth.errors';

import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isLastAdministratorProtection,
  isRecordNotFound,
  isSystemRoleProtection,
} from './auth-database-errors';

/**
 * Rows in, domain shapes out, for the ROLE half of administration.
 *
 * Every PostgreSQL refusal that means something to an administrator stops
 * here: the unique code answers `ROLE_CODE_DUPLICATE` (AU-030), the RESTRICT
 * foreign key from `user_role_grant` answers `ROLE_IN_USE` (AU-031), the
 * trigger `trg_role_protect_system` answers `SYSTEM_ROLE_PROTECTED` (AU-031),
 * and the statement-level trigger that keeps one administrator alive answers
 * `CANNOT_DEMOTE_SELF` (AU-024).
 *
 * THE SERVICE REFUSES ALL FOUR EARLIER, and these are not redundant. The
 * service's checks are what produce a stable message and a field error; these
 * are what hold when the write arrives from a script, an import or a
 * concurrent request that read "safe" a millisecond before the other one
 * committed. Only the base can arbitrate the last one.
 */

const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  isSystem: true,
  active: true,
  _count: { select: { grants: { where: { revokedAt: null } } } },
} satisfies Prisma.RoleSelect;

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  active: boolean;
  _count: { grants: number };
}

function toView(row: RoleRow): RoleView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    active: row.active,
    liveGrants: row._count.grants,
  };
}

@Injectable()
export class PrismaRoleAdminRepository implements RoleAdminRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /** AU-031: deactivated roles travel only when explicitly asked for. */
  async list(includeInactive: boolean): Promise<readonly RoleView[]> {
    const rows = await this.prisma.role.findMany({
      where: includeInactive ? {} : { active: true },
      select: ROLE_SELECT,
      orderBy: { code: 'asc' },
    });
    return rows.map(toView);
  }

  async findById(id: string): Promise<RoleView | null> {
    const row = await this.prisma.role.findUnique({
      where: { id },
      select: ROLE_SELECT,
    });
    return row ? toView(row) : null;
  }

  /**
   * AU-030. `isSystem` is NOT settable from here: a role the clinic creates is
   * the clinic's, and letting the application mark one as the code's would
   * make it undeletable by anybody, including whoever created it by mistake.
   */
  async create(input: CreateRoleInput): Promise<RoleView> {
    try {
      const row = await this.prisma.role.create({
        data: { ...input, isSystem: false },
        select: ROLE_SELECT,
      });
      return toView(row);
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** The CODE is not patchable; see the service for why. */
  async update(id: string, patch: RolePatch): Promise<RoleView | null> {
    try {
      const row = await this.prisma.role.update({
        where: { id },
        data: patch,
        select: ROLE_SELECT,
      });
      return toView(row);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      if (isSystemRoleProtection(error)) throw new SystemRoleProtectedError();
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** AU-031: the trigger and the RESTRICT foreign key have the final word. */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.role.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isSystemRoleProtection(error)) throw new SystemRoleProtectedError();
      if (isLastAdministratorProtection(error)) {
        throw new CannotDemoteSelfError(
          'The last active role granting user:manage cannot be deleted',
        );
      }
      if (isForeignKeyRestriction(error)) throw new RoleInUseError();
      throw error;
    }
  }

  async listPermissions(roleId: string): Promise<readonly string[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permissionCode: true },
      orderBy: { permissionCode: 'asc' },
    });
    return rows.map((row) => row.permissionCode);
  }

  /**
   * AU-033. Reads the MIRROR, which is the whole point: the catalogue the
   * screen offers comes from the code, and this answers what the foreign key
   * will actually accept.
   */
  async installedPermissions(
    codes: readonly string[],
  ): Promise<readonly string[]> {
    if (codes.length === 0) return [];

    const rows = await this.prisma.permission.findMany({
      where: { code: { in: [...codes] } },
      select: { code: true },
    });
    return rows.map((row) => row.code);
  }

  /**
   * AU-033. One transaction: a role left half-way through a permission change
   * is a role that grants a set nobody chose.
   *
   * DELETE-THEN-INSERT, and the constraint trigger is what makes it safe.
   * `trg_role_permission_keep_an_administrator` is `DEFERRABLE INITIALLY
   * DEFERRED`, so it runs at COMMIT and not after the DELETE — otherwise
   * re-saving the administrator role with `user:manage` still ticked would
   * fire it in the middle of its own update.
   */
  async replacePermissions(
    roleId: string,
    codes: readonly string[],
    grantedById: string,
  ): Promise<readonly string[]> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        if (codes.length > 0) {
          await tx.rolePermission.createMany({
            data: codes.map((permissionCode) => ({
              roleId,
              permissionCode,
              grantedById,
            })),
          });
        }
      });
    } catch (error) {
      if (isLastAdministratorProtection(error)) {
        throw new CannotDemoteSelfError(
          'At least one active role must keep user:manage',
        );
      }
      throw error;
    }

    return this.listPermissions(roleId);
  }

  /**
   * AU-024. ACTIVE roles only, and the filter is in the QUERY.
   *
   * An inactive role grants nothing — `role-permission.registry.ts` excludes
   * it — so counting one here would let somebody deactivate the real
   * administrator role while a disabled one made the check pass. That is the
   * exact shape of bug this requirement exists to prevent.
   */
  async rolesGranting(permission: string): Promise<readonly RoleView[]> {
    const rows = await this.prisma.role.findMany({
      where: { active: true, permissions: { some: { permissionCode: permission } } }, // prettier-ignore
      select: ROLE_SELECT,
      orderBy: { code: 'asc' },
    });
    return rows.map(toView);
  }

  async liveRoleIdsOf(userId: string): Promise<readonly string[]> {
    const rows = await this.prisma.userRoleGrant.findMany({
      where: { userId, revokedAt: null },
      select: { roleId: true },
    });
    return [...new Set(rows.map((row) => row.roleId))];
  }
}
