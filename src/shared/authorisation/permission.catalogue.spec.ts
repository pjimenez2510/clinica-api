import { describe, expect, it } from 'vitest';

import {
  type Permission,
  PERMISSION_CATALOGUE,
  PERMISSIONS,
} from './permission.catalogue';
import { ALL_SITES, Principal, type ResolvedGrant } from './principal';

describe('the permission catalogue', () => {
  it('declares every code exactly once', () => {
    // A duplicate would silently override the earlier description in the
    // admin screen, and whoever assigns permissions would read the wrong one.
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('names every permission as resource:action', () => {
    // The shape is what lets the admin screen group them, and what keeps the
    // codes greppable when one shows up in a log.
    for (const code of PERMISSIONS) {
      expect(code, `${code} is not resource:action`).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('groups every permission under a screen of the administration UI', () => {
    // The resource is the SCREEN the permission belongs to, not the prefix of
    // its code — `vitals:write` and `prescription:write` are configured from
    // the clinical record screen, and `user:manage` from the admin one. An
    // exception list keyed on the prefix would have grown with every addition;
    // asserting the closed set of screens is the invariant that actually
    // matters.
    const SCREENS = ['patient', 'agenda', 'record', 'billing', 'catalog', 'admin']; // prettier-ignore

    for (const definition of PERMISSION_CATALOGUE) {
      expect(SCREENS, definition.code).toContain(definition.resource);
    }
  });

  it('describes every permission the way the user reads it', () => {
    // A clinic administrator builds a role from these strings. They follow the
    // same convention as any other user-facing text (ADR-005): a complete
    // sentence, capitalised, in Spanish.
    for (const definition of PERMISSION_CATALOGUE) {
      expect(definition.description, definition.code).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
      expect(
        definition.description.split(' ').length,
        `${definition.code} is not a sentence`,
      ).toBeGreaterThan(1);
    }
  });
});

describe('Principal', () => {
  const SITE_NORTE = 'site-norte';
  const SITE_SUR = 'site-sur';

  const grant = (
    roleCode: string,
    siteId: string | null,
    permissions: Permission[],
  ): ResolvedGrant => ({ roleCode, siteId, permissions });

  it('denies everything with no grants', () => {
    // Closed by default: an account with no role can do nothing at all.
    const principal = new Principal('u1', []);

    for (const permission of PERMISSIONS) {
      expect(principal.can(permission)).toBe(false);
    }
    expect(principal.sitesFor('patient:read')).toEqual([]);
  });

  it('grants a permission held through any role', () => {
    const principal = new Principal('u1', [
      grant('RECEPCION', SITE_NORTE, ['agenda:write', 'patient:read']),
    ]);

    expect(principal.can('agenda:write')).toBe(true);
    expect(principal.can('record:read')).toBe(false);
  });

  it('confines a site-scoped grant to that site', () => {
    // A receptionist hired at Norte does not work Sur's agenda.
    const principal = new Principal('u1', [
      grant('RECEPCION', SITE_NORTE, ['agenda:write']),
    ]);

    expect(principal.canAtSite('agenda:write', SITE_NORTE)).toBe(true);
    expect(principal.canAtSite('agenda:write', SITE_SUR)).toBe(false);
    expect(principal.sitesFor('agenda:write')).toEqual([SITE_NORTE]);
  });

  it('treats a null site as every site', () => {
    const director = new Principal('u1', [
      grant('DIRECTOR', null, ['record:read']),
    ]);

    expect(director.sitesFor('record:read')).toBe(ALL_SITES);
    expect(director.canAtSite('record:read', 'any-site-at-all')).toBe(true);
  });

  it('adds up sites across several grants of the same permission', () => {
    const principal = new Principal('u1', [
      grant('ENFERMERIA', SITE_NORTE, ['vitals:write']),
      grant('ENFERMERIA', SITE_SUR, ['vitals:write']),
    ]);

    expect(principal.sitesFor('vitals:write')).toEqual([SITE_NORTE, SITE_SUR]);
  });

  it('does not let one role widen the scope of another', () => {
    // Being an administrator everywhere must not turn a doctor's single-site
    // clinical access into global clinical access.
    const principal = new Principal('u1', [
      grant('ADMIN', null, ['user:manage']),
      grant('MEDICO', SITE_NORTE, ['record:read']),
    ]);

    expect(principal.sitesFor('record:read')).toEqual([SITE_NORTE]);
    expect(principal.canAtSite('record:read', SITE_SUR)).toBe(false);
    expect(principal.sitesFor('user:manage')).toBe(ALL_SITES);
  });

  it('grants nothing through a role that resolved to no permissions', () => {
    // What a deactivated or emptied role looks like by the time it gets here.
    const principal = new Principal('u1', [grant('ROL_VACIO', null, [])]);

    expect(principal.can('patient:read')).toBe(false);
    expect(principal.sitesFor('patient:read')).toEqual([]);
  });
});
