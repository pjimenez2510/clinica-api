import './infrastructure/staff.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { PractitionerAssignmentsService } from './application/practitioner-assignments.service';
import { PractitionerService } from './application/practitioner.service';
import { ScheduleRulesService } from './application/schedule-rules.service';
import { StaffAuditTrail } from './application/staff-audit.trail';
import { SCHEDULE_RULE_REPOSITORY } from './domain/schedule-rule.repository';
import { STAFF_REPOSITORY } from './domain/staff.repository';
import { PrismaScheduleRuleRepository } from './infrastructure/prisma-schedule-rule.repository';
import { PrismaStaffRepository } from './infrastructure/prisma-staff.repository';
import { StaffScheduleController } from './staff-schedule.controller';
import { StaffController } from './staff.controller';

/**
 * The owner of `Practitioner` (ADR-011).
 *
 * Composition root for this module: the only place where the application's
 * ports meet concrete infrastructure. No service ever sees Prisma, which is
 * what lets ST-004, ST-006 and ST-008 be exercised with in-memory doubles
 * while the guarantees that live in the base — above all the EXCLUDE of
 * ST-042, but also the partial unique index of ST-008 and the RESTRICT of
 * ST-010 — are exercised against a real PostgreSQL in the integration suite.
 *
 * WHY THREE SERVICES AND NOT ONE. ADR-008 §2 splits a service when it crosses
 * eight public use cases, or when two groups of methods change for different
 * reasons. Both apply: the file answers to the habilitación, the assignments
 * to the clinic's map and catalogue, and the schedule to the exclusion
 * constraint. One class holding all three would be eighteen use cases.
 *
 * THE AUDIT RECORDER IS WIRED IN: ST-010 and ST-044 demand every mutation of
 * the staff file in the trail, with author, instant and what changed. It is
 * mutations only — listing practitioners is not clinical content, so reads
 * leave no row and the trail stays legible.
 *
 * `CurrentUserService` is PROVIDED here, not imported from `AuthModule`: no
 * module imports another; see patients.module.ts.
 */
@Module({
  controllers: [StaffController, StaffScheduleController],
  providers: [
    PractitionerService,
    PractitionerAssignmentsService,
    ScheduleRulesService,
    StaffAuditTrail,
    CurrentUserService,
    { provide: STAFF_REPOSITORY, useClass: PrismaStaffRepository },
    { provide: SCHEDULE_RULE_REPOSITORY, useClass: PrismaScheduleRuleRepository }, // prettier-ignore
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class StaffModule {}
