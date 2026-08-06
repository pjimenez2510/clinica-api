import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import {
  IS_PUBLIC_KEY,
  MFA_FLOW_ONLY_KEY,
  OWN_ACCOUNT_KEY,
  REQUIRED_PERMISSION_KEY,
  SITE_SCOPE_KEY,
} from '../../src/shared/http/auth.decorators';
import { PERMISSIONS } from '../../src/shared/authorisation/permission.catalogue';

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
    marker: string;
    permission?: unknown;
    siteScope?: unknown;
  }

  let routes: RouteInfo[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
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

          routes.push({
            route: `${metatype.name}.${name}`,
            marker,
            permission,
            siteScope: read(SITE_SCOPE_KEY),
          });
        }
      }
    }

    await app.close();
    // If this finds nothing, the walk is broken and every assertion below
    // would pass vacuously — which is worse than failing.
    expect(routes.length).toBeGreaterThan(0);
  });

  it('leaves no route without a declaration', () => {
    const undeclared = routes
      .filter((r) => r.marker === 'UNDECLARED')
      .map((r) => r.route);

    expect(
      undeclared,
      'Add @RequirePermission(), @Public(), @MfaFlowOnly() or @OwnAccount()',
    ).toEqual([]);
  });

  it('names a real permission wherever one is declared', () => {
    // A typo grants nothing and denies nothing: the route simply becomes
    // unreachable, and nobody can work out why.
    const unknown = routes
      .filter((r) => r.marker === 'permission')
      .filter((r) => !PERMISSIONS.includes(r.permission as never))
      .map((r) => `${r.route} -> ${String(r.permission)}`);

    expect(unknown).toEqual([]);
  });

  it('makes every permission route state how the site is checked', () => {
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

  it('keeps the public surface small and deliberate', () => {
    // Anything reachable without a token is attack surface. The list is
    // asserted exactly, so widening it is a decision somebody has to make in a
    // diff rather than something that drifts.
    const publicRoutes = routes
      .filter((r) => r.marker === 'public')
      .map((r) => r.route)
      .sort();

    expect(publicRoutes).toEqual([
      'AuthController.login',
      'AuthController.refresh',
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
