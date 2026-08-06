/**
 * What each role may do. See ADR-007.
 *
 * PERMISSIONS LIVE IN CODE, ROLES LIVE IN THE DATABASE. A permission only
 * means something if some route checks it, so an editable permission table
 * produces rows that protect nothing and routes guarded by permissions nobody
 * remembers creating. Roles are data — a clinic hires an external auditor
 * without a deploy — but the catalogue below is part of the code's contract.
 *
 * There is no role hierarchy on purpose. With six roles, having MEDICO inherit
 * from STAFF adds an indirection that has to be unwound mentally every time
 * somebody asks "who can see this?". The lists repeat themselves, and that is
 * the cheaper problem.
 */

export const PERMISSIONS = [
  'patient:read',
  'patient:write',
  'agenda:read',
  'agenda:write',
  /** Open a clinical record. The one that matters most under the LOPDP. */
  'record:read',
  'record:write',
  /** Sign a note or a certificate. Requires a valid ACESS registration. */
  'record:sign',
  'vitals:write',
  'prescription:write',
  'billing:read',
  'billing:write',
  'catalog:read',
  'catalog:manage',
  'user:manage',
  'site:manage',
  /** Read the access log. Reading it is itself recorded. */
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type StaffRoleName =
  'ADMIN' | 'MEDICO' | 'ENFERMERIA' | 'RECEPCION' | 'CAJA' | 'AUDITOR';

/**
 * Roles of an Ecuadorian clinic, derived from who signs what.
 *
 * THE SEPARATION THAT MATTERS MOST: `ADMIN` has no `record:*` permission.
 * Administering the system is not treating patients. Whoever holds technical
 * control must not also hold clinical access, and that is the first thing an
 * SPDP audit asks about.
 *
 * `RECEPCION` likewise cannot read a clinical record. Reception needs to know
 * that the patient exists and when they are coming — not what they have.
 */
export const ROLE_PERMISSIONS: Readonly<
  Record<StaffRoleName, readonly Permission[]>
> = {
  ADMIN: [
    'user:manage',
    'site:manage',
    'catalog:manage',
    'catalog:read',
    'audit:read',
  ],
  MEDICO: [
    'patient:read',
    'agenda:read',
    'agenda:write',
    'record:read',
    'record:write',
    'record:sign',
    'vitals:write',
    'prescription:write',
    'catalog:read',
  ],
  // Nursing reads the record because vital signs without context are useless,
  // but it neither diagnoses nor prescribes.
  ENFERMERIA: [
    'patient:read',
    'agenda:read',
    'record:read',
    'vitals:write',
    'catalog:read',
  ],
  RECEPCION: [
    'patient:read',
    'patient:write',
    'agenda:read',
    'agenda:write',
    'catalog:read',
  ],
  CAJA: ['patient:read', 'billing:read', 'billing:write', 'catalog:read'],
  AUDITOR: ['audit:read', 'catalog:read'],
};

/** A role held at one site, or everywhere when `siteId` is null. */
export interface RoleGrant {
  role: StaffRoleName;
  siteId: string | null;
}

/** Every site is in scope, without enumerating them. */
export const ALL_SITES = Symbol('ALL_SITES');

/**
 * The authenticated caller, and what they are allowed to do.
 *
 * `sitesFor` exists because answering "can they?" is not enough in a
 * multi-site clinic: a receptionist hired at one site may list appointments,
 * but only that site's. Query code asks which sites are in scope and filters;
 * without it, every route would reimplement the same filter and one of them
 * would get it wrong.
 */
export class Principal {
  constructor(
    readonly userId: string,
    readonly grants: readonly RoleGrant[],
  ) {}

  can(permission: Permission): boolean {
    return this.grants.some((grant) =>
      ROLE_PERMISSIONS[grant.role]?.includes(permission),
    );
  }

  /**
   * Sites where the caller holds this permission.
   *
   * Returns `ALL_SITES` for a global grant, otherwise the list. An EMPTY list
   * means the permission is not held anywhere — callers must treat that as a
   * denial, never as "no filter".
   */
  sitesFor(permission: Permission): typeof ALL_SITES | string[] {
    const holding = this.grants.filter((grant) =>
      ROLE_PERMISSIONS[grant.role]?.includes(permission),
    );

    if (holding.some((grant) => grant.siteId === null)) return ALL_SITES;
    return [
      ...new Set(
        holding
          .map((grant) => grant.siteId)
          .filter((siteId): siteId is string => siteId !== null),
      ),
    ];
  }

  canAtSite(permission: Permission, siteId: string): boolean {
    const scope = this.sitesFor(permission);
    return scope === ALL_SITES || scope.includes(siteId);
  }
}
