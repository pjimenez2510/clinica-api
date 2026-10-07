import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';

import type { AccountView, GrantView, RoleView } from './admin-ports';

/** Who is asking, so the trail can say so (AU-025). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * The `resource_type` every entry about an account, a role or a grant carries.
 *
 * EXPORTED because AU-035's entry is NOT written through this collaborator: it
 * rides inside the reset's own transaction, in
 * `PrismaAccountAdminRepository.resetMfa`, and a second literal `'auth'` there
 * is exactly the drift this class's own comment warns about — one query has to
 * answer «quién cambió quién puede hacer qué», and it cannot if two writers
 * spell the discriminator differently.
 */
export const AUTH_AUDIT_RESOURCE = 'auth';

/**
 * AU-052. What an edit of an account replaced and what it left: the fields an
 * administrator edits, picked one by one.
 *
 * PICKED, NOT SPREAD, AND THAT IS THE GUARANTEE. The account row carries the
 * password hash and the second factor's secret, and this table is append-only
 * and never purged: a `...row` that one day received the ORM row instead of
 * the view would write them into it for good. Naming each field means a new
 * column reaches the trail only when somebody adds it here on purpose.
 */
export interface AccountSnapshot {
  firstName: string;
  lastName: string;
  cedula: string | null;
  email: string;
  active: boolean;
}

export function accountSnapshot(view: AccountView): AccountSnapshot {
  return {
    firstName: view.firstName,
    lastName: view.lastName,
    cedula: view.cedula,
    email: view.email,
    active: view.active,
  };
}

/** AU-052. A role's editable fields; `isSystem` and the grant count are not. */
export interface RoleSnapshot {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
}

export function roleSnapshot(view: RoleView): RoleSnapshot {
  return {
    code: view.code,
    name: view.name,
    description: view.description,
    active: view.active,
  };
}

/**
 * AU-052. An account's grants as the set they are: role and site, with the
 * role's code so the trail reads without a join to a role that may since have
 * been renamed or deleted.
 */
export function grantsSnapshot(grants: readonly GrantView[]): {
  grants: { roleId: string; roleCode: string; siteId: string | null }[];
} {
  return {
    grants: grants.map((grant) => ({
      roleId: grant.roleId,
      roleCode: grant.roleCode,
      siteId: grant.siteId,
    })),
  };
}

/** AU-052. A role's permission codes, before or after a replacement. */
export function permissionsSnapshot(codes: readonly string[]): {
  permissions: string[];
} {
  return { permissions: [...codes] };
}

/**
 * AU-052. Only the snapshot shapes above fit, so a caller cannot hand over a
 * row with a hash in it by accident: TypeScript refuses anything else.
 */
type AuthSnapshot =
  | AccountSnapshot
  | RoleSnapshot
  | ReturnType<typeof grantsSnapshot>
  | ReturnType<typeof permissionsSnapshot>;

export interface AuthChange {
  before?: AuthSnapshot;
  after?: AuthSnapshot;
}

/**
 * Every mutation of an account, a role or a grant in the trail (AU-025).
 *
 * A collaborator and not a private method copied into two services: AU-025 is
 * one promise about accounts, roles and grants alike, and the value of the
 * trail is that a single query answers «quién cambió quién puede hacer qué, y
 * cuándo» — which is the first question an SPDP audit asks. Two private copies
 * is two chances for one of them to write a different discriminator, and
 * nothing would fail until somebody audited.
 *
 * WHAT NEVER REACHES IT: the password, the hash, the TOTP secret and the
 * backup codes. AU-025 says so explicitly, and the shape of this method is
 * what makes it true: `change` only accepts the snapshot shapes above, none
 * of which has anywhere to put them (AU-052).
 */
@Injectable()
export class AuthAdminAuditTrail {
  constructor(
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  async record(
    action: AuditAction,
    resourceId: string,
    requester: Requester,
    change: AuthChange = {},
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: AUTH_AUDIT_RESOURCE,
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
      /**
       * AU-052. Copied, so what reaches the column is a plain JSON object.
       * `'auth'` carries a payload since `admin_edit_in_place` (D-150).
       */
      before: change.before && { ...change.before },
      after: change.after && { ...change.after },
    });
  }
}
