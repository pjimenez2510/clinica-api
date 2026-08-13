import './infrastructure/organization.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { OrganizationService } from './application/organization.service';
import { SiteResourcesService } from './application/site-resources.service';
import { ORGANIZATION_REPOSITORY } from './domain/organization.repository';
import { SITE_RESOURCES_REPOSITORY } from './domain/site-resources.repository';
import { PrismaOrganizationRepository } from './infrastructure/prisma-organization.repository';
import { PrismaSiteResourcesRepository } from './infrastructure/prisma-site-resources.repository';
import { OrganizationController } from './organization.controller';
import { SiteResourcesController } from './site-resources.controller';

/**
 * Where the clinic attends: the establishment, its sites, its consulting rooms
 * and the SRI data billing will need (ADR-011).
 *
 * Composition root for this module: the only place where the application's
 * ports meet concrete infrastructure. Neither service ever sees Prisma, which
 * is what lets OR-008 and the "site must exist" rules be exercised with
 * in-memory doubles while the guarantees that live in the base — the unique
 * indexes of OR-002, OR-020 and OR-024, the RESTRICT of OR-006, and above all
 * the COMPOSITE foreign key of OR-021 — are exercised against a real
 * PostgreSQL in the integration suite.
 *
 * THE AUDIT RECORDER IS WIRED IN: OR-005 and OR-026 demand every mutation of
 * the clinic's map in the trail. Mutations only — a site listing is not
 * clinical content, so reads leave no row and the trail stays legible.
 *
 * `CurrentUserService` is PROVIDED here, not imported from `AuthModule`: no
 * module imports another; see patients.module.ts.
 */
@Module({
  controllers: [OrganizationController, SiteResourcesController],
  providers: [
    OrganizationService,
    SiteResourcesService,
    CurrentUserService,
    { provide: ORGANIZATION_REPOSITORY, useClass: PrismaOrganizationRepository }, // prettier-ignore
    { provide: SITE_RESOURCES_REPOSITORY, useClass: PrismaSiteResourcesRepository }, // prettier-ignore
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class OrganizationModule {}
