import './infrastructure/specialties.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { SpecialtiesService } from './application/specialties.service';
import { SpecialtiesController } from './specialties.controller';
import { SPECIALTIES_REPOSITORY } from './domain/specialties.repository';
import { PrismaSpecialtiesRepository } from './infrastructure/prisma-specialties.repository';

/**
 * The clinic's parametrisation (C1: specialties and durations).
 *
 * Composition root for this module: the only place where the application's
 * ports meet concrete infrastructure. `SpecialtiesService` never sees
 * Prisma, which is what lets SP-004 and SP-005 be exercised with in-memory
 * doubles while the guarantees that live in the base — the functional unique
 * indexes, the CHECK, the partial index — are exercised against a real
 * PostgreSQL in the integration suite.
 *
 * THE AUDIT RECORDER IS WIRED IN, unlike in the agenda: SP-002 and SP-027
 * demand every mutation of the parametrisation in the trail. It is mutations
 * only — a specialty listing is not clinical content, so reads leave no
 * row and the trail stays legible.
 *
 * `CurrentUserService` is PROVIDED here, not imported from `AuthModule`: no
 * module imports another; see patients.module.ts.
 */
@Module({
  controllers: [SpecialtiesController],
  providers: [
    SpecialtiesService,
    CurrentUserService,
    { provide: SPECIALTIES_REPOSITORY, useClass: PrismaSpecialtiesRepository }, // prettier-ignore
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class SpecialtiesModule {}
