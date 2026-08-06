import { describe, expect, it } from 'vitest';

import { Principal, type ResolvedGrant } from './principal';
import {
  assertSiteInScope,
  siteScope,
  SiteScopeDeniedError,
} from './site-scope';

const NORTE = 'site-norte';
const SUR = 'site-sur';

const grant = (
  siteId: string | null,
  permissions: string[],
): ResolvedGrant => ({ roleCode: 'RECEPCION', siteId, permissions });

describe('siteScope', () => {
  it('applies no filter for a global grant', () => {
    const director = new Principal('u1', [grant(null, ['agenda:read'])]);
    expect(siteScope(director, 'agenda:read')).toEqual({});
  });

  it('confines the query to the sites actually held', () => {
    const receptionist = new Principal('u1', [grant(NORTE, ['agenda:read'])]);
    expect(siteScope(receptionist, 'agenda:read')).toEqual({
      siteId: { in: [NORTE] },
    });
  });

  it('THROWS when the permission is held nowhere', () => {
    /**
     * The mistake this function exists to make unspellable.
     *
     * `sitesFor` returns an empty array when the caller holds the permission
     * at no site, and the tempting reading is "no filter to apply" — which
     * turns a denial into a query that returns every site's data. It has to be
     * an error, not an empty object.
     */
    const outsider = new Principal('u1', [grant(NORTE, ['patient:read'])]);

    expect(() => siteScope(outsider, 'agenda:read')).toThrow(
      SiteScopeDeniedError,
    );
    // And specifically NOT the shape that means "everything".
    expect(() => siteScope(outsider, 'agenda:read')).not.toEqual({});
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

  it('REFUSES a write at another site', () => {
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
