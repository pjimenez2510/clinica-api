import './infrastructure/billing.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { BillingCatalogueController } from './billing-catalogue.controller';
import { BillingController } from './billing.controller';
import { EncounterCheckoutService } from './application/encounter-checkout.service';
import { InvoicingService } from './application/invoicing.service';
import { PatientAccountService } from './application/patient-account.service';
import { PricingService } from './application/pricing.service';
import { ServiceCatalogueService } from './application/service-catalogue.service';
import {
  BILLING_ACCOUNT_REPOSITORY,
  BILLING_CATALOGUE_REPOSITORY,
} from './domain/billing.repository';
import { CLINICAL_ACTS_REPOSITORY } from './domain/clinical-acts.port';
import { PrismaBillingAccountRepository } from './infrastructure/prisma-billing-account.repository';
import { PrismaClinicalActsRepository } from './infrastructure/prisma-clinical-acts.repository';
import { PrismaBillingCatalogueRepository } from './infrastructure/prisma-billing-catalogue.repository';

/**
 * Money.
 *
 * Composition root for this module: the only place where the ports meet
 * concrete infrastructure. No service here ever sees Prisma, which is what
 * lets the freezing rules and the receiver rules be exercised in milliseconds
 * with in-memory doubles while the guarantees that matter — the non-overlap of
 * validities, the sequential without gaps and the two immutability triggers —
 * are exercised against a real PostgreSQL.
 *
 * FIVE SERVICES AND NOT ONE, by ADR-008 §2: the catalogue of what the clinic
 * does, the tariff of what it charges, what a visit owes and the document that
 * settles it change for four different reasons and share no method. One
 * service holding all of them would cross the «~8 public use cases» line twice
 * over.
 *
 * The fifth is `EncounterCheckoutService`, and it is not a fifth aggregate:
 * it is the STEP from the clinical act to the charge, which changes when the
 * clinic changes what it derives — a different reason from «what a visit
 * owes». It is also the only place in this module that reads the clinical
 * side, so keeping it apart is what makes «billing writes nothing clinical»
 * (BI-004) readable in one file rather than argued across four.
 *
 * `CurrentUserService` and `PrismaAccessAuditRecorder` are PROVIDED here
 * rather than imported from another module: no module imports another, both
 * live in `shared`, and providing them twice costs nothing.
 *
 * THERE IS AN AUDIT RECORDER, and in `agenda` there deliberately is not. The
 * difference is BI-046 and BI-132: a price change, a payer change and an
 * invoice issuance are acts that move money and have to be answerable —
 * «¿quién subió esa tarifa?», «¿quién eligió Consumidor Final?». What is NOT
 * recorded is a row per listed account (BI-133): burying the accesses that
 * matter under the day's cashier listing is the most effective way to make the
 * trail useless.
 */
@Module({
  controllers: [BillingCatalogueController, BillingController],
  providers: [
    ServiceCatalogueService,
    PricingService,
    PatientAccountService,
    InvoicingService,
    EncounterCheckoutService,
    CurrentUserService,
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
    {
      provide: BILLING_CATALOGUE_REPOSITORY,
      useClass: PrismaBillingCatalogueRepository,
    },
    {
      provide: BILLING_ACCOUNT_REPOSITORY,
      useClass: PrismaBillingAccountRepository,
    },
    /**
     * WHAT THE VISIT DID, read by this module's OWN adapter (BI-151).
     *
     * Not an import of `modules/encounter` and not a client of its service: no
     * module imports another, and the port this satisfies has no write method,
     * so «what was done» can never be edited from the money side (BI-004).
     */
    {
      provide: CLINICAL_ACTS_REPOSITORY,
      useClass: PrismaClinicalActsRepository,
    },
  ],
})
export class BillingModule {}
