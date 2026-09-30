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
  MfaResetAuthor,
} from '../application/admin-ports';
// The discriminator, not a second literal: one query has to answer «quién
// cambió quién puede hacer qué», and two writers spelling it differently is
// the drift `AuthAdminAuditTrail` warns about.
import { AUTH_AUDIT_RESOURCE } from '../application/auth-admin-audit.trail';
import { UNUSABLE_PASSWORD_HASH } from '../domain/password-hashing';

import { duplicateErrorFrom, isRecordNotFound } from './auth-database-errors';
import { revokeLiveSessions } from './session-revocation';

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

/**
 * One selection for every read and write, so every path returns the same shape.
 * `passwordHash` is selected only for `credentialPending`.
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

/**
 * The row `ACCOUNT_FIELDS` selects, hash included. It never leaves this file:
 * `toView` reduces the hash to a boolean.
 */
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

/**
 * The only way out of this file for an account row. AU-005: `mfaEnabled`
 * exposes whether the factor is confirmed, never the secret.
 */
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

/** A grant with the role's code and name joined, for `GrantView`. */
const GRANT_SELECT = {
  roleId: true,
  siteId: true,
  role: { select: { code: true, name: true } },
} satisfies Prisma.UserRoleGrantSelect;

/**
 * Prisma adapter for `AccountAdminRepositoryPort`. Unique-index refusals are
 * translated by `duplicateErrorFrom`, never pre-checked.
 */
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

  /** `null` for an unknown id; the service decides the refusal. */
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

  /**
   * AU-035, AU-036. The second factor, its backup codes, the open sessions of
   * the account AND the trail entry, in ONE transaction.
   *
   * WHY A TRANSACTION: the port states the four half-applied states and why
   * each is worse than the failure. The one that matters most is the secret
   * cleared with the codes alive — ten credentials that still open an account
   * whose second factor the screen now shows as removed, printed for a phone
   * that is gone.
   *
   * ⚠️ WHY THE TRAIL ENTRY IS WRITTEN HERE AND NOT THROUGH
   * `AccessAuditRecorder`. That adapter swallows its failures on purpose, and
   * for a read of a chart that is the right trade. Its own comment names the
   * exception — «those must fail closed when they cannot be recorded … they
   * must not reuse this path» — and AU-035 is exactly it: the entry is the
   * requirement, because this is the permission that lets somebody take over
   * another person's account. A reset that cannot be attributed must not
   * happen. `access_audit` refuses UPDATE and DELETE but takes INSERTs, and a
   * ROLLBACK is not a deletion, so nothing about the table's append-only
   * guarantee is weakened by enrolling it here.
   *
   * WHY THE CODES ARE DELETED AND NOT MARKED SPENT, unlike a grant, which is
   * revoked and never deleted: a backup code is a CREDENTIAL, not evidence.
   * `access_audit` is what answers who reset what and when (AU-035); keeping
   * the Argon2 hash of a withdrawn code adds nothing to that and leaves a
   * credential in the table it was withdrawn from. It is the same treatment
   * `confirmMfaWithBackupCodes` already gives the previous batch.
   *
   * THE PASSWORD IS NOT IN `data`, and that absence is the requirement: the
   * person still needs their own to sign in.
   *
   * `update` refuses a missing row with P2025, which aborts the whole
   * transaction — so a caller can never see the codes deleted for an account
   * that turned out not to exist.
   */
  async resetMfa(
    userId: string,
    revocationReason: string,
    author: MfaResetAuthor,
  ): Promise<AccountView | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.user.update({
          where: { id: userId },
          data: {
            mfaSecretEncrypted: null,
            // AU-037. A change left in progress goes too. Leaving it behind
            // would let a confirmation that predates the reset install a
            // second factor on an account somebody has just been given back.
            mfaPendingSecretEncrypted: null,
            mfaEnabledAt: null,
            // The consumed step goes too. Left behind, the next enrolment
            // would have to wait for the clock to pass it before its first
            // code was accepted, and the person would read that as the reset
            // not having worked.
            mfaLastStep: null,
          },
          select: ACCOUNT_FIELDS,
        });

        await tx.backupCode.deleteMany({ where: { userId } });

        // AU-036. Same shape as `rotateCredentials`: the sessions that exist
        // because the old factor was satisfied do not outlive it.
        await revokeLiveSessions(tx, { userId }, revocationReason);

        // AU-035. The entry is part of the act, not a note about it. Only who,
        // over whom and from where: there is no field here that could carry a
        // secret, a hash or a backup code, which is AU-025 made structural.
        await tx.accessAudit.create({
          data: {
            userId: author.userId,
            resourceType: AUTH_AUDIT_RESOURCE,
            resourceId: userId,
            // A verb of its own and not `UPDATE`: recorded generically, «¿a
            // quién le han reiniciado el segundo factor, y quién?» would be
            // indistinguishable from renaming the same account.
            action: 'MFA_RESET',
            ip: author.ip,
            userAgent: author.userAgent,
          },
        });

        return toView(row);
      });
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
