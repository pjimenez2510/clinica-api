import './infrastructure/auth.constraints';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import type { Env } from '../../shared/config/env.schema';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { NodemailerMailer } from '../../shared/infrastructure/mail/nodemailer.mailer';
import { MAILER } from '../../shared/mail/mail.port';
import { AccountsService } from './application/accounts.service';
import {
  CREDENTIAL_INVITATION_REPOSITORY,
  CREDENTIAL_TOKENS,
  WEB_BASE_URL,
} from './application/credential-ports';
import { CredentialInvitationsService } from './application/credential-invitations.service';
import { CredentialTokenService } from './infrastructure/credential-token.service';
import { PrismaCredentialInvitationRepository } from './infrastructure/prisma-credential-invitation.repository';
import {
  ACCOUNT_ADMIN_REPOSITORY,
  ROLE_ADMIN_REPOSITORY,
  ROLE_PERMISSION_CACHE,
} from './application/admin-ports';
import { AuthAdminAuditTrail } from './application/auth-admin-audit.trail';
import { AuthService } from './application/auth.service';
import { MfaEnrolmentService } from './application/mfa-enrolment.service';
import { RolesService } from './application/roles.service';
import { AuthAdminController } from './auth-admin.controller';
import { PrismaAccountAdminRepository } from './infrastructure/prisma-account-admin.repository';
import { PrismaRoleAdminRepository } from './infrastructure/prisma-role-admin.repository';
import { PermissionsGuard } from './infrastructure/permissions.guard';
import { RolePermissionRegistry } from './infrastructure/role-permission.registry';
import {
  AUTH_USER_REPOSITORY,
  PASSWORD_HASHER,
  REFRESH_TOKENS,
  TOKEN_ISSUER,
  TOTP,
} from './application/ports';
import { AuthController } from './auth.controller';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { JwtAuthGuard } from './infrastructure/jwt-auth.guard';
import { PasswordHasher } from './infrastructure/password-hasher.service';
import { PrismaAuthUserRepository } from './infrastructure/prisma-auth-user.repository';
import { RefreshTokenService } from './infrastructure/refresh-token.service';
import { TokenService } from './infrastructure/token.service';
import { TotpService } from './infrastructure/totp.service';

/**
 * Authentication.
 *
 * This module is the composition root: the ONLY place where the application
 * layer's ports are bound to concrete infrastructure. `AuthService` never sees
 * these classes, only the interfaces — which is what lets its flows be tested
 * with in-memory fakes instead of real Argon2 and a real database.
 *
 * The guard is registered globally, so routes are protected by default and
 * being public requires an explicit `@Public()`. The opposite default — open
 * unless somebody remembers to protect it — is how endpoints end up exposed,
 * and here that means medical records.
 */
@Module({
  /**
   * TWO CONTROLLERS, one prefix. `AuthController` is the SESSION half built in
   * phase 0 — some of it `@Public()`, some reachable before the second factor
   * is complete. `AuthAdminController` is A2's administration half, every
   * route behind `user:manage` or `user:read`. Keeping them apart is what
   * stops a `@Public()` from ever being copied onto a route that administers
   * the whole clinic.
   */
  controllers: [AuthController, AuthAdminController],
  providers: [
    AuthService,
    MfaEnrolmentService,
    // A2. Split per ADR-008 §2: together they are twelve public use cases, and
    // they change for different reasons — one for how a person is hired and
    // let go, the other for what the clinic's roles mean.
    AccountsService,
    RolesService,
    /**
     * AU-021 and AU-026..AU-029 (D-013). Split from `AccountsService` per
     * ADR-008 §2:
     * that one was already at the eight-use-case limit, and the two change for
     * different reasons — one for how a person is hired and let go, this one
     * for how a credential is delivered, which is a decision that has already
     * been reopened once.
     */
    CredentialInvitationsService,
    AuthAdminAuditTrail,
    CurrentUserService,

    // Concrete implementations.
    PasswordHasher,
    TokenService,
    RefreshTokenService,
    TotpService,
    CredentialTokenService,
    PrismaAuthUserRepository,
    PrismaAccountAdminRepository,
    PrismaRoleAdminRepository,
    PrismaCredentialInvitationRepository,

    // Port -> adapter bindings. `useExisting` reuses the same singleton
    // instead of creating a second one behind the token.
    { provide: PASSWORD_HASHER, useExisting: PasswordHasher },
    { provide: TOKEN_ISSUER, useExisting: TokenService },
    { provide: REFRESH_TOKENS, useExisting: RefreshTokenService },
    { provide: TOTP, useExisting: TotpService },
    { provide: AUTH_USER_REPOSITORY, useExisting: PrismaAuthUserRepository },
    { provide: ACCOUNT_ADMIN_REPOSITORY, useExisting: PrismaAccountAdminRepository }, // prettier-ignore
    { provide: ROLE_ADMIN_REPOSITORY, useExisting: PrismaRoleAdminRepository },
    /**
     * AU-012, AU-032: dropping the role→permission cache the moment a role
     * changes, so a revocation takes effect on the NEXT request instead of
     * within the TTL. Behind a port because the application layer may not
     * import infrastructure, and because what the use case depends on is «the
     * change is in force now», not «there is a Map with a 30-second TTL».
     */
    { provide: ROLE_PERMISSION_CACHE, useExisting: RolePermissionRegistry },
    /**
     * AU-025: every mutation of an account, a role or a grant in the trail.
     * Provided here rather than imported from anywhere: no module imports
     * another, and shared infrastructure is wired by whoever uses it.
     */
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },

    // --- First credential (AU-021, AU-026..AU-029, D-013) ------------------
    { provide: CREDENTIAL_TOKENS, useExisting: CredentialTokenService },
    { provide: CREDENTIAL_INVITATION_REPOSITORY, useExisting: PrismaCredentialInvitationRepository }, // prettier-ignore
    /**
     * HOW MAIL LEAVES THE BUILDING. Provided here, by whoever uses it, for the
     * same reason as the audit recorder: no module imports another, and shared
     * infrastructure is wired by its consumer.
     *
     * ⚠️ Its failure policy is the OPPOSITE of `ACCESS_AUDIT_RECORDER`'s: this
     * one throws at the caller instead of swallowing, because a credential
     * e-mail that fails silently leaves a person unable to enter with nobody
     * aware. See `mail.port.ts`.
     */
    { provide: MAILER, useClass: NodemailerMailer },
    /**
     * A VALUE and not a port: the use case needs one string, and an interface
     * with a single `get()` would be a pattern added for symmetry. Read from
     * the VALIDATED environment, so the application layer still does not know
     * that NestJS configuration exists.
     */
    {
      provide: WEB_BASE_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): string =>
        config.get('WEB_BASE_URL', { infer: true }),
    },

    RolePermissionRegistry,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // ORDER MATTERS: NestJS runs APP_GUARD providers in registration order,
    // and this one reads the claims JwtAuthGuard puts in the context.
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  /**
   * The SYMBOLS, not the adapter classes.
   *
   * Exporting `TokenService` and `PasswordHasher` meant any module consuming
   * them was coupled to the adapter — precisely what the ports were introduced
   * to avoid. A consumer injects by symbol and depends on the interface, so
   * swapping the implementation touches this module and nothing else.
   *
   * `CurrentUserService` stays a class: it is the request-scoped reader of the
   * CLS context, not an adapter behind a port, and there is nothing to swap.
   */
  exports: [TOKEN_ISSUER, PASSWORD_HASHER, CurrentUserService],
})
export class AuthModule {}
