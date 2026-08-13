import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  AccountAdminRepositoryPort,
  AccountListFilter,
  AccountPatch,
  AccountView,
  CreateAccountInput,
  GrantInput,
  GrantView,
} from '../application/admin-ports';
import { UNUSABLE_PASSWORD_HASH } from '../domain/password-hashing';

import { duplicateErrorFrom, isRecordNotFound } from './auth-database-errors';

/**
 * Rows in, domain shapes out, for the ACCOUNT half of administration.
 *
 * THE HASH NEVER LEAVES THIS FILE. It is selected — `credentialPending` of
 * AU-021 cannot be answered without it — and it is turned into a boolean
 * before anything else sees it. `AccountView` has no field that could carry
 * it, which is the point: an administration screen that receives a hash is one
 * `console.log` away from a support ticket with a credential in it.
 *
 * Nothing here checks first: two administrators registering the same new hire
 * in the same millisecond are arbitrated by `app_user_email_key`, not by a
 * read that was stale before it returned (AU-020).
 */

const ACCOUNT_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  cedula: true,
  active: true,
  mfaEnabledAt: true,
  passwordHash: true,
} satisfies Prisma.UserSelect;

interface AccountRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  cedula: string | null;
  active: boolean;
  mfaEnabledAt: Date | null;
  passwordHash: string;
}

function toView(row: AccountRow): AccountView {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    cedula: row.cedula,
    active: row.active,
    mfaEnabled: row.mfaEnabledAt !== null,
    // AU-021: the account exists and cannot sign in. See
    // `UNUSABLE_PASSWORD_HASH` for why this is detectable on purpose.
    credentialPending: row.passwordHash === UNUSABLE_PASSWORD_HASH,
  };
}

const GRANT_SELECT = {
  roleId: true,
  siteId: true,
  role: { select: { code: true, name: true } },
} satisfies Prisma.UserRoleGrantSelect;

@Injectable()
export class PrismaAccountAdminRepository implements AccountAdminRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * AU-020. The search covers name and email and NOT the cedula: a national
   * identifier is how you confirm a person you already found, not how you
   * browse a list, and a substring search over it invites fishing.
   */
  async list(filter: AccountListFilter): Promise<readonly AccountView[]> {
    const search = filter.search?.trim();

    const rows = await this.prisma.user.findMany({
      where: {
        ...(filter.includeInactive ? {} : { active: true }),
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: ACCOUNT_FIELDS,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    return rows.map(toView);
  }

  async findById(id: string): Promise<AccountView | null> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      select: ACCOUNT_FIELDS,
    });
    return row ? toView(row) : null;
  }

  /** AU-020; the duplicate answered by `app_user_email_key`. */
  async create(input: CreateAccountInput): Promise<AccountView> {
    try {
      const row = await this.prisma.user.create({
        data: input,
        select: ACCOUNT_FIELDS,
      });
      return toView(row);
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * The EMAIL is not patchable, and that is the whole reason `AccountPatch`
   * does not carry it: it is the sign-in identifier and it appears in every
   * audit row this person ever produced, so changing it from an administration
   * screen would quietly rewrite who did what. A person whose address really
   * changes gets a new account and the old one deactivated, which is also what
   * keeps the trail honest.
   */
  async update(id: string, patch: AccountPatch): Promise<AccountView | null> {
    try {
      const row = await this.prisma.user.update({
        where: { id },
        data: patch,
        select: ACCOUNT_FIELDS,
      });
      return toView(row);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** AU-022, AU-023. There is no `delete`, deliberately. */
  async setActive(id: string, active: boolean): Promise<AccountView | null> {
    try {
      const row = await this.prisma.user.update({
        where: { id },
        data: {
          active,
          // Reactivating clears the lockout: an account switched back on and
          // still locked out looks to everybody like the reactivation failed.
          ...(active ? { failedAttempts: 0, lockedUntil: null } : {}),
        },
        select: ACCOUNT_FIELDS,
      });
      return toView(row);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  /** AU-032. Revoked grants are excluded by the QUERY, not afterwards. */
  async listGrants(userId: string): Promise<readonly GrantView[]> {
    const rows = await this.prisma.userRoleGrant.findMany({
      where: { userId, revokedAt: null },
      select: GRANT_SELECT,
      orderBy: { grantedAt: 'asc' },
    });

    return rows.map((row) => ({
      roleId: row.roleId,
      roleCode: row.role.code,
      roleName: row.role.name,
      siteId: row.siteId,
    }));
  }

  /**
   * AU-032. One transaction, and REVOCATION rather than deletion.
   *
   * WHY A TRANSACTION: a half-applied change leaves somebody with neither the
   * old role nor the new one, and the person who notices is the receptionist
   * who cannot open the agenda on Monday.
   *
   * WHY REVOKE AND NOT DELETE: who could do what and when is evidence the
   * LOPDP expects (REQ-110), and `user_role_grant_active_unique` — a partial
   * unique index over `WHERE revoked_at IS NULL`, `NULLS NOT DISTINCT` on the
   * site — is what lets a revoked grant coexist with a fresh one for the same
   * role and site.
   *
   * WHAT IS LEFT ALONE: a grant that is already exactly right. Revoking and
   * re-granting it would rewrite `granted_at` and `granted_by`, and the trail
   * would show a change that did not happen.
   */
  async replaceGrants(
    userId: string,
    desired: readonly GrantInput[],
    grantedById: string,
  ): Promise<readonly GrantView[]> {
    const key = (grant: { roleId: string; siteId: string | null }): string =>
      `${grant.roleId}@${grant.siteId ?? 'ALL'}`;
    const wanted = new Map(desired.map((grant) => [key(grant), grant]));

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.userRoleGrant.findMany({
        where: { userId, revokedAt: null },
        select: { id: true, roleId: true, siteId: true },
      });

      const keep = new Set<string>();
      const revoke: string[] = [];
      for (const grant of current) {
        if (wanted.has(key(grant))) keep.add(key(grant));
        else revoke.push(grant.id);
      }

      if (revoke.length > 0) {
        await tx.userRoleGrant.updateMany({
          where: { id: { in: revoke } },
          data: { revokedAt: new Date() },
        });
      }

      const missing = [...wanted.entries()]
        .filter(([identity]) => !keep.has(identity))
        .map(([, grant]) => grant);

      if (missing.length > 0) {
        await tx.userRoleGrant.createMany({
          data: missing.map((grant) => ({
            userId,
            roleId: grant.roleId,
            siteId: grant.siteId,
            grantedById,
          })),
        });
      }
    });

    return this.listGrants(userId);
  }
}
