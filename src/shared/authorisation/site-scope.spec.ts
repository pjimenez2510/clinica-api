import { describe, expect, it } from 'vitest';

import type { Permission } from './permission.catalogue';

import { Principal, type ResolvedGrant } from './principal';
import {
  assertClinicWideScope,
  assertScopesInScope,
  assertSiteInScope,
  assertSitesInScope,
  siteScope,
  SiteScopeDeniedError,
} from './site-scope';

const NORTE = 'site-norte';
const SUR = 'site-sur';

const grant = (
  siteId: string | null,
  permissions: Permission[],
): ResolvedGrant => ({ roleCode: 'RECEPCION', siteId, permissions });

describe('siteScope', () => {
  it('applies no filter for a global grant', () => {
    const director = new Principal('u1', [grant(null, ['agenda:read'])]);
    expect(siteScope(director, 'agenda:read')).toEqual({});
  });

  it('AU-011 confines the query to the sites actually held', () => {
    const receptionist = new Principal('u1', [grant(NORTE, ['agenda:read'])]);
    expect(siteScope(receptionist, 'agenda:read')).toEqual({
      siteId: { in: [NORTE] },
    });
  });

  it('AU-011 THROWS when the permission is held nowhere', () => {
    /**
     * The mistake this function exists to make unspellable.
     *
     * `sitesFor` returns an empty array when the caller holds the permission
     * at no site, and the tempting reading is "no filter to apply" — which
     * turns a denial into a query that returns every site's data. It has to be
     * an error, not an empty object.
     */
    const outsider = new Principal('u1', [grant(NORTE, ['patient:read'])]);

    /**
     * ⚠️ SE CAPTURA LO QUE DEVUELVE Y LO QUE LANZA, POR SEPARADO.
     *
     * La segunda aserción era `expect(() => siteScope(...)).not.toEqual({})`,
     * que compara una FUNCIÓN con un objeto: una función nunca es igual a
     * `{}`, así que la línea pasaba con cualquier implementación — incluida la
     * que devuelve el filtro vacío y enseña las fichas de todas las sedes, que
     * es exactamente lo que decía estar comprobando.
     */
    let filter: unknown;
    let refusal: unknown;
    try {
      filter = siteScope(outsider, 'agenda:read');
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(SiteScopeDeniedError);
    expect((refusal as SiteScopeDeniedError).code).toBe('SITE_SCOPE_DENIED');
    // Y no devolvió NADA: en particular, no `{}` — el filtro vacío que en una
    // consulta significa «todas las sedes».
    expect(filter).toBeUndefined();
  });

  it('merges several sites into one filter', () => {
    const nurse = new Principal('u1', [
      grant(NORTE, ['vitals:write']),
      grant(SUR, ['vitals:write']),
    ]);
    expect(siteScope(nurse, 'vitals:write')).toEqual({
      siteId: { in: [NORTE, SUR] },
    });
  });
});

describe('assertSiteInScope', () => {
  it('allows a write at a site the caller holds', () => {
    const receptionist = new Principal('u1', [grant(NORTE, ['agenda:write'])]);
    expect(() =>
      assertSiteInScope(receptionist, 'agenda:write', NORTE),
    ).not.toThrow();
  });

  it('AU-011 REFUSES a write at another site', () => {
    // A receptionist hired at Norte booking into Sur's agenda. Holding the
    // permission is not holding it here.
    const receptionist = new Principal('u1', [grant(NORTE, ['agenda:write'])]);
    expect(() => assertSiteInScope(receptionist, 'agenda:write', SUR)).toThrow(
      SiteScopeDeniedError,
    );
  });

  it('allows a global grant at any site', () => {
    const director = new Principal('u1', [grant(null, ['agenda:write'])]);
    expect(() =>
      assertSiteInScope(director, 'agenda:write', 'any-site'),
    ).not.toThrow();
  });
});

describe('assertSitesInScope', () => {
  it('ST-047 REFUSES a set that contains one site outside the scope', () => {
    // The whole set is refused, and before anything is written: the caller
    // holds Norte and named Sur alongside it.
    const admin = new Principal('u1', [grant(NORTE, ['staff:manage'])]);

    expect(() =>
      assertSitesInScope(admin, 'staff:manage', [NORTE, SUR]),
    ).toThrow(SiteScopeDeniedError);
  });

  it('ST-047 allows a set entirely inside the scope', () => {
    const admin = new Principal('u1', [
      grant(NORTE, ['staff:manage']),
      grant(SUR, ['staff:manage']),
    ]);

    expect(() =>
      assertSitesInScope(admin, 'staff:manage', [NORTE, SUR]),
    ).not.toThrow();
  });

  it('ST-047 lets a global grant name any site: the director is not blocked', () => {
    const director = new Principal('u1', [grant(null, ['staff:manage'])]);

    expect(() =>
      assertSitesInScope(director, 'staff:manage', [NORTE, SUR, 'site-otra']),
    ).not.toThrow();
  });

  it('ST-047 an empty set is nothing to refuse', () => {
    // Unlinking a practitioner from every site of an empty set touches no
    // site at all; what the caller may drop is judged against the CURRENT
    // rows, which the service adds to this call.
    const admin = new Principal('u1', [grant(NORTE, ['staff:manage'])]);

    expect(() => assertSitesInScope(admin, 'staff:manage', [])).not.toThrow();
  });
});

describe('assertClinicWideScope', () => {
  it('CF-067 REFUSES a caller who holds the permission at one site only', () => {
    // The whole point of D-023's holiday half: a national holiday shuts every
    // site's agenda, so declaring one is not something a site administrator
    // does. Holding `settings:manage` at Norte — even at Norte AND Sur — is
    // not holding it clinic-wide, because the clinic can open a third site
    // tomorrow and the holiday would apply there too.
    const norte = new Principal('u1', [grant(NORTE, ['settings:manage'])]);
    const both = new Principal('u2', [
      grant(NORTE, ['settings:manage']),
      grant(SUR, ['settings:manage']),
    ]);

    expect(() => assertClinicWideScope(norte, 'settings:manage')).toThrow(
      SiteScopeDeniedError,
    );
    expect(() => assertClinicWideScope(both, 'settings:manage')).toThrow(
      SiteScopeDeniedError,
    );
  });

  it('CF-067 allows the clinic-wide grant: that is the whole point of it', () => {
    const director = new Principal('u1', [grant(null, ['settings:manage'])]);

    expect(() =>
      assertClinicWideScope(director, 'settings:manage'),
    ).not.toThrow();
  });

  it('AU-038 REFUSES a caller who does not hold the permission at all', () => {
    const nobody = new Principal('u1', [grant(null, ['agenda:read'])]);

    expect(() => assertClinicWideScope(nobody, 'user:manage')).toThrow(
      SiteScopeDeniedError,
    );
  });
});

describe('assertScopesInScope', () => {
  it('AU-038 REFUSES the null scope from a caller confined to one site', () => {
    /**
     * The privilege escalation of D-023. `siteId: null` in a grant means EVERY
     * site, present and future — so handing one out is handing out the
     * authority the site scope exists to limit. A site administrator naming it
     * is refused, and the refusal is the same one a foreign site gets: the
     * answer never says which of the two it was.
     */
    const norte = new Principal('u1', [grant(NORTE, ['user:manage'])]);

    expect(() => assertScopesInScope(norte, 'user:manage', [null])).toThrow(
      SiteScopeDeniedError,
    );
  });

  it('AU-038 REFUSES a set where one scope is another site', () => {
    const norte = new Principal('u1', [grant(NORTE, ['user:manage'])]);

    expect(() =>
      assertScopesInScope(norte, 'user:manage', [NORTE, SUR]),
    ).toThrow(SiteScopeDeniedError);
  });

  it('AU-038 allows a set entirely inside the scope', () => {
    const norte = new Principal('u1', [grant(NORTE, ['user:manage'])]);

    expect(() =>
      assertScopesInScope(norte, 'user:manage', [NORTE, NORTE]),
    ).not.toThrow();
  });

  it('AU-038 lets a clinic-wide grant name any scope, null included', () => {
    // The director is not blocked by any of this: `siteId: null` on the GRANT
    // is what makes every scope reachable, which is what makes the check a
    // limit on delegation rather than a wall.
    const director = new Principal('u1', [grant(null, ['user:manage'])]);

    expect(() =>
      assertScopesInScope(director, 'user:manage', [NORTE, SUR, null]),
    ).not.toThrow();
  });

  it('CF-067 an empty set is nothing to refuse', () => {
    const norte = new Principal('u1', [grant(NORTE, ['settings:manage'])]);

    expect(() =>
      assertScopesInScope(norte, 'settings:manage', []),
    ).not.toThrow();
  });
});
