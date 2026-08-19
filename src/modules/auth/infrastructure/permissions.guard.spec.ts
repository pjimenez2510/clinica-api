import { Controller, Get, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common'; // prettier-ignore
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ResolvedGrant } from '../../../shared/authorisation/principal';
import {
  CURRENT_USER,
  REQUIRED_PERMISSION_KEY,
  RequirePermission,
} from '../../../shared/http/auth.decorators';
import { ProblemDetailsFilter } from '../../../shared/http/problem-details.filter';

import { PermissionsGuard } from './permissions.guard';
import { RolePermissionRegistry } from './role-permission.registry';

import type { AccessTokenClaims } from './token.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CERRADO POR DEFECTO, EJERCITADO DE VERDAD (CLAUDE.md §6, ADR-007 §3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POR QUÉ ESTE ARCHIVO EXISTE. `route-authorisation.spec.ts` recorre las rutas
 * que NestJS registró y falla si alguna no declara su permiso — pero lo hace
 * LEYENDO METADATOS: nunca invoca el guard. Una auditoría por mutación lo
 * demostró sustituyendo `throw new RouteNotSecuredError('permission')` por
 * `return true`: las 1141 pruebas unitarias y la suite de integración entera
 * siguieron en verde. La invariante número uno del sistema no la hacía cumplir
 * ninguna prueba que se ejecutara.
 *
 * Aquí el guard SE EJECUTA, sobre controladores de usar y tirar montados sólo
 * para esto, y lo que se afirma es la RESPUESTA: 403 y el `code` estable, que
 * es lo que un cliente ve. Los tres rechazos que el guard puede emitir por sí
 * mismo tienen su caso, y el camino feliz también — sin él, un guard que
 * rechazara todo pasaría igual.
 *
 * SIN BASE DE DATOS Y SIN AppModule, a propósito: lo que se prueba es una
 * decisión de autorización, no un repositorio. `RolePermissionRegistry` entra
 * como doble porque resolver un rol es lo único que el guard delega, y la
 * sesión la publica un guard de prueba que ocupa el sitio de `JwtAuthGuard`
 * — que no es lo que se está probando y exigiría emitir un token real.
 */

const USER = '00000000-0000-4000-8000-000000000001';
const NORTE = '00000000-0000-4000-8000-0000000000a1';
const SUR = '00000000-0000-4000-8000-0000000000a2';

/** La cabecera con la que una prueba dice «esta petición trae sesión». */
const SESSION_HEADER = 'x-test-session';

interface Problem {
  title: string;
  status: number;
  code: string;
}

/**
 * Una ruta que NADIE decoró. El descuido que este guard existe para castigar.
 *
 * No lleva `@Public()`, ni `@RequirePermission()`, ni ningún marcador: es
 * exactamente lo que aparece cuando alguien añade un endpoint y se olvida de
 * declarar su permiso «para después».
 */
@Controller('undeclared')
class UndeclaredController {
  @Get()
  read(): { reached: boolean } {
    return { reached: true };
  }
}

/**
 * Media declaración: permiso sí, alcance por sede no.
 *
 * `@RequirePermission()` pone las dos metadatas a la vez, así que esta mitad
 * sólo se alcanza escribiendo la metadata a mano — que es justo lo que ocurre
 * el día que alguien copia un `SetMetadata` de otro sitio en lugar de usar el
 * decorador.
 */
@Controller('permission-only')
class PermissionOnlyController {
  @Get()
  @SetMetadata(REQUIRED_PERMISSION_KEY, 'patient:read')
  read(): { reached: boolean } {
    return { reached: true };
  }
}

/** La declaración completa, con la sede en la URL: la que el guard sí arbitra. */
@Controller('sites/:siteId/patients')
class SiteScopedController {
  @Get()
  @RequirePermission('patient:read', 'param:siteId')
  read(): { reached: boolean } {
    return { reached: true };
  }
}

/** Un permiso que la sesión de prueba no trae. */
@Controller('merge')
class OtherPermissionController {
  @Get()
  @RequirePermission('patient:merge', 'global')
  read(): { reached: boolean } {
    return { reached: true };
  }
}

/**
 * Ocupa el sitio de `JwtAuthGuard`: publica los claims en el contexto cuando
 * la petición dice traer sesión, y no publica nada cuando no.
 *
 * La segunda mitad no es decorativa: es la única forma de llegar a
 * `PRINCIPAL_UNAVAILABLE`, que es el fallo de cableado —el guard de permisos
 * corriendo antes que el de sesión— que el guard convierte en un error ruidoso
 * en lugar de en una denegación corriente.
 */
class TestSessionGuard implements CanActivate {
  constructor(private readonly cls: ClsService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();

    if (request.headers[SESSION_HEADER] !== 'yes') return true;

    // Los claims COMPLETOS, no un objeto recortado con un `as`: si el token
    // gana un campo obligatorio, esta prueba deja de compilar en lugar de
    // seguir ejercitando un contexto que la aplicación nunca produce.
    const claims: AccessTokenClaims = {
      sub: USER,
      fam: '00000000-0000-4000-8000-0000000000f1',
      grants: [{ roleId: 'role-recepcion', siteId: NORTE }],
      mfa: true,
    };
    this.cls.set(CURRENT_USER, claims);
    return true;
  }
}

/**
 * El doble del registro rol→permiso.
 *
 * Devuelve `patient:read` en la sede Norte y nada más, que es lo que hace
 * comprobables las dos dimensiones: el permiso que falta (`patient:merge`) y
 * la sede que no es la suya (Sur).
 */
const registry = {
  resolve: (): Promise<ResolvedGrant[]> =>
    Promise.resolve([
      { roleCode: 'RECEPCION', siteId: NORTE, permissions: ['patient:read'] },
    ]),
};

describe('PermissionsGuard, cerrado por defecto', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Sin `validate`: lo único que el filtro le pregunta es si esto es
        // producción, y validar el entorno entero aquí obligaría a inventar
        // veinte variables que nada de lo que se prueba usa.
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true, generateId: true },
        }),
      ],
      controllers: [
        UndeclaredController,
        PermissionOnlyController,
        SiteScopedController,
        OtherPermissionController,
      ],
      providers: [
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        // EL ORDEN IMPORTA y reproduce el de la aplicación: la sesión primero,
        // los permisos después. Es el orden que `PermissionsGuard` da por
        // supuesto en su comentario, y el que su rama de claims ausentes
        // protege.
        {
          provide: APP_GUARD,
          useFactory: (cls: ClsService) => new TestSessionGuard(cls),
          inject: [ClsService],
        },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: RolePermissionRegistry, useValue: registry },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const withSession = (path: string) =>
    request(app.getHttpServer()).get(path).set(SESSION_HEADER, 'yes');

  it('AU-010 REFUSES a route that declares no permission, with a valid session', async () => {
    /**
     * LA MUTACIÓN QUE ESTA PRUEBA CAZA: `throw new
     * RouteNotSecuredError('permission')` → `return true`.
     *
     * La sesión es válida y el permiso que trae daría igual: lo que se rechaza
     * es la RUTA, por no declarar nada. Se afirma el `code` y no sólo el 403,
     * porque un 403 también lo produce un permiso que falta — y confundirlos
     * sería no distinguir «este usuario no puede» de «este endpoint está
     * abierto».
     */
    const response = await withSession('/undeclared').expect(403);
    const problem = response.body as Problem;

    expect(problem.code).toBe('ROUTE_NOT_SECURED');
    expect(problem.status).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
  });

  it('AU-010 REFUSES a route that declares a permission but no site scope', async () => {
    // La otra mitad de la declaración. Sin esto, «esta ruta no comprueba sede»
    // vuelve a ser algo en lo que nadie pensó en vez de algo que alguien
    // escribió.
    const response = await withSession('/permission-only').expect(403);

    expect((response.body as Problem).code).toBe('ROUTE_NOT_SECURED');
  });

  it('AU-010 REFUSES the request when no guard published the claims', async () => {
    /**
     * El fallo de cableado, ruidoso a propósito.
     *
     * Construir un principal vacío aquí convertiría un guard mal ordenado en
     * una denegación corriente — indistinguible, en los registros y para quien
     * llama, de un permiso que el usuario simplemente no tiene.
     */
    const response = await request(app.getHttpServer())
      .get(`/sites/${NORTE}/patients`)
      .expect(403);

    expect((response.body as Problem).code).toBe('PRINCIPAL_UNAVAILABLE');
  });

  it('AU-010 REFUSES a permission the caller does not hold', async () => {
    const response = await withSession('/merge').expect(403);

    expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
  });

  it("AU-011 REFUSES the right permission at a site that is not the caller's", async () => {
    // La dimensión de sede, comprobada ADEMÁS del rol: el mismo permiso, la
    // misma sesión, otra sede.
    const response = await withSession(`/sites/${SUR}/patients`).expect(403);

    expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
  });

  it('AU-011 lets through the permission held AT THAT SITE', async () => {
    /**
     * EL CAMINO FELIZ NO ES RELLENO. Sin él, un guard que rechazara todas las
     * peticiones —la mutación opuesta— dejaría las cinco pruebas de arriba en
     * verde y no probaría nada.
     */
    const response = await withSession(`/sites/${NORTE}/patients`).expect(200);

    expect(response.body).toEqual({ reached: true });
  });
});
