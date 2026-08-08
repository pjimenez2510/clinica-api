import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { PatientsService } from './application/patients.service';
import { PATIENT_REPOSITORY } from './domain/patient.repository';
import { PrismaPatientRepository } from './infrastructure/prisma-patient.repository';
import { PatientsController } from './patients.controller';

/**
 * The patient register.
 *
 * Composition root for this module: the only place where the application's
 * ports meet concrete infrastructure. `PatientsService` never sees Prisma, and
 * that is what lets its rules — the duplicate check, the audit entry — be
 * tested with in-memory fakes rather than a container.
 *
 * `CurrentUserService` is PROVIDED here, not imported from `AuthModule`.
 * Importing another business module is exactly what `dependency-cruiser`
 * refuses, and it is right to: it is how a codebase stops having modules. The
 * service itself lives in `shared/authorisation` because every module needs to
 * know who is asking — reading `ClsService`, which is global, so providing it
 * twice costs nothing and couples nothing.
 */
@Module({
  controllers: [PatientsController],
  providers: [
    PatientsService,
    CurrentUserService,
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class PatientsModule {}
