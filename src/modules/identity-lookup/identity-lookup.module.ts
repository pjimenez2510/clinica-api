import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { Env } from '../../shared/config/env.schema';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { IdentityLookupService } from './application/identity-lookup.service';
import {
  CEDULA_DIGESTER,
  IDENTITY_LOOKUP_CLOCK,
  IDENTITY_LOOKUP_STORE,
} from './domain/identity-lookup.store';
import {
  IDENTITY_LOOKUPS,
  type IdentityLookup,
} from './domain/identity-proposal';
import { DiditIdentityLookup } from './infrastructure/didit-identity.lookup';
import { HmacCedulaDigester } from './infrastructure/hmac-cedula.digester';
import { PrismaIdentityLookupStore } from './infrastructure/prisma-identity-lookup.store';
import { SriRucRegistryLookup } from './infrastructure/sri-ruc-registry.lookup';
import { IdentityLookupController } from './identity-lookup.controller';

/**
 * D-206 §2. Proposing names by cedula, inside the API and not as a service of
 * its own. Composition root: the only place where the port meets the
 * adapters, and where configuration decides WHICH adapters exist.
 *
 * THE ORDER OF THE SOURCES IS THE ORDER OF THE LIST (D-206 §1): the imported
 * registry, then the provider. The provider is in the list only with its URL
 * and its key (IL-008): without them the class is never built, so there is
 * nothing that could call it. Changing to DIGERCIC is another class here.
 *
 * `CurrentUserService` is PROVIDED here: no module imports another.
 */
@Module({
  controllers: [IdentityLookupController],
  providers: [
    IdentityLookupService,
    CurrentUserService,
    SriRucRegistryLookup,
    { provide: IDENTITY_LOOKUP_STORE, useClass: PrismaIdentityLookupStore },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
    { provide: IDENTITY_LOOKUP_CLOCK, useValue: () => new Date() },
    {
      provide: CEDULA_DIGESTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const key = config.get('IDENTITY_LOOKUP_DIGEST_KEY', { infer: true });
        return key ? new HmacCedulaDigester(key) : null;
      },
    },
    {
      provide: IDENTITY_LOOKUPS,
      inject: [ConfigService, SriRucRegistryLookup],
      useFactory: (
        config: ConfigService<Env, true>,
        registry: SriRucRegistryLookup,
      ): IdentityLookup[] => {
        const url = config.get('IDENTITY_PROVIDER_URL', { infer: true });
        const key = config.get('IDENTITY_PROVIDER_API_KEY', { infer: true });
        return url && key
          ? [registry, new DiditIdentityLookup(url, key)]
          : [registry];
      },
    },
  ],
})
export class IdentityLookupModule {}
