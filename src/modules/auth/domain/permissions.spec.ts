import { describe, expect, it } from 'vitest';

import {
  ALL_SITES,
  Principal,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type StaffRoleName,
} from './permissions';

const ROLES = Object.keys(ROLE_PERMISSIONS) as StaffRoleName[];

describe('the permission catalogue', () => {
  it('grants no role a permission that does not exist', () => {
    // A typo in a role's list is invisible: it grants nothing and denies
    // nothing, and the route it was meant to open stays shut for no reason
    // anybody can find.
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS, `${role} holds an unknown permission`).toContain(
          permission,
        );
      }
    }
  });

  it('leaves no permission unreachable by every role', () => {
    // The mirror image: a permission no role holds guards a route nobody can
    // ever call.
    const held = new Set(ROLES.flatMap((role) => ROLE_PERMISSIONS[role]));
    expect([...PERMISSIONS].filter((p) => !held.has(p))).toEqual([]);
  });

  it('does NOT let the system administrator into clinical records', () => {
    // The separation an SPDP audit asks about first: whoever holds technical
    // control must not also hold clinical access. If this test ever fails,
    // somebody widened ADMIN "just to debug something".
    const clinical = PERMISSIONS.filter((p) => p.startsWith('record:'));
    for (const permission of clinical) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(permission);
    }
  });

  it('does NOT let reception open a clinical record', () => {
    // Reception needs to know the patient exists and when they are coming.
    // Not what they have.
    expect(ROLE_PERMISSIONS.RECEPCION).not.toContain('record:read');
  });

  it('lets only doctors sign', () => {
    const signers = ROLES.filter((role) =>
      ROLE_PERMISSIONS[role].includes('record:sign'),
    );
    expect(signers).toEqual(['MEDICO']);
  });

  it('does not let nursing diagnose or prescribe', () => {
    expect(ROLE_PERMISSIONS.ENFERMERIA).not.toContain('prescription:write');
    expect(ROLE_PERMISSIONS.ENFERMERIA).not.toContain('record:write');
  });

  it('gives the auditor read access and nothing else', () => {
    const writes = ROLE_PERMISSIONS.AUDITOR.filter(
      (p) =>
        p.endsWith(':write') || p.endsWith(':manage') || p === 'record:sign',
    );
    expect(writes).toEqual([]);
  });
});

describe('Principal', () => {
  const SITE_NORTE = 'site-norte';
  const SITE_SUR = 'site-sur';

  it('denies everything with no grants', () => {
    // Closed by default: an account with no role assigned can do nothing.
    const principal = new Principal('u1', []);

    for (const permission of PERMISSIONS) {
      expect(principal.can(permission)).toBe(false);
    }
    expect(principal.sitesFor('patient:read')).toEqual([]);
  });

  it('grants a permission held through any role', () => {
    const principal = new Principal('u1', [
      { role: 'RECEPCION', siteId: SITE_NORTE },
    ]);

    expect(principal.can('agenda:write')).toBe(true);
    expect(principal.can('record:read')).toBe(false);
  });

  it('confines a site-scoped grant to that site', () => {
    // A receptionist hired at Norte does not work Sur's agenda.
    const principal = new Principal('u1', [
      { role: 'RECEPCION', siteId: SITE_NORTE },
    ]);

    expect(principal.canAtSite('agenda:write', SITE_NORTE)).toBe(true);
    expect(principal.canAtSite('agenda:write', SITE_SUR)).toBe(false);
    expect(principal.sitesFor('agenda:write')).toEqual([SITE_NORTE]);
  });

  it('treats a null site as every site', () => {
    const director = new Principal('u1', [{ role: 'MEDICO', siteId: null }]);

    expect(director.sitesFor('record:read')).toBe(ALL_SITES);
    expect(director.canAtSite('record:read', 'any-site-at-all')).toBe(true);
  });

  it('adds up sites across several grants of the same permission', () => {
    const principal = new Principal('u1', [
      { role: 'ENFERMERIA', siteId: SITE_NORTE },
      { role: 'ENFERMERIA', siteId: SITE_SUR },
    ]);

    expect(principal.sitesFor('vitals:write')).toEqual([SITE_NORTE, SITE_SUR]);
  });

  it('does not let one role widen the scope of another', () => {
    // Being an administrator everywhere must not turn a doctor's single-site
    // clinical access into global clinical access. ADMIN carries no `record:*`
    // permission, so the scope of `record:read` stays the doctor's site.
    const principal = new Principal('u1', [
      { role: 'ADMIN', siteId: null },
      { role: 'MEDICO', siteId: SITE_NORTE },
    ]);

    expect(principal.sitesFor('record:read')).toEqual([SITE_NORTE]);
    expect(principal.canAtSite('record:read', SITE_SUR)).toBe(false);
    // And the global administrative permission is still global.
    expect(principal.sitesFor('user:manage')).toBe(ALL_SITES);
  });

  it('ignores a role it does not recognise', () => {
    // A role removed from the code while a token carrying it is still alive
    // must grant nothing, not crash the request.
    const principal = new Principal('u1', [
      { role: 'ROL_QUE_YA_NO_EXISTE' as StaffRoleName, siteId: null },
    ]);

    expect(principal.can('patient:read')).toBe(false);
    expect(principal.sitesFor('patient:read')).toEqual([]);
  });
});
