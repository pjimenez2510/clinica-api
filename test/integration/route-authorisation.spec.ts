import type { INestApplication } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as z from 'zod';
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
 * The DTO class NestJS will fill the `@Body()` parameter with, or `undefined`.
 *
 * Read the same way the framework reads it: `ROUTE_ARGS_METADATA` says which
 * parameter INDEX carries the body, and `design:paramtypes` says what that
 * index is declared as. A list of «this handler takes this DTO» maintained by
 * hand would drift the first time somebody added a parameter.
 */
function bodyDtoOf(
  controller: new (...args: never[]) => object,
  handlerName: string,
): unknown {
  const args: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    handlerName,
  );
  const parameters: unknown = Reflect.getMetadata(
    'design:paramtypes',
    controller.prototype as object,
    handlerName,
  );
  if (typeof args !== 'object' || args === null) return undefined;
  if (!Array.isArray(parameters)) return undefined;

  const entry = Object.entries(args as Record<string, { index: number }>).find(
    ([key]) => key.startsWith(`${RouteParamtypes.BODY}:`),
  );

  return entry ? (parameters as unknown[])[entry[1].index] : undefined;
}

/**
 * Every path in a DTO's schema that names a site, at any depth.
 *
 * Through JSON Schema and not through the Zod internals: `z.toJSONSchema` is
 * public API and flattens arrays, unions, optionals and nested objects on its
 * own, so `grants[].siteId` is found without this function knowing what a
 * `ZodArray` is. `unrepresentable: 'any'` keeps a refinement or a transform
 * from turning «no lo sé representar» into a crash that would silently skip
 * the DTO — a check that stops checking is worse than no check.
 */
function siteFieldsOf(dto: unknown): string[] {
  const schema = (dto as { schema?: unknown } | undefined)?.schema;
  if (!(schema instanceof z.ZodType)) return [];

  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const field of Object.keys(value)) {
          if (/^site_?ids?$/i.test(field)) found.push(`${path}.${field}`);
        }
      }
      walk(value, key === 'properties' ? path : `${path}.${key}`);
    }
  };

  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), '');
  return found;
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
    /** D-023: the fields of the `@Body()` DTO that name a site, at any depth. */
    bodySiteFields: string[];
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
            bodySiteFields: siteFieldsOf(bodyDtoOf(metatype, name)),
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

  it('AU-011 no deja una ruta `global` recibiendo un siteId en el cuerpo (D-023)', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA QUE HABRÍA ENCONTRADO ST-047, AG-105 Y LAS SEIS DE D-023
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Las dos pruebas de arriba no podían verlo, y decirlo importa más que la
     * prueba: la primera pide que HAYA declaración y acepta `global`; la
     * segunda sólo mira la URL. Cuando la sede viaja en el CUERPO, `global`
     * pasa las dos mientras no comprueba nada — y el guard no puede
     * comprobarlo por sí mismo, porque corre antes de los pipes y el cuerpo
     * todavía no está validado.
     *
     * Así que esto pregunta por el sitio donde el agujero es visible: el DTO.
     * Una ruta que dice «no tengo dimensión de sede» y recibe un `siteId` en
     * el cuerpo se está contradiciendo, y una de las dos afirmaciones es
     * falsa. La respuesta correcta casi siempre es declarar `'query'` y
     * comprobarlo en el handler con el alcance resuelto de la sesión
     * (`assertSiteInScope` / `assertScopesInScope`); la otra respuesta posible
     * es razonar la excepción AQUÍ, en la lista de abajo, donde se lee en el
     * diff.
     *
     * NO DEMUESTRA QUE LA COMPROBACIÓN EXISTA, y no puede: `'query'` significa
     * «la estrecha el handler», y si el handler no lo hace sólo lo ve su
     * prueba. Lo que quita de en medio es la forma de este fallo que nadie
     * mira, que es la que se repitió cinco veces.
     */
    const EXEMPT: Record<string, string> = {
      // Vacío a propósito. Una entrada aquí es una decisión, no un atajo: hay
      // que escribir por qué esa ruta recibe una sede y aun así no tiene
      // dimensión de sede que comprobar.
    };

    const contradictory = routes
      .filter((r) => r.marker === 'permission' && r.siteScope === 'global')
      .filter((r) => r.bodySiteFields.length > 0)
      .filter((r) => !(r.route in EXEMPT))
      .map((r) => `${r.route} (${r.path}) recibe ${r.bodySiteFields.join(', ')}`); // prettier-ignore

    expect(
      contradictory,
      'Declara `query` y comprueba el alcance en el handler, o razona la excepción en EXEMPT',
    ).toEqual([]);
  });

  it('AU-011 y la prueba anterior no pasa por no encontrar ningún DTO', () => {
    // Una prueba que pasa porque su lectura se rompió es peor que una que
    // falla: `bodyDtoOf` lee metadatos de NestJS, y el día que cambien de
    // forma la comprobación de arriba se volvería vacua en silencio.
    const withBodySite = routes.filter((r) => r.bodySiteFields.length > 0);

    expect(withBodySite.length).toBeGreaterThan(0);
    // Y las que D-023 cerró están entre ellas, ya declarando `query`.
    expect(
      withBodySite
        .filter((r) => r.siteScope === 'query')
        .map((r) => r.route)
        .sort(),
    ).toEqual(
      expect.arrayContaining([
        'AuthAdminController.replaceUserRoles',
        'ConfigurationController.createHoliday',
        'ConfigurationController.updateHoliday',
        'StaffController.replaceSites',
        'StaffScheduleController.create',
        'StaffScheduleController.update',
      ]),
    );
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

  it('AU-037 exige una sesión COMPLETA para cambiar el segundo factor', () => {
    /**
     * La lista de arriba ya lo dice por omisión, y esto lo dice a la cara: si
     * alguna de estas dos rutas acabara marcada `@MfaFlowOnly()` —copiando la
     * de al lado, que es como pasan estas cosas— un token que todavía no ha
     * pasado el segundo factor podría sustituirlo, y la prueba de posesión
     * que hace segura a AU-037 dejaría de exigir posesión de nada.
     *
     * `own-account` y no un permiso: cambiar el propio segundo factor no
     * tiene dimensión de rol, igual que cerrar sesión o cambiar la propia
     * contraseña. Modelarlo como permiso dejaría sin cambiar de teléfono a
     * quien tenga un rol al que se le olvidó marcarlo.
     */
    const change = routes.filter((r) =>
      ['AuthController.changeMfa', 'AuthController.confirmMfaChange'].includes(
        r.route,
      ),
    );

    expect(change.map((r) => r.route).sort()).toEqual([
      'AuthController.changeMfa',
      'AuthController.confirmMfaChange',
    ]);
    expect(change.map((r) => r.marker)).toEqual(['own-account', 'own-account']);
  });
});
