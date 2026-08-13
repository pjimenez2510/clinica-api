import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import {
  IS_PUBLIC_KEY,
  MFA_FLOW_ONLY_KEY,
  OWN_ACCOUNT_KEY,
  REQUIRED_PERMISSION_KEY,
  SITE_SCOPE_KEY,
} from '../../src/shared/http/auth.decorators';
import { PERMISSIONS } from '../../src/shared/authorisation/permission.catalogue';
import { closeApp } from './setup/http-server';

/** `'agenda/sites/:siteId'` + `'availability'` → `/agenda/sites/:siteId/availability`. */
function joinPath(controller: unknown, handler: unknown): string {
  const segments = [controller, handler]
    .map((part) => (typeof part === 'string' ? part : ''))
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '' && segment !== '/');

  return `/${segments.join('/')}`;
}

/**
 * The name of the path parameter that carries a site, or `undefined`.
 *
 * TWO SHAPES, because both are in use and both are right: `:siteId` names
 * itself, and `sites/:id` names the site through the segment before it — that
 * is what `organization` does for a resource whose whole identity IS the site.
 * Matching only the first would leave the second dimension of authorisation
 * unchecked on exactly the routes that manage sites.
 */
function siteParamOf(path: string): string | undefined {
  const segments = path.split('/');

  for (const [index, segment] of segments.entries()) {
    if (!segment.startsWith(':')) continue;

    const name = segment.slice(1);
    if (/^site(_?id)?$/i.test(name)) return name;
    if (segments[index - 1] === 'sites') return name;
  }

  return undefined;
}

/**
 * Every route declares how it is protected. No exceptions, and no defaults.
 *
 * This is the compensation for enforcing authorisation in the application
 * rather than in PostgreSQL (ADR-007 §3). The known weakness of a guard is
 * that a route forgets to ask for one; the guard already refuses an
 * unannotated route at runtime, and this makes the same mistake fail in CI
 * instead of in production.
 *
 * It walks the routes NestJS actually registered, not a list somebody
 * maintains: a list would drift the first time it was not updated.
 */
describe('every route declares its protection', () => {
  interface RouteInfo {
    route: string;
    /** Controller path joined to handler path, as NestJS registered it. */
    path: string;
    marker: string;
    permission?: unknown;
    siteScope?: unknown;
  }

  let routes: RouteInfo[];
  // Held outside the hook so a throw during the walk still releases it. An
  // application that outlives its suite keeps a Prisma pool open for the rest
  // of the run, and the next suite pays for it in connections.
  let app: INestApplication | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Every controller handler, read off the metadata the decorators set.
    // The container is the only source that cannot drift from reality.
    const controllers = moduleRef.get(ModulesContainer, { strict: false });

    routes = [];
    for (const module of controllers.values()) {
      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype as (new () => object) | undefined;
        if (!metatype) continue;

        for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
          if (name === 'constructor') continue;
          const handler = (metatype.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;

          // Only real routes: NestJS stamps a path on handlers it exposes.
          const path: unknown = Reflect.getMetadata('path', handler);
          if (path === undefined) continue;

          const read = (key: string): unknown =>
            Reflect.getMetadata(key, handler) ??
            Reflect.getMetadata(key, metatype);

          const permission = read(REQUIRED_PERMISSION_KEY);
          const marker = read(IS_PUBLIC_KEY)
            ? 'public'
            : read(MFA_FLOW_ONLY_KEY)
              ? 'mfa-flow'
              : read(OWN_ACCOUNT_KEY)
                ? 'own-account'
                : permission
                  ? 'permission'
                  : 'UNDECLARED';

          const controllerPath: unknown = Reflect.getMetadata('path', metatype);

          routes.push({
            route: `${metatype.name}.${name}`,
            path: joinPath(controllerPath, path),
            marker,
            permission,
            siteScope: read(SITE_SCOPE_KEY),
          });
        }
      }
    }

    // If this finds nothing, the walk is broken and every assertion below
    // would pass vacuously — which is worse than failing.
    expect(routes.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it('AU-010 leaves no route without a declaration', () => {
    const undeclared = routes
      .filter((r) => r.marker === 'UNDECLARED')
      .map((r) => r.route);

    expect(
      undeclared,
      'Add @RequirePermission(), @Public(), @MfaFlowOnly() or @OwnAccount()',
    ).toEqual([]);
  });

  it('AU-010 names a real permission wherever one is declared', () => {
    // A typo grants nothing and denies nothing: the route simply becomes
    // unreachable, and nobody can work out why.
    const unknown = routes
      .filter((r) => r.marker === 'permission')
      .filter((r) => !PERMISSIONS.includes(r.permission as never))
      .map((r) => `${r.route} -> ${String(r.permission)}`);

    expect(unknown).toEqual([]);
  });

  it('AU-011 makes every permission route state how the site is checked', () => {
    // Closing the permission dimension by default and leaving the SITE
    // dimension open would be closing the wrong one: in a multi-site clinic
    // the site is what produces improper access. `global` is a valid answer —
    // stating it is the point, so "no site check" is a decision somebody wrote
    // down rather than something nobody considered.
    const undeclared = routes
      .filter((r) => r.marker === 'permission')
      .filter((r) => !r.siteScope)
      .map((r) => r.route);

    expect(
      undeclared,
      'Pass a site scope to @RequirePermission: param:<name>, query or global',
    ).toEqual([]);
  });

  it('AU-011 narrows to the site whenever the site is in the URL', () => {
    /**
     * The previous test only asks that SOMETHING be declared, and `global` is
     * an accepted answer — so a route that takes a site id in its path and
     * declares `global` passes it while checking nothing. That is not a
     * hypothetical: the site scope was declared and wrong in `organization`
     * until a review caught it by reading, and reading does not scale to every
     * route added from here on.
     *
     * `param:<name>` is the only correct answer when the name is right there
     * in the URL, because it is the one the GUARD can enforce on its own.
     * `query` would push the check into a handler that is already holding the
     * value, and `global` would drop it.
     */
    const wrong = routes
      .filter((r) => r.marker === 'permission')
      .flatMap((r) => {
        const param = siteParamOf(r.path);
        if (!param) return [];

        const expected = `param:${param}`;
        if (r.siteScope === expected) return [];

        return [`${r.route} (${r.path}) declares ${String(r.siteScope)}`];
      });

    expect(
      wrong,
      'A route whose URL carries a site id must declare param:<that name>',
    ).toEqual([]);
  });

  it('AU-010 keeps the public surface small and deliberate', () => {
    // Anything reachable without a token is attack surface. The list is
    // asserted exactly, so widening it is a decision somebody has to make in a
    // diff rather than something that drifts.
    const publicRoutes = routes
      .filter((r) => r.marker === 'public')
      .map((r) => r.route)
      .sort();

    /**
     * The two credential routes are PUBLIC BY NECESSITY, and this list is
     * where that decision is visible (AU-021, D-013). Somebody who cannot sign
     * in is exactly who has to reach them: one says whether an invitation link
     * is still good, the other is how they set their first password. Both
     * answer the same thing for an unknown, a spent and an expired token
     * (AU-028), both are rate limited like `login`, and neither confirms that
     * any account exists.
     */
    expect(publicRoutes).toEqual([
      'AuthController.checkCredential',
      'AuthController.login',
      'AuthController.refresh',
      'AuthController.setCredential',
      'HealthController.check',
      'LivenessController.ping',
    ]);
  });

  it('confines the half-authenticated session to the MFA flow', () => {
    // A token that has not passed the second factor reaches these and nothing
    // else. If anything unrelated appears here, MFA became decorative.
    const mfaRoutes = routes
      .filter((r) => r.marker === 'mfa-flow')
      .map((r) => r.route)
      .sort();

    expect(mfaRoutes).toEqual([
      'AuthController.confirmMfa',
      'AuthController.enrollMfa',
      'AuthController.verifyMfa',
    ]);
  });
});
