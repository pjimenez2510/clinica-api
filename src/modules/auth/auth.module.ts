import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import {
  CurrentUserService,
  JwtAuthGuard,
} from './infrastructure/jwt-auth.guard';
import { PasswordHasher } from './infrastructure/password-hasher.service';
import { RefreshTokenService } from './infrastructure/refresh-token.service';
import { TokenService } from './infrastructure/token.service';
import { TotpService } from './infrastructure/totp.service';

/**
 * Authentication.
 *
 * The guard is registered globally: routes are protected by default and being
 * public requires an explicit `@Public()`. The opposite default — open unless
 * someone remembers to protect it — is how endpoints end up exposed, and in a
 * clinical system that means medical records.
 */
@Module({
  providers: [
    PasswordHasher,
    TokenService,
    RefreshTokenService,
    TotpService,
    CurrentUserService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [
    PasswordHasher,
    TokenService,
    RefreshTokenService,
    TotpService,
    CurrentUserService,
  ],
})
export class AuthModule {}
