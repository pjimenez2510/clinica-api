import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { AccountsService } from './application/accounts.service';
import type { Requester } from './application/auth-admin-audit.trail';
import { CredentialInvitationsService } from './application/credential-invitations.service';
import { MfaResetService } from './application/mfa-reset.service';
import { RolesService } from './application/roles.service';
import {
  UserAccountDto,
  UserAccountListDto,
  CreateAccountDto,
  CreatedAccountDto,
  CreateRoleDto,
  GrantListDto,
  InvitationOutcomeDto,
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  ListAccountsQueryDto,
  ListRolesQueryDto,
  PermissionListDto,
  ReplaceGrantsDto,
  ReplacePermissionsDto,
  RoleDto,
  RoleListDto,
  RolePermissionsDto,
  UpdateAccountDto,
  UpdateRoleDto,
  type AccountListResponse,
  type AccountResponse,
  type CreatedAccountResponse,
  type GrantListResponse,
  type InvitationOutcomeResponse,
  type PermissionListResponse,
  type RoleListResponse,
  type RolePermissionsResponse,
  type RoleResponse,
} from './dto/auth-admin.dto';

/**
 * Administering accounts, roles and what each role carries (A2).
 *
 * A SECOND CONTROLLER under the same `auth` prefix, and deliberately not more
 * routes on `auth.controller.ts`. That one is the SESSION: login, the second
 * factor, refresh, logout, changing your own password — reachable by anybody
 * with credentials, some of it before authentication is even complete. This
 * one is administration, every route behind `user:manage` or `user:read`.
 * Mixing them would put `@Public()` and «administra a toda la clínica» in one
 * file, which is exactly where a marker gets copied onto the wrong handler.
 *
 * THE PERMISSIONS. `user:manage` already existed and already sat on the
 * administrator role; every mutation here reuses it rather than inventing a
 * second administration permission for the same screen. `user:read` is new and
 * splits READING the staff list, the roles and the permission catalogue from
 * CHANGING them — the list carries the name, the institutional email AND THE
 * CEDULA of every employee, so it is not something a clinical permission
 * should imply. That last item used to be missing from this sentence, from the
 * catalogue's description and from the screen that grants it, while
 * `accountSchema` carried it all along; the permission catalogue now says so
 * out loud, because roles are data and whoever ticks the box is entitled to
 * know what they are handing over.
 *
 * THE SITE SCOPE IS `global` ON EVERY ROUTE BUT ONE, and that is the truth
 * rather than a shrug. An account is not a resource OF a site: the same person
 * may be granted a role at two sites, and their name, email and cedula are the
 * same in both — scoping the account by site would mean either hiding half a
 * person or picking one of their sites arbitrarily. The site DIMENSION lives
 * inside the grants (AU-032), where it belongs.
 *
 * THE ONE EXCEPTION IS `PUT /users/:id/roles`, which declares `'query'`
 * (AU-038, D-023). That route is where the site dimension is WRITTEN, and it
 * arrives in the body where the guard cannot reach it — so `global` there did
 * not say «this route has no site dimension», it left the dimension that
 * defines every other route's scope editable by anyone holding `user:manage`
 * anywhere. The handler settles it with the caller's own resolved scope, and a
 * grant with `siteId: null` demands `user:manage` granted clinic-wide.
 * Reading the grants stays `global`: hiding half of somebody's roles would
 * make the screen save an incomplete set, which is the silent revocation
 * AU-038 exists to prevent.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthAdminController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly roles: RolesService,
    /**
     * INJECTED DIRECTLY and not reached through `AccountsService`. Re-sending
     * an invitation is not an account-administration use case — it delivers a
     * credential — and routing it through the other service would have pushed
     * it to nine public use cases, past the limit ADR-008 §2 sets, to gain a
     * one-line delegation.
     */
    private readonly invitations: CredentialInvitationsService,
    /**
     * A4. INJECTED DIRECTLY too, and for the same reason as the invitations:
     * `AccountsService` is at ADR-008 §2's eight-use-case limit, and reaching
     * this through it would buy a one-line delegation at the price of crossing
     * it. The two also change for different reasons — that one for how a
     * person is hired and let go, this one for how a lost second factor is
     * recovered (D-014).
     */
    private readonly mfaReset: MfaResetService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- Accounts ---------------------------------------------------------------

  /** AU-022: deactivated accounts travel only when explicitly asked for. */
  @Get('users')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Listar cuentas del personal' })
  @ApiOkResponse({ type: UserAccountListDto })
  async listUsers(
    @Query() query: ListAccountsQueryDto,
  ): Promise<AccountListResponse> {
    const items = await this.accounts.list({
      includeInactive: query.includeInactive,
      search: query.search,
    });
    return { items };
  }

  @Get('users/:id')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Datos de una cuenta' })
  @ApiOkResponse({ type: UserAccountDto })
  async getUser(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AccountResponse> {
    return this.accounts.get(id);
  }

  /**
   * AU-020, AU-021, AU-025, AU-029.
   *
   * ⚠️ THE ACCOUNT STILL CANNOT SIGN IN WHEN THIS RETURNS, and that is the
   * requirement rather than a gap. AU-021 forbids the administrator choosing
   * somebody else's password; D-013 settled how the first one reaches them
   * instead — a single-use link mailed to the institutional address, from
   * which the person sets their own. `credentialPending: true` says the
   * account is not usable yet, and it stops being true when they redeem it.
   *
   * `invitationSent: false` IS A NORMAL ANSWER TO A 201. The account exists
   * and the message did not leave — no mail server configured, or one that
   * refused — and the screen has to say exactly that and offer to send it
   * again. Failing the whole request instead would leave the administrator
   * convinced nothing happened, so they would create the account again and get
   * `EMAIL_ALREADY_REGISTERED`: a message about addresses for a problem about
   * mail servers.
   */
  @Post('users')
  @RequirePermission('user:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear una cuenta y enviarle su invitación de acceso',
  })
  @ApiCreatedResponse({ type: CreatedAccountDto })
  async createUser(
    @Body() dto: CreateAccountDto,
    @Req() req: Request,
  ): Promise<CreatedAccountResponse> {
    const { account, invitation } = await this.accounts.create(
      {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        cedula: dto.cedula,
      },
      this.requester(req),
    );

    return {
      ...account,
      invitationSent: invitation.sent,
      invitationExpiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * AU-021, AU-027, AU-029. Sends the invitation again.
   *
   * ⚠️ IT INVALIDATES THE PREVIOUS LINK (AU-027), and that is why it exists in
   * this shape rather than as «enviar otra vez el mismo correo». The three
   * situations that lead somebody here are the mail server having been down,
   * the address having been mistyped, and the link having expired — and in the
   * second one the old link is sitting in a stranger's mailbox. A re-send that
   * merely added a second valid link would leave it there.
   *
   * `user:manage` and not `user:read`: this puts a credential in motion.
   *
   * The administrator never sees the token. What they get back is whether the
   * message left and when the new link expires.
   */
  @Post('users/:id/invitation')
  @RequirePermission('user:manage', 'global')
  // 200 and not 201: the invitation is not addressable, and the previous one
  // was replaced rather than a second one created.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenviar la invitación de acceso, anulando el enlace anterior',
  })
  @ApiOkResponse({ type: InvitationOutcomeDto })
  async resendInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<InvitationOutcomeResponse> {
    const invitation = await this.invitations.issue(id, this.requester(req));

    return {
      invitationSent: invitation.sent,
      invitationExpiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /** AU-025. Neither the email nor any credential is patchable; see the DTO. */
  @Patch('users/:id')
  @RequirePermission('user:manage', 'global')
  @ApiOperation({ summary: 'Editar los datos de una cuenta' })
  @ApiOkResponse({ type: UserAccountDto })
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
    @Req() req: Request,
  ): Promise<AccountResponse> {
    return this.accounts.update(
      id,
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        cedula: dto.cedula,
      },
      this.requester(req),
    );
  }

  /**
   * AU-022, AU-023, AU-024.
   *
   * ITS OWN ENDPOINT and not a field on the PATCH, because deactivating has a
   * second half that must not be forgettable: the open sessions are revoked.
   * There is no DELETE for an account anywhere in this controller — AU-022
   * says accounts are deactivated, never deleted, and the absence of the route
   * is what enforces it.
   */
  @Post('users/:id/deactivate')
  @RequirePermission('user:manage', 'global')
  // 200 and not the POST default of 201: nothing was created. The verb is a
  // POST because deactivating is an ACTION on the account, not a patch of one
  // of its fields — see the DTO for why `active` is not editable there.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desactivar una cuenta y cerrar sus sesiones' })
  @ApiOkResponse({ type: UserAccountDto })
  async deactivateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AccountResponse> {
    return this.accounts.deactivate(id, this.requester(req));
  }

  /**
   * AU-035, AU-036. Retires the account's second factor so it can be enrolled
   * again.
   *
   * ⚠️ `user:reset-mfa`, AND NOT `user:manage`. It is the only route in this
   * controller that does not reuse the administration permission, and the
   * exception is the point (D-014): whoever retires a doctor's second factor
   * removes the last barrier between a password and their signature, and
   * whoever can also re-invite them can sign in their name. No shipped role
   * carries it — the installation grants it deliberately, like any permission
   * of this weight, and `authorisation-data.spec.ts` fails if a deploy ever
   * hands it out on its own.
   *
   * A POST and 200, like `deactivate`: this is an ACTION on the account with a
   * second half that must not be forgettable — the open sessions are revoked —
   * and nothing was created. It returns the account so the row on the screen
   * stops saying «con segundo factor» without a reload.
   *
   * NO BODY, and no password field anywhere near it. Whoever resets never
   * learns any credential; the person keeps their own password and enrols a
   * new factor themselves.
   */
  @Post('users/:id/reset-mfa')
  @RequirePermission('user:reset-mfa', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reiniciar el segundo factor de una cuenta y cerrar sus sesiones',
  })
  @ApiOkResponse({ type: UserAccountDto })
  async resetUserMfa(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AccountResponse> {
    return this.mfaReset.reset(id, this.requester(req));
  }

  /** AU-022. Restores access; it does not resurrect any session. */
  @Post('users/:id/activate')
  @RequirePermission('user:manage', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivar una cuenta' })
  @ApiOkResponse({ type: UserAccountDto })
  async activateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AccountResponse> {
    return this.accounts.activate(id, this.requester(req));
  }

  /** AU-032. Revoked grants do not travel: they are trail, not state. */
  @Get('users/:id/roles')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Roles concedidos a una cuenta' })
  @ApiOkResponse({ type: GrantListDto })
  async listUserRoles(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GrantListResponse> {
    const items = await this.accounts.listGrants(id);
    return { items };
  }

  /**
   * AU-032, AU-024.
   *
   * A PUT with the WHOLE set: the screen sends the checkbox state, and
   * expressing it as a set makes «lo que esta persona tiene» a single fact
   * rather than the outcome of a sequence somebody could interrupt halfway.
   */
  @Put('users/:id/roles')
  @RequirePermission('user:manage', 'query')
  @ApiOperation({ summary: 'Fijar los roles de una cuenta, con su sede' })
  @ApiOkResponse({ type: GrantListDto })
  async replaceUserRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceGrantsDto,
    @Req() req: Request,
  ): Promise<GrantListResponse> {
    const items = await this.accounts.replaceGrants(
      id,
      dto.grants.map((grant) => ({
        roleId: grant.roleId,
        siteId: grant.siteId ?? null,
      })),
      this.requester(req),
      // AU-038: the scope comes from the session the guard resolved, never
      // from the request — a body that could widen it would be no check.
      this.currentUser.requirePrincipal(),
    );
    return { items };
  }

  // --- Roles ------------------------------------------------------------------

  /** AU-031: deactivated roles travel only when explicitly asked for. */
  @Get('roles')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Roles de la clínica' })
  @ApiOkResponse({ type: RoleListDto })
  async listRoles(
    @Query() query: ListRolesQueryDto,
  ): Promise<RoleListResponse> {
    const items = await this.roles.list(query.includeInactive);
    return { items };
  }

  /**
   * AU-033. DECLARED BEFORE `roles/:id` ON PURPOSE: NestJS matches in
   * declaration order, and with the parameter route first this path would be
   * swallowed by it and rejected as a malformed UUID. Same trap as
   * `staff/practitioners/acess-expiring`.
   */
  @Get('permissions')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Catálogo de permisos, con recurso y descripción' })
  @ApiOkResponse({ type: PermissionListDto })
  listPermissions(): PermissionListResponse {
    return { items: [...this.roles.catalogue()] };
  }

  /** AU-030. */
  @Post('roles')
  @RequirePermission('user:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un rol propio de la clínica' })
  @ApiCreatedResponse({ type: RoleDto })
  async createRole(
    @Body() dto: CreateRoleDto,
    @Req() req: Request,
  ): Promise<RoleResponse> {
    return this.roles.create(
      { code: dto.code, name: dto.name, description: dto.description },
      this.requester(req),
    );
  }

  /** AU-030, AU-031 (deactivate), AU-024. */
  @Patch('roles/:id')
  @RequirePermission('user:manage', 'global')
  @ApiOperation({ summary: 'Editar o desactivar un rol' })
  @ApiOkResponse({ type: RoleDto })
  async updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: Request,
  ): Promise<RoleResponse> {
    return this.roles.update(
      id,
      { name: dto.name, description: dto.description, active: dto.active },
      this.requester(req),
    );
  }

  /**
   * AU-031. Refused with `SYSTEM_ROLE_PROTECTED` for a role the product ships,
   * with `ROLE_IN_USE` for one somebody still holds, and with
   * `CANNOT_DEMOTE_SELF` for the last one that administers users (AU-024).
   * All three offer deactivation in their sentence, which is the other half of
   * the requirement.
   */
  @Delete('roles/:id')
  @RequirePermission('user:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un rol propio sin concesiones vivas' })
  @ApiNoContentResponse()
  async deleteRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.roles.delete(id, this.requester(req));
  }

  /** AU-033. */
  @Get('roles/:id/permissions')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Permisos que lleva un rol' })
  @ApiOkResponse({ type: RolePermissionsDto })
  async listRolePermissions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RolePermissionsResponse> {
    const permissions = await this.roles.listPermissions(id);
    // No warnings on a read: they are about a change somebody is making, and
    // showing them for the current state would train people to ignore them.
    return { roleId: id, permissions: [...permissions], warnings: [] };
  }

  /**
   * AU-033, AU-034, AU-024.
   *
   * The warnings travel in the RESPONSE and the change is already saved when
   * they do — AU-034 says «advertirlo sin impedirlo», and refusing outright
   * pushes a small clinic to share one account, which is worse for the trail
   * than the combination being warned about.
   */
  @Put('roles/:id/permissions')
  @RequirePermission('user:manage', 'global')
  @ApiOperation({ summary: 'Fijar los permisos de un rol' })
  @ApiOkResponse({ type: RolePermissionsDto })
  async replaceRolePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplacePermissionsDto,
    @Req() req: Request,
  ): Promise<RolePermissionsResponse> {
    const result = await this.roles.replacePermissions(
      id,
      dto.permissions,
      this.requester(req),
    );

    return {
      roleId: id,
      permissions: [...result.permissions],
      warnings: [...result.warnings],
    };
  }

  /** Who is asking, for the trail (AU-025). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
