import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthService } from './application/auth.service';
import { PermissionsGuard } from './infrastructure/permissions.guard';
import {
  AUTH_USER_REPOSITORY,
  PASSWORD_HASHER,
  REFRESH_TOKENS,
  TOKEN_ISSUER,
  TOTP,
} from './application/ports';
import { AuthController } from './auth.controller';
import {
  CurrentUserService,
  JwtAuthGuard,
} from './infrastructure/jwt-auth.guard';
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
  controllers: [AuthController],
  providers: [
    AuthService,
    CurrentUserService,

    // Concrete implementations.
    PasswordHasher,
    TokenService,
    RefreshTokenService,
    TotpService,
    PrismaAuthUserRepository,

    // Port -> adapter bindings. `useExisting` reuses the same singleton
    // instead of creating a second one behind the token.
    { provide: PASSWORD_HASHER, useExisting: PasswordHasher },
    { provide: TOKEN_ISSUER, useExisting: TokenService },
    { provide: REFRESH_TOKENS, useExisting: RefreshTokenService },
    { provide: TOTP, useExisting: TotpService },
    { provide: AUTH_USER_REPOSITORY, useExisting: PrismaAuthUserRepository },

    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // ORDER MATTERS: NestJS runs APP_GUARD providers in registration order,
    // and this one reads the claims JwtAuthGuard puts in the context.
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [TokenService, CurrentUserService, PasswordHasher],
})
export class AuthModule {}
