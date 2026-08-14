import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  EXPLICIT_GRANT_ONLY_PERMISSIONS,
  PERMISSION_DEFINITIONS,
} from '../../../shared/authorisation/permission.catalogue';
import {
  CannotDemoteSelfError,
  PermissionNotInstalledError,
  RoleNotFoundError,
  SystemRoleProtectedError,
  UnknownPermissionError,
} from '../domain/auth.errors';

import type {
  CreateRoleInput,
  RoleAdminRepositoryPort,
  RolePatch,
  RoleView,
} from './admin-ports';
import { AuthAdminAuditTrail } from './auth-admin-audit.trail';
import { RolesService } from './roles.service';

/**
 * The rules that are the SERVICE's to enforce, against a double of its port.
 *
 * The third shape of AU-024 lives here and it is the one that scales worst if
 * it is wrong: deleting or emptying the last active role that carries
 * `user:manage` leaves an installation nobody can administer, and unlike the
 * other two shapes it does not need the acting administrator to be careless
 * about their own account — they can do it while editing somebody else's role.
 *
 * The database has the final word (`trg_role_permission_keep_an_administrator`
 * and `trg_role_protect_system`), exercised in
 * `test/integration/auth-admin-http.spec.ts`. These are what make the ANSWER
 * stable: a refusal that depends on a PostgreSQL message is a refusal whose
 * wording changes with a minor version.
 */

const ADMIN_ID = 'user-admin';
const REQUESTER = { userId: ADMIN_ID, ip: '10.0.0.1' };

const ADMIN_ROLE: RoleView = {
  id: 'role-admin',
  code: 'ADMIN',
  name: 'Administrador del sistema',
  description: null,
  isSystem: true,
  active: true,
  liveGrants: 1,
};

const CUSTOM_ROLE: RoleView = {
  id: 'role-custom',
  code: 'AUDITOR_EXTERNO',
  name: 'Auditor externo',
  description: null,
  isSystem: false,
  active: true,
  liveGrants: 0,
};

interface Call {
  method: string;
  args: unknown[];
}

class RolesDouble implements RoleAdminRepositoryPort {
  readonly calls: Call[] = [];
  roles: RoleView[] = [ADMIN_ROLE, CUSTOM_ROLE];
  /** ACTIVE roles carrying `user:manage`. The heart of AU-024. */
  administering: RoleView[] = [ADMIN_ROLE];
  /** Role ids the CALLER holds through a live grant. */
  heldByCaller: string[] = [ADMIN_ROLE.id];
  permissions: string[] = [];
  /**
   * Codes the `permission` mirror does NOT have, which is the state between a
   * deploy and `pnpm db:seed:auth`. Empty by default: an installation whose
   * mirror is published is the normal case, and every other test here assumes
   * it.
   */
  notInstalled: string[] = [];

  list(includeInactive: boolean): Promise<readonly RoleView[]> {
    this.calls.push({ method: 'list', args: [includeInactive] });
    return Promise.resolve(this.roles);
  }

  findById(id: string): Promise<RoleView | null> {
    this.calls.push({ method: 'findById', args: [id] });
    return Promise.resolve(this.roles.find((role) => role.id === id) ?? null);
  }

  create(input: CreateRoleInput): Promise<RoleView> {
    this.calls.push({ method: 'create', args: [input] });
    return Promise.resolve({ ...CUSTOM_ROLE, ...input });
  }

  update(id: string, patch: RolePatch): Promise<RoleView | null> {
    this.calls.push({ method: 'update', args: [id, patch] });
    const role = this.roles.find((candidate) => candidate.id === id);
    return Promise.resolve(role ? { ...role, ...patch } : null);
  }

  delete(id: string): Promise<boolean> {
    this.calls.push({ method: 'delete', args: [id] });
    return Promise.resolve(true);
  }

  listPermissions(roleId: string): Promise<readonly string[]> {
    this.calls.push({ method: 'listPermissions', args: [roleId] });
    return Promise.resolve(this.permissions);
  }

  installedPermissions(codes: readonly string[]): Promise<readonly string[]> {
    this.calls.push({ method: 'installedPermissions', args: [codes] });
    return Promise.resolve(
      codes.filter((code) => !this.notInstalled.includes(code)),
    );
  }

  replacePermissions(
    roleId: string,
    codes: readonly string[],
    grantedById: string,
  ): Promise<readonly string[]> {
    this.calls.push({ method: 'replacePermissions', args: [roleId, codes, grantedById] }); // prettier-ignore
    this.permissions = [...codes];
    return Promise.resolve(this.permissions);
  }

  rolesGranting(permission: string): Promise<readonly RoleView[]> {
    this.calls.push({ method: 'rolesGranting', args: [permission] });
    return Promise.resolve(this.administering);
  }

  liveRoleIdsOf(userId: string): Promise<readonly string[]> {
    this.calls.push({ method: 'liveRoleIdsOf', args: [userId] });
    return Promise.resolve(this.heldByCaller);
  }
}

describe('la administración de roles', () => {
  let repository: RolesDouble;
  let recorded: AccessAuditEntry[];
  let invalidations: number;
  let service: RolesService;

  beforeEach(() => {
    repository = new RolesDouble();
    recorded = [];
    invalidations = 0;
    service = new RolesService(
      repository,
      {
        invalidate: () => {
          invalidations += 1;
        },
      },
      new AuthAdminAuditTrail({
        record: (entry) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      }),
    );
  });

  describe('crear y editar', () => {
    it('AU-030 crea un rol propio de la clínica', async () => {
      const created = await service.create(
        { code: 'ENLACE_SEGUROS', name: 'Enlace con aseguradoras' },
        REQUESTER,
      );

      expect(created.code).toBe('ENLACE_SEGUROS');
      expect(recorded[0]).toMatchObject({
        action: 'CREATE',
        resourceType: 'auth',
      });
    });

    it('AU-030 permite renombrar un rol del sistema: lo editable es el nombre', async () => {
      const updated = await service.update(
        ADMIN_ROLE.id,
        { name: 'Gerencia' },
        REQUESTER,
      );

      expect(updated.name).toBe('Gerencia');
    });

    it('AU-030 responde ROLE_NOT_FOUND para un rol que no existe', async () => {
      await expect(
        service.update('role-inventado', { name: 'X' }, REQUESTER),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
    });
  });

  describe('borrar y desactivar', () => {
    it('AU-031 no borra un rol del sistema y ofrece desactivarlo', async () => {
      try {
        await service.delete(ADMIN_ROLE.id, REQUESTER);
        expect.unreachable('debía rechazarse');
      } catch (error) {
        expect(error).toBeInstanceOf(SystemRoleProtectedError);
        expect((error as SystemRoleProtectedError).userTitle).toContain(
          'desactivarlo',
        );
      }
      expect(repository.calls.some((call) => call.method === 'delete')).toBe(
        false,
      );
    });

    it('AU-031 borra un rol propio sin concesiones vivas', async () => {
      repository.administering = [ADMIN_ROLE];

      await service.delete(CUSTOM_ROLE.id, REQUESTER);

      expect(repository.calls).toContainEqual({
        method: 'delete',
        args: [CUSTOM_ROLE.id],
      });
      expect(invalidations).toBe(1);
    });

    it('AU-024 no borra el último rol activo que administra usuarios', async () => {
      // La tercera forma, y la peor: no hace falta que el administrador se
      // descuide con su propia cuenta — puede llegar aquí editando el rol de
      // otra persona.
      repository.roles = [{ ...CUSTOM_ROLE }];
      repository.administering = [CUSTOM_ROLE];

      await expect(
        service.delete(CUSTOM_ROLE.id, REQUESTER),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 no desactiva el último rol activo que administra usuarios', async () => {
      // Desactivar concede exactamente lo mismo que borrar —o sea, nada—,
      // porque `role-permission.registry.ts` excluye los inactivos en la
      // consulta. Es la misma catástrofe por una puerta más silenciosa.
      repository.administering = [ADMIN_ROLE];

      await expect(
        service.update(ADMIN_ROLE.id, { active: false }, REQUESTER),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 sí desactiva uno cuando queda otro rol activo que administra', async () => {
      repository.roles = [ADMIN_ROLE, { ...CUSTOM_ROLE, active: true }];
      repository.administering = [ADMIN_ROLE, CUSTOM_ROLE];

      await expect(
        service.update(CUSTOM_ROLE.id, { active: false }, REQUESTER),
      ).resolves.toMatchObject({ active: false });
    });

    it('AU-024 no se deja engañar por un rol que administra y nadie tiene', async () => {
      // El camino que sí bricaba la instalación, en tres acciones de pantalla
      // corrientes: crear un rol, darle `user:manage` —permitido, no concede
      // nada a nadie— y desactivar el administrador de verdad. Contando roles,
      // la cuenta daba dos y la guarda callaba; el llamante perdía todos sus
      // permisos en la siguiente petición y nadie tenía el rol nuevo.
      const SIN_NADIE: RoleView = {
        id: 'role-supervisor',
        code: 'SUPERVISOR',
        name: 'Supervisor',
        description: null,
        isSystem: false,
        active: true,
        liveGrants: 0,
      };
      repository.roles = [ADMIN_ROLE, SIN_NADIE];
      repository.administering = [ADMIN_ROLE, SIN_NADIE];

      await expect(
        service.update(ADMIN_ROLE.id, { active: false }, REQUESTER),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-031 no estorba al desactivar un rol que no administra usuarios', async () => {
      repository.administering = [ADMIN_ROLE];

      await expect(
        service.update(CUSTOM_ROLE.id, { active: false }, REQUESTER),
      ).resolves.toMatchObject({ active: false });
    });
  });

  describe('los permisos de un rol', () => {
    it('AU-033 expone el catálogo con su recurso y su descripción', () => {
      // Sin la descripción, quien asigna marca casillas por su forma. Se lee
      // del CÓDIGO y no de la tabla: la tabla es un espejo, y si divergen es
      // el código el que decide qué comprueba cada ruta.
      const catalogue = service.catalogue();

      expect(catalogue).toEqual(PERMISSION_DEFINITIONS);
      expect(catalogue.every((entry) => entry.description.length > 0)).toBe(true); // prettier-ignore
      expect(catalogue.every((entry) => entry.resource.length > 0)).toBe(true);
    });

    it('AU-033 expone el catálogo ENTERO, incluidos los que hay que conceder a propósito', () => {
      // `explicitGrantOnly` gobierna a las semillas, no a la pantalla: si el
      // permiso desapareciera del catálogo, la clínica no podría concedérselo
      // a nadie y AU-035 sería inalcanzable — el fallo opuesto, y también deja
      // al médico fuera.
      const codes = service.catalogue().map((entry) => entry.code);

      for (const risky of EXPLICIT_GRANT_ONLY_PERMISSIONS) {
        expect(codes, risky).toContain(risky);
      }
    });

    it('AU-033 no publica la marca interna de cómo se concede un permiso', () => {
      // La forma publicada es `PermissionDto`: tres campos. Un cuarto que el
      // documento OpenAPI no declara es un campo que el frontend acaba
      // escribiendo a mano.
      for (const entry of service.catalogue()) {
        expect(Object.keys(entry).sort()).toEqual([
          'code',
          'description',
          'resource',
        ]);
      }
    });

    it('AU-033 rechaza un código de permiso que el sistema no declara', async () => {
      try {
        await service.replacePermissions(
          CUSTOM_ROLE.id,
          ['agenda:read', 'historia:borrar'],
          REQUESTER,
        );
        expect.unreachable('debía rechazarse');
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownPermissionError);
        expect(
          (error as UnknownPermissionError).fieldErrors?.[0]?.message,
        ).toContain(
          // prettier-ignore
          'historia:borrar',
        );
      }
    });

    it('AU-033 no escribe nada cuando uno solo de los códigos es desconocido', async () => {
      // Un rol a medio actualizar porque el cuarto código tenía una errata es
      // peor que un rechazo: concede un conjunto que nadie eligió.
      await expect(
        service.replacePermissions(
          CUSTOM_ROLE.id,
          ['agenda:read', 'agenda:write', 'no:existe'],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(UnknownPermissionError);

      expect(
        repository.calls.some((call) => call.method === 'replacePermissions'),
      ).toBe(false);
    });

    it('AU-033 distingue un permiso que el código no declara de uno que la base aún no tiene', async () => {
      /**
       * EL FALLO REAL, REPRODUCIDO. Conceder `user:reset-mfa` recién declarado
       * contra una base que todavía no había corrido `pnpm db:seed:auth` moría
       * en la clave foránea y llegaba a la pantalla como «Datos inválidos»
       * sobre un formulario donde nada era inválido — y sin nombrar el permiso,
       * así que ni quien administra ni soporte podían saber qué hacer.
       *
       * Los dos códigos son distintos a propósito: `UNKNOWN_PERMISSION` dice
       * «actualice la pantalla, eso no existe» y sería mentira aquí.
       */
      repository.notInstalled = ['user:reset-mfa'];

      try {
        await service.replacePermissions(
          CUSTOM_ROLE.id,
          ['agenda:read', 'user:reset-mfa'],
          REQUESTER,
        );
        expect.unreachable('debía rechazarse');
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionNotInstalledError);
        expect((error as PermissionNotInstalledError).code).toBe(
          'PERMISSION_NOT_INSTALLED',
        );
        expect(
          (error as PermissionNotInstalledError).fieldErrors?.[0]?.message,
        ).toContain('user:reset-mfa');
      }

      // Y no escribe nada: el rol conserva lo que ya tenía en vez de quedarse
      // con el subconjunto que sí estaba instalado.
      expect(
        repository.calls.some((call) => call.method === 'replacePermissions'),
      ).toBe(false);
    });

    it('AU-033 descarta los códigos repetidos en lugar de escribirlos dos veces', async () => {
      await service.replacePermissions(
        CUSTOM_ROLE.id,
        ['agenda:read', 'agenda:read'],
        REQUESTER,
      );

      const call = repository.calls.find(
        (candidate) => candidate.method === 'replacePermissions',
      );
      expect(call?.args[1]).toEqual(['agenda:read']);
    });

    it('AU-034 ADVIERTE de la combinación de riesgo y guarda igualmente', async () => {
      // El requisito es exactamente esto: advertir sin impedir. Rechazarlo
      // empujaría a una clínica pequeña a compartir una cuenta, que es peor
      // para la bitácora que la combinación en sí.
      const result = await service.replacePermissions(
        CUSTOM_ROLE.id,
        ['user:manage', 'record:read'],
        REQUESTER,
      );

      expect(result.permissions).toEqual(['user:manage', 'record:read']);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('historia clínica');
    });

    it('AU-034 no advierte nada cuando la combinación es corriente', async () => {
      const result = await service.replacePermissions(
        CUSTOM_ROLE.id,
        ['agenda:read', 'patient:read'],
        REQUESTER,
      );

      expect(result.warnings).toEqual([]);
    });

    it('AU-032 invalida la caché para que el cambio rija en la petición siguiente', async () => {
      await service.replacePermissions(
        CUSTOM_ROLE.id,
        ['agenda:read'],
        REQUESTER,
      );

      expect(invalidations).toBe(1);
    });

    it('AU-024 no deja al sistema sin ningún rol que administre usuarios', async () => {
      repository.roles = [ADMIN_ROLE];
      repository.administering = [ADMIN_ROLE];

      await expect(
        service.replacePermissions(
          ADMIN_ROLE.id,
          ['site:read', 'catalog:read'],
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 impide que el administrador se quite la administración por la vía del rol', async () => {
      // Queda OTRO rol que administra, así que la instalación sobrevive — pero
      // no es el que tiene quien está editando, y quedaría fuera de la
      // pantalla que acaba de usar.
      const otherAdminRole = { ...CUSTOM_ROLE, id: 'role-other-admin' };
      repository.roles = [ADMIN_ROLE, otherAdminRole];
      repository.administering = [ADMIN_ROLE, otherAdminRole];
      repository.heldByCaller = [ADMIN_ROLE.id];

      await expect(
        service.replacePermissions(ADMIN_ROLE.id, ['site:read'], REQUESTER),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 lo permite cuando quien edita conserva la administración por otro rol', async () => {
      const otherAdminRole = { ...CUSTOM_ROLE, id: 'role-other-admin' };
      repository.roles = [ADMIN_ROLE, otherAdminRole];
      repository.administering = [ADMIN_ROLE, otherAdminRole];
      // El administrador tiene los DOS roles: quitarle el permiso a uno le
      // deja el otro, y la pantalla sigue siendo suya.
      repository.heldByCaller = [ADMIN_ROLE.id, otherAdminRole.id];

      await expect(
        service.replacePermissions(ADMIN_ROLE.id, ['site:read'], REQUESTER),
      ).resolves.toMatchObject({ permissions: ['site:read'] });
    });

    it('AU-024 no estorba al editar un rol que quien administra no tiene', async () => {
      repository.administering = [ADMIN_ROLE];
      repository.heldByCaller = [ADMIN_ROLE.id];

      await expect(
        service.replacePermissions(CUSTOM_ROLE.id, ['audit:read'], REQUESTER),
      ).resolves.toMatchObject({ permissions: ['audit:read'] });
    });

    it('AU-033 responde ROLE_NOT_FOUND al leer los permisos de un rol inexistente', async () => {
      await expect(
        service.listPermissions('role-inventado'),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
    });
  });
});
