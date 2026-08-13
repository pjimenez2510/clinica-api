import './infrastructure/configuration.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { ConfigurationAuditTrail } from './application/configuration-audit.trail';
import { HolidaysService } from './application/holidays.service';
import { SiteParametersService } from './application/site-parameters.service';
import { HOLIDAY_REPOSITORY } from './domain/holiday.repository';
import { SITE_PARAMETER_REPOSITORY } from './domain/site-parameter.repository';
import { PrismaHolidayRepository } from './infrastructure/prisma-holiday.repository';
import { PrismaSiteParameterRepository } from './infrastructure/prisma-site-parameter.repository';
import { ConfigurationController } from './configuration.controller';

/**
 * Operating parameters: holidays and the numbers of D-001 (ADR-011).
 *
 * What is left in this module after ADR-011 is exactly what its name says: a
 * value that changes behaviour and that no row references. Specialties,
 * durations, schedules and sites moved to the modules that OWN them.
 *
 * Composition root for this module: the only place where the application's
 * ports meet concrete infrastructure. Neither service ever sees Prisma, which
 * is what lets CF-064 and CF-065 be exercised with in-memory doubles while the
 * guarantees that live in the base — the `UNIQUE NULLS NOT DISTINCT` of
 * CF-061, the range CHECKs of CF-065 and the trigger that writes the defaults
 * of CF-062 — are exercised against a real PostgreSQL in the integration suite.
 *
 * TWO SERVICES, and not by symmetry with the neighbouring modules. ADR-008 §2
 * splits when two groups of methods share no dependencies: holidays and
 * parameters share the audit trail and nothing else — different tables,
 * different repositories, different reasons to change. What holds them
 * together is a screen, and a screen is not a module.
 *
 * THE AUDIT RECORDER IS WIRED IN: CF-066 demands every mutation in the trail.
 * Mutations only — listing the year's holidays is not clinical content, so
 * reads leave no row and the trail stays legible (REQ-111).
 *
 * `CurrentUserService` is PROVIDED here, not imported from `AuthModule`: no
 * module imports another; see patients.module.ts.
 */
@Module({
  controllers: [ConfigurationController],
  providers: [
    HolidaysService,
    SiteParametersService,
    ConfigurationAuditTrail,
    CurrentUserService,
    { provide: HOLIDAY_REPOSITORY, useClass: PrismaHolidayRepository },
    { provide: SITE_PARAMETER_REPOSITORY, useClass: PrismaSiteParameterRepository }, // prettier-ignore
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class ConfigurationModule {}
