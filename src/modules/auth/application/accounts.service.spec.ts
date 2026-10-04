import { beforeEach, describe, expect, it } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import { Principal } from '../../../shared/authorisation/principal';
import { SiteScopeDeniedError } from '../../../shared/authorisation/site-scope';
import { RevocationReason } from '../../../shared/request/client-context';
import {
  CannotDemoteSelfError,
  CannotGrantToSelfError,
  RoleNotFoundError,
  UserNotFoundError,
} from '../domain/auth.errors';
import { UNUSABLE_PASSWORD_HASH } from '../domain/password-hashing';

import { AccountsService } from './accounts.service';
import type {
  CredentialInvitationsService,
  IssuedInvitation,
} from './credential-invitations.service';
import type {
  AccountAdminRepositoryPort,
  AccountListItem,
  AccountListFilter,
  AccountPatch,
  AccountView,
  CreateAccountInput,
  GrantInput,
  GrantView,
  RoleAdminRepositoryPort,
  RoleView,
} from './admin-ports';
import { AuthAdminAuditTrail } from './auth-admin-audit.trail';
import type { RefreshTokenPort } from './ports';

/**
 * The rules that are the SERVICE's to enforce, against doubles of its ports.
 *
 * The one that matters most is AU-024, the requirement whose failure locks
 * everybody out of the system permanently. Two of its three shapes are here —
 * deactivating yourself, and dropping your own administration by editing your
 * own grants; the third, about the last role that carries `user:manage`, is
 * `RolesService`'s. All three are also exercised end to end in
 * `test/integration/auth-admin-http.spec.ts`, where the database's own
 * statement-level trigger is the last line of defence.
 */

const ADMIN_ID = 'user-admin';
const REQUESTER = { userId: ADMIN_ID, ip: '10.0.0.1' };

/**
 * AU-038. The clinic-wide grant — `siteId: null` is every site, present and
 * future — which is how the director is hired and what every case below that
 * is not about the site scope uses.
 */
const DIRECTOR = new Principal(ADMIN_ID, [
  { roleCode: 'ADMIN', siteId: null, permissions: ['user:manage'] },
]);

/** AU-038. `user:manage`, granted for `site-1` and for nowhere else. */
const SCOPED_TO_SITE_1 = new Principal('user-scoped', [
  { roleCode: 'ADMIN', siteId: 'site-1', permissions: ['user:manage'] },
]);

const ACCOUNT: AccountView = {
  id: 'user-1',
  email: 'nueva@clinica.ec',
  firstName: 'Ana',
  lastName: 'Villacís',
  cedula: null,
  active: true,
  mfaEnabled: false,
  credentialPending: true,
};

const ADMIN_ROLE: RoleView = {
  id: 'role-admin',
  code: 'ADMIN',
  name: 'Administrador del sistema',
  description: null,
  isSystem: true,
  active: true,
  liveGrants: 1,
};

const NURSE_ROLE: RoleView = {
  id: 'role-nurse',
  code: 'ENFERMERIA',
  name: 'Enfermería',
  description: null,
  isSystem: true,
  active: true,
  liveGrants: 0,
};

interface Call {
  method: string;
  args: unknown[];
}

class AccountsDouble implements AccountAdminRepositoryPort {
  readonly calls: Call[] = [];
  findAnswer: AccountView | null = ACCOUNT;
  setActiveAnswer: AccountView | null = { ...ACCOUNT, active: false };
  createdWith: CreateAccountInput | null = null;

  list(filter: AccountListFilter): Promise<readonly AccountListItem[]> {
    this.calls.push({ method: 'list', args: [filter] });
    return Promise.resolve([{ ...ACCOUNT, grants: [] }]);
  }

  findById(id: string): Promise<AccountView | null> {
    this.calls.push({ method: 'findById', args: [id] });
    return Promise.resolve(this.findAnswer);
  }

  create(input: CreateAccountInput): Promise<AccountView> {
    this.calls.push({ method: 'create', args: [input] });
    this.createdWith = input;
    return Promise.resolve({ ...ACCOUNT, email: input.email });
  }

  update(id: string, patch: AccountPatch): Promise<AccountView | null> {
    this.calls.push({ method: 'update', args: [id, patch] });
    return Promise.resolve(this.findAnswer);
  }

  setActive(id: string, active: boolean): Promise<AccountView | null> {
    this.calls.push({ method: 'setActive', args: [id, active] });
    return Promise.resolve(this.setActiveAnswer);
  }

  /**
   * AU-035 is `MfaResetService`'s, not this one's. It throws rather than
   * returning something plausible: if `AccountsService` ever starts calling
   * it, that has to be a decision somebody made, not a test that stayed green.
   */
  resetMfa(): Promise<AccountView | null> {
    throw new Error('not used');
  }

  grants: GrantView[] = [];

  listGrants(userId: string): Promise<readonly GrantView[]> {
    this.calls.push({ method: 'listGrants', args: [userId] });
    return Promise.resolve(this.grants);
  }

  replaceGrants(
    userId: string,
    desired: readonly GrantInput[],
    grantedById: string,
  ): Promise<readonly GrantView[]> {
    this.calls.push({ method: 'replaceGrants', args: [userId, desired, grantedById] }); // prettier-ignore
    return Promise.resolve(
      desired.map((grant) => ({
        roleId: grant.roleId,
        roleCode: 'ROLE',
        roleName: 'Rol',
        siteId: grant.siteId,
      })),
    );
  }
}

class RolesDouble implements RoleAdminRepositoryPort {
  administering: RoleView[] = [ADMIN_ROLE];
  knownRoles: RoleView[] = [ADMIN_ROLE, NURSE_ROLE];

  list(): Promise<readonly RoleView[]> {
    return Promise.resolve(this.knownRoles);
  }
  findById(id: string): Promise<RoleView | null> {
    return Promise.resolve(
      this.knownRoles.find((role) => role.id === id) ?? null,
    );
  }
  create(): Promise<RoleView> {
    return Promise.resolve(ADMIN_ROLE);
  }
  update(): Promise<RoleView | null> {
    return Promise.resolve(ADMIN_ROLE);
  }
  delete(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listPermissions(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  /** Nada de esta suite reparte permisos; el espejo está siempre publicado. */
  installedPermissions(codes: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(codes);
  }
  replacePermissions(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  rolesGranting(): Promise<readonly RoleView[]> {
    return Promise.resolve(this.administering);
  }
  liveRoleIdsOf(): Promise<readonly string[]> {
    return Promise.resolve([ADMIN_ROLE.id]);
  }
}

/**
 * The invitation half, as a collaborator.
 *
 * A DOUBLE AND NOT THE REAL SERVICE: what these tests are about is whether
 * creating an account ASKS for an invitation and survives a refusal. How the
 * invitation is built, hashed and mailed is `credential-invitations.service.spec.ts`'s
 * subject, and dragging it in here would make a test about hiring somebody
 * fail because of a change to an e-mail body.
 */
const INVITATION_EXPIRY = new Date('2026-08-16T12:00:00.000Z');

class InvitationsDouble {
  readonly issuedFor: string[] = [];
  sent = true;

  issue(userId: string): Promise<IssuedInvitation> {
    this.issuedFor.push(userId);
    return Promise.resolve({ sent: this.sent, expiresAt: INVITATION_EXPIRY });
  }
}

class RefreshTokensDouble implements RefreshTokenPort {
  readonly revoked: { userId: string; reason: string }[] = [];

  issueForNewSession(): Promise<never> {
    throw new Error('not used');
  }
  rotate(): Promise<never> {
    throw new Error('not used');
  }
  revokeFamily(): Promise<void> {
    throw new Error('not used');
  }
  revokeAllForUser(userId: string, reason: string): Promise<void> {
    this.revoked.push({ userId, reason });
    return Promise.resolve();
  }
}

describe('la administración de cuentas', () => {
  let accounts: AccountsDouble;
  let roles: RolesDouble;
  let refreshTokens: RefreshTokensDouble;
  let invitations: InvitationsDouble;
  let recorded: AccessAuditEntry[];
  let invalidations: number;
  let service: AccountsService;

  beforeEach(() => {
    accounts = new AccountsDouble();
    roles = new RolesDouble();
    refreshTokens = new RefreshTokensDouble();
    invitations = new InvitationsDouble();
    recorded = [];
    invalidations = 0;
    service = new AccountsService(
      accounts,
      roles,
      refreshTokens,
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
      invitations as unknown as CredentialInvitationsService,
    );
  });

  describe('alta de una cuenta', () => {
    it('AU-020 normaliza el correo a minúsculas para que entrar no dependa de cómo se tecleó', async () => {
      await service.create(
        {
          email: '  Nueva@Clinica.EC ',
          firstName: 'Ana',
          lastName: 'Villacís',
        },
        REQUESTER,
      );

      expect(accounts.createdWith?.email).toBe('nueva@clinica.ec');
    });

    it('AU-021 crea la cuenta SIN credencial utilizable: no puede iniciar sesión', async () => {
      // Lo que AU-021 prohíbe: el administrador NO elige la contraseña de
      // nadie. La cuenta nace con un centinela que ningún Argon2 puede
      // producir, y lo que la vuelve utilizable es la invitación (AU-021).
      await service.create(
        { email: 'nueva@clinica.ec', firstName: 'Ana', lastName: 'Villacís' },
        REQUESTER,
      );

      expect(accounts.createdWith?.passwordHash).toBe(UNUSABLE_PASSWORD_HASH);
      // No es un hash de Argon2, así que `argon2.verify` no puede aceptarlo
      // jamás: el verificador devuelve false y la cuenta responde como
      // cualquier contraseña equivocada.
      expect(accounts.createdWith?.passwordHash.startsWith('$argon2')).toBe(false); // prettier-ignore
    });

    it('AU-021 emite y envía por correo la invitación de la cuenta recién creada', async () => {
      const created = await service.create(
        { email: 'nueva@clinica.ec', firstName: 'Ana', lastName: 'Villacís' },
        REQUESTER,
      );

      expect(invitations.issuedFor).toEqual([created.account.id]);
      expect(created.invitation).toEqual({
        sent: true,
        expiresAt: INVITATION_EXPIRY,
      });
    });

    it('AU-029 conserva la cuenta cuando el correo no sale, y lo dice', async () => {
      // La alternativa —deshacer el alta— convertiría una caída del servidor
      // de correo en «no se puede dar de alta a nadie». La cuenta existe,
      // admite roles, y la invitación se puede reenviar desde la pantalla.
      invitations.sent = false;

      const created = await service.create(
        { email: 'nueva@clinica.ec', firstName: 'Ana', lastName: 'Villacís' },
        REQUESTER,
      );

      expect(created.account.id).toBe(ACCOUNT.id);
      expect(created.invitation.sent).toBe(false);
      // La creación sí ocurrió: el repositorio recibió la fila.
      expect(accounts.createdWith).not.toBeNull();
    });

    it('AU-025 deja en la bitácora quién creó la cuenta, y nunca la credencial', async () => {
      const created = await service.create(
        { email: 'nueva@clinica.ec', firstName: 'Ana', lastName: 'Villacís' },
        REQUESTER,
      );

      expect(recorded).toEqual([
        {
          userId: ADMIN_ID,
          resourceType: 'auth',
          resourceId: created.account.id,
          action: 'CREATE',
          ip: '10.0.0.1',
          userAgent: undefined,
        },
      ]);
      // La entrada de bitácora no tiene dónde poner un hash, que es cómo se
      // cumple «NO DEBERÁ registrar nunca la contraseña» (AU-025).
      expect(JSON.stringify(recorded)).not.toContain(UNUSABLE_PASSWORD_HASH);
    });

    it('AU-020 guarda la cédula vacía como ausente, no como cadena vacía', async () => {
      // La mayoría de las cuentas no tienen: recepción y caja no son
      // profesionales, y el índice único de cédula convertiría dos cadenas
      // vacías en un duplicado.
      await service.create(
        {
          email: 'caja@clinica.ec',
          firstName: 'Luis',
          lastName: 'Mora',
          cedula: '   ',
        },
        REQUESTER,
      );

      expect(accounts.createdWith?.cedula).toBeNull();
    });
  });

  describe('baja y alta de una cuenta', () => {
    it('AU-022 no ofrece borrar una cuenta en ninguna forma', () => {
      // La evidencia de la bitácora quedaría huérfana (REQ-110). La ausencia
      // del método ES el cumplimiento: no hay nada que recordar no llamar.
      expect(
        (service as unknown as Record<string, unknown>).delete,
      ).toBeUndefined();
    });

    it('AU-023 invalida las sesiones abiertas al desactivar', async () => {
      // Sin esto, «desactivar» no significa nada: la cuenta sigue refrescando
      // su sesión indefinidamente hasta que la persona cierre por su cuenta.
      await service.deactivate('user-1', REQUESTER);

      expect(refreshTokens.revoked).toEqual([
        { userId: 'user-1', reason: RevocationReason.ACCOUNT_DEACTIVATED },
      ]);
    });

    it('AU-023 distingue en la bitácora la desactivación del cierre de sesión', async () => {
      // «Se cerró la sesión» es el empleado yéndose a casa; «se desactivó la
      // cuenta» es un acceso retirado, que es lo que pregunta la SPDP.
      await service.deactivate('user-1', REQUESTER);

      expect(refreshTokens.revoked[0]?.reason).not.toBe(
        RevocationReason.SIGN_OUT,
      );
    });

    it('AU-024 impide que un administrador se desactive a sí mismo', async () => {
      // La primera de las tres formas de dejar la instalación sin nadie que la
      // administre. Quien lo hace queda fuera en la petición siguiente y no
      // queda ninguna sesión capaz de deshacerlo.
      await expect(
        service.deactivate(ADMIN_ID, REQUESTER),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 lo impide ANTES de tocar nada', async () => {
      await expect(
        service.deactivate(ADMIN_ID, REQUESTER),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);

      expect(accounts.calls).toEqual([]);
      expect(refreshTokens.revoked).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('AU-022 responde USER_NOT_FOUND al desactivar una cuenta que no existe', async () => {
      accounts.setActiveAnswer = null;

      await expect(
        service.deactivate('user-9', REQUESTER),
      ).rejects.toBeInstanceOf(UserNotFoundError);
      expect(refreshTokens.revoked).toEqual([]);
    });

    it('AU-022 reactiva una cuenta sin devolverle ninguna sesión', async () => {
      accounts.setActiveAnswer = { ...ACCOUNT, active: true };

      await service.activate('user-1', REQUESTER);

      expect(accounts.calls).toContainEqual({
        method: 'setActive',
        args: ['user-1', true],
      });
      expect(refreshTokens.revoked).toEqual([]);
    });
  });

  describe('los roles de una cuenta', () => {
    it('AU-032 fija el conjunto completo, con la sede de cada concesión', async () => {
      const grants = await service.replaceGrants(
        'user-1',
        [
          { roleId: NURSE_ROLE.id, siteId: 'site-1' },
          { roleId: ADMIN_ROLE.id, siteId: null },
        ],
        REQUESTER,
        DIRECTOR,
      );

      expect(grants.map((grant) => grant.siteId)).toEqual(['site-1', null]);
    });

    it('AU-032 invalida la caché para que el cambio rija en la petición siguiente', async () => {
      // AU-012: los permisos se resuelven por petición con caché corta. Sin
      // esta llamada, el cambio espera al TTL y quien lo hizo concluye que no
      // funcionó y lo vuelve a hacer.
      await service.replaceGrants(
        'user-1',
        [{ roleId: NURSE_ROLE.id, siteId: null }],
        REQUESTER,
        DIRECTOR,
      );

      expect(invalidations).toBe(1);
    });

    it('AU-032 rechaza un rol inexistente sin escribir ninguna concesión', async () => {
      await expect(
        service.replaceGrants(
          'user-1',
          [
            { roleId: NURSE_ROLE.id, siteId: null },
            { roleId: 'role-inventado', siteId: null },
          ],
          REQUESTER,
          DIRECTOR,
        ),
      ).rejects.toBeInstanceOf(RoleNotFoundError);

      expect(
        accounts.calls.some((call) => call.method === 'replaceGrants'),
      ).toBe(false);
    });

    it('AU-024 impide que un administrador se quite a sí mismo la administración', async () => {
      // La segunda forma. Editando sus propias concesiones y dejándose sólo un
      // rol clínico, quedaría sin poder volver a entrar a la pantalla que
      // acaba de usar.
      await expect(
        service.replaceGrants(
          ADMIN_ID,
          [{ roleId: NURSE_ROLE.id, siteId: null }],
          REQUESTER,
          DIRECTOR,
        ),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 impide también quedarse sin ningún rol', async () => {
      await expect(
        service.replaceGrants(ADMIN_ID, [], REQUESTER, DIRECTOR),
      ).rejects.toBeInstanceOf(CannotDemoteSelfError);
    });

    it('AU-024 deja al administrador retirarse un rol de más mientras conserve la administración', async () => {
      // No es una prohibición de editarse a uno mismo: es una prohibición de
      // quedarse sin administración. Un administrador que además es médico
      // puede soltar la mitad clínica.
      accounts.grants = [
        { roleId: ADMIN_ROLE.id, roleCode: 'ADMIN', roleName: 'A', siteId: null }, // prettier-ignore
        { roleId: NURSE_ROLE.id, roleCode: 'ENFERMERIA', roleName: 'E', siteId: null }, // prettier-ignore
      ];

      await expect(
        service.replaceGrants(
          ADMIN_ID,
          [{ roleId: ADMIN_ROLE.id, siteId: null }],
          REQUESTER,
          DIRECTOR,
        ),
      ).resolves.toHaveLength(1);
    });

    it('AU-032 no deja que nadie se conceda a sí mismo un rol nuevo', async () => {
      // `user_role_grant_no_self_grant` está en la base desde la migración de
      // roles: la pregunta de auditoría «quién dio a esta persona acceso a las
      // historias» no puede responderse «ella misma». Alcanzarla produciría un
      // `CHECK_FAILED` que no le dice nada a una clínica.
      accounts.grants = [
        { roleId: ADMIN_ROLE.id, roleCode: 'ADMIN', roleName: 'A', siteId: null }, // prettier-ignore
      ];

      await expect(
        service.replaceGrants(
          ADMIN_ID,
          [
            { roleId: ADMIN_ROLE.id, siteId: null },
            { roleId: NURSE_ROLE.id, siteId: null },
          ],
          REQUESTER,
          DIRECTOR,
        ),
      ).rejects.toBeInstanceOf(CannotGrantToSelfError);
    });

    it('AU-032 tampoco deja ampliar a todas las sedes un rol propio que estaba acotado', async () => {
      // «Todas las sedes» no es la misma concesión con más radio: es una
      // concesión distinta, y concedérsela uno mismo es exactamente lo que la
      // separación de funciones impide.
      accounts.grants = [
        { roleId: ADMIN_ROLE.id, roleCode: 'ADMIN', roleName: 'A', siteId: 'site-1' }, // prettier-ignore
      ];

      await expect(
        service.replaceGrants(
          ADMIN_ID,
          [{ roleId: ADMIN_ROLE.id, siteId: null }],
          REQUESTER,
          DIRECTOR,
        ),
      ).rejects.toBeInstanceOf(CannotGrantToSelfError);
    });

    it('AU-024 no estorba cuando se editan las concesiones de OTRA persona', async () => {
      await expect(
        service.replaceGrants('user-1', [], REQUESTER, DIRECTOR),
      ).resolves.toEqual([]);
    });

    it('AU-025 deja en la bitácora el cambio de roles, sobre la cuenta afectada', async () => {
      await service.replaceGrants(
        'user-1',
        [{ roleId: NURSE_ROLE.id, siteId: null }],
        REQUESTER,
        DIRECTOR,
      );

      expect(recorded).toEqual([
        {
          userId: ADMIN_ID,
          resourceType: 'auth',
          resourceId: 'user-1',
          action: 'UPDATE',
          ip: '10.0.0.1',
          userAgent: undefined,
        },
      ]);
    });
  });

  describe('lectura', () => {
    it('AU-022 no escribe en la bitácora al listar las cuentas', async () => {
      // Registrar cada listado entierra los accesos que importan (REQ-111).
      await service.list({ includeInactive: true });

      expect(recorded).toEqual([]);
    });

    it('AU-020 responde USER_NOT_FOUND para una cuenta que no existe', async () => {
      accounts.findAnswer = null;

      await expect(service.get('user-9')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });
  });

  /**
   * AU-038, D-023. `grants[].siteId` travels in the body, where the guard
   * cannot look, and the route declared `global` — so a `user:manage` confined
   * to one site could hand a SECOND account a grant good everywhere. That is
   * not a missing site check on an agenda, it is privilege escalation.
   */
  describe('AU-038 · el alcance por sede de las concesiones', () => {
    it('AU-038 rechaza conceder un rol GLOBAL desde un alcance de una sede', () => {
      // `siteId: null` is every site, present and future: handing it out hands
      // out the authority the site scope exists to limit.
      return expect(
        service.replaceGrants(
          'user-1',
          [{ roleId: NURSE_ROLE.id, siteId: null }],
          REQUESTER,
          SCOPED_TO_SITE_1,
        ),
      ).rejects.toBeInstanceOf(SiteScopeDeniedError);
    });

    it('AU-038 rechaza conceder un rol en otra sede, sin escribir nada', async () => {
      await expect(
        service.replaceGrants(
          'user-1',
          [{ roleId: NURSE_ROLE.id, siteId: 'site-2' }],
          REQUESTER,
          SCOPED_TO_SITE_1,
        ),
      ).rejects.toBeInstanceOf(SiteScopeDeniedError);

      expect(
        accounts.calls.some((call) => call.method === 'replaceGrants'),
      ).toBe(false);
    });

    it('AU-038 rechaza REVOCAR en silencio la concesión de otra sede', async () => {
      // The account already holds a grant at `site-2`; the caller sends only
      // its own site, which as a replacement would drop the other one.
      accounts.grants = [
        { roleId: NURSE_ROLE.id, roleCode: 'ENFERMERIA', roleName: 'E', siteId: 'site-2' }, // prettier-ignore
      ];

      await expect(
        service.replaceGrants(
          'user-1',
          [{ roleId: NURSE_ROLE.id, siteId: 'site-1' }],
          REQUESTER,
          SCOPED_TO_SITE_1,
        ),
      ).rejects.toBeInstanceOf(SiteScopeDeniedError);

      expect(
        accounts.calls.some((call) => call.method === 'replaceGrants'),
      ).toBe(false);
    });

    it('AU-038 dentro de su sede concede: la comprobación no es un muro', async () => {
      await service.replaceGrants(
        'user-1',
        [{ roleId: NURSE_ROLE.id, siteId: 'site-1' }],
        REQUESTER,
        SCOPED_TO_SITE_1,
      );

      expect(
        accounts.calls.some((call) => call.method === 'replaceGrants'),
      ).toBe(true);
    });
  });
});
