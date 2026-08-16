import { describe, expect, it } from 'vitest';

import {
  EXPLICIT_GRANT_ONLY_PERMISSIONS,
  type Permission,
  PERMISSION_CATALOGUE,
  PERMISSIONS,
  SEEDABLE_PERMISSIONS,
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
    //
    // THE ACTION MAY BE HYPHENATED, and that was widened on 13-08-2026 for
    // `user:reset-mfa` (AU-035). The alternative was `user:resetmfa`, and the
    // convention is not worth a code nobody can read: what the shape actually
    // buys is one colon, one resource in front of it, lowercase throughout and
    // no spaces — all of which still hold. The requirement names this code
    // literally, and an identifier in a SPEC.md is quoted, never adapted.
    // AND THE ACTION MAY BE QUALIFIED, widened on 14-08-2026 for
    // `agenda:overbook:self` (AG-103, D-005). It is not a third level of
    // resource: it is the same action over a narrower subject — authorising
    // one's OWN overbooking — and calling it `agenda:overbook-self` would hide
    // that it is the exception to `agenda:overbook` rather than a different
    // power. The requirement quotes this code literally, and an identifier in
    // a SPEC.md is quoted, never adapted.
    for (const code of PERMISSIONS) {
      expect(code, `${code} is not resource:action`).toMatch(
        /^[a-z]+:[a-z]+(-[a-z]+)*(:[a-z]+(-[a-z]+)*)?$/,
      );
    }
  });

  it('groups every permission under a screen of the administration UI', () => {
    // The resource is the SCREEN the permission belongs to, not the prefix of
    // its code — `vitals:write` and `prescription:write` are configured from
    // the clinical record screen, and `user:manage` from the admin one. An
    // exception list keyed on the prefix would have grown with every addition;
    // asserting the closed set of screens is the invariant that actually
    // matters.
    // `staff` joined on 13-08-2026 with the module that owns `Practitioner`
    // (ADR-011): the professional file is its own screen, not a corner of the
    // clinical parametrisation, because who may read a colleague's cedula and
    // ACESS is a different question from who may rename a specialty.
    // `settings` joined on 13-08-2026 with `configuration` (C3, ADR-011):
    // holidays and the four numbers of D-001 are their own screen, separate
    // from `config` — which is specialties, attention types and durations.
    // The split is the one ADR-011 drew: a parameter changes behaviour and no
    // row references it; a specialty is master data the record, the invoice
    // and the report to the State all cite.
    const SCREENS = ['patient', 'agenda', 'record', 'billing', 'catalog', 'config', 'settings', 'staff', 'admin']; // prettier-ignore

    for (const definition of PERMISSION_CATALOGUE) {
      expect(SCREENS, definition.code).toContain(definition.resource);
    }
  });

  it('AU-035 keeps the permissions a person must grant on purpose out of what a seed may hand out', () => {
    // Las dos listas se derivan de la misma marca, así que esto afirma la
    // partición: nada se pierde y nada aparece en las dos. Sin ella, una
    // semilla que pida «todos los permisos» reparte también los de riesgo, que
    // es exactamente cómo `user:reset-mfa` acabó en el rol de desarrollo.
    expect(EXPLICIT_GRANT_ONLY_PERMISSIONS.length).toBeGreaterThan(0);
    expect([...SEEDABLE_PERMISSIONS, ...EXPLICIT_GRANT_ONLY_PERMISSIONS].sort()).toEqual([...PERMISSIONS].sort()); // prettier-ignore

    for (const risky of EXPLICIT_GRANT_ONLY_PERMISSIONS) {
      expect(SEEDABLE_PERMISSIONS, risky).not.toContain(risky);
    }
  });

  it('AU-035 marks `user:reset-mfa` as one of them', () => {
    // El requisito lo nombra literalmente: el permiso NO DEBERÁ venir
    // concedido a ningún rol de fábrica. La marca es lo que lo hace cumplible
    // por código en lugar de por memoria.
    expect(EXPLICIT_GRANT_ONLY_PERMISSIONS).toContain('user:reset-mfa');
  });

  it('AG-103 marks `agenda:overbook:self` as one of them', () => {
    // D-005: la separación entre quien reserva y quien autoriza ES el control
    // del sobrecupo, y este permiso es lo único que la levanta. Si una semilla
    // lo repartiera —como repartió `user:reset-mfa` el día que se declaró—,
    // cualquier recepcionista del rol sembrado podría autorizarse sus propias
    // excepciones y el campo de autorización dejaría de significar nada.
    expect(EXPLICIT_GRANT_ONLY_PERMISSIONS).toContain('agenda:overbook:self');
    expect(SEEDABLE_PERMISSIONS).not.toContain('agenda:overbook:self');
    // Y el otro SÍ se siembra: es el que MEDICO y ADMIN traen de fábrica.
    expect(SEEDABLE_PERMISSIONS).toContain('agenda:overbook');
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

  it('AU-011 confines a site-scoped grant to that site', () => {
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

  it('AU-011 does not let one role widen the scope of another', () => {
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
