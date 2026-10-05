import './infrastructure/orders.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { DiagnosticReportController } from './diagnostic-report.controller';
import { DiagnosticReportService } from './application/diagnostic-report.service';
import { EncounterOrderController } from './encounter-order.controller';
import { ExamAdministrationController } from './exam-administration.controller';
import { ExamAdministrationService } from './application/exam-administration.service';
import { ExamCatalogueController } from './exam-catalogue.controller';
import { ExamCatalogueService } from './application/exam-catalogue.service';
import { ServiceOrderController } from './service-order.controller';
import { ServiceOrderService } from './application/service-order.service';
import { DIAGNOSTIC_REPORT_REPOSITORY } from './domain/diagnostic-report.repository';
import { EXAM_ADMINISTRATION_REPOSITORY } from './domain/exam-administration.repository';
import { EXAM_CATALOGUE_REPOSITORY } from './domain/exam-catalogue.repository';
import { SERVICE_ORDER_REPOSITORY } from './domain/service-order.repository';
import { PrismaDiagnosticReportRepository } from './infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamAdministrationRepository } from './infrastructure/prisma-exam-administration.repository';
import { PrismaExamCatalogueRepository } from './infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from './infrastructure/prisma-service-order.repository';

/**
 * Asking for an exam, and receiving its result.
 *
 * Composition root: the only place where this module's ports meet concrete
 * infrastructure. No service ever sees Prisma, which is what lets the flag
 * policy, the ageing of the worklist and the completeness rule be exercised
 * with the REAL seeded ranges and no database in the room, while the
 * guarantees that matter — the trigger that keeps `pending_items` in step, the
 * `UNIQUE` that stops a correction chain forking, the partial index the
 * worklist is built on — are exercised against a real PostgreSQL.
 *
 * ⚠️ THREE SERVICES AND THREE REPOSITORIES BECAUSE THERE ARE THREE THINGS
 * WITH DIFFERENT REASONS TO CHANGE (ADR-008 §2). The ORDER is what somebody
 * asked for; the REPORT has a lifecycle the order does not have — issued,
 * superseded, never edited — and answers questions about analytes, ranges and
 * flags; and the CATALOGUE is republished on its own calendar —read by ordering
 * every consultation, written by its administration (ORD-103 to ORD-111) a
 * few times a year, each with its own service. The day the
 * analyte catalogue changes, one of the three moves and the other two do not.
 *
 * ⚠️ IT WIRES AN ACCESS AUDIT RECORDER, like `EncounterModule` and unlike
 * `AgendaModule`. Reading a laboratory result IS the accountable act the LOPDP
 * asks us to be able to reconstruct (ORD-091); what is NOT audited is the two
 * worklists (ORD-092), and that decision lives in the service, beside the
 * reads it applies to.
 *
 * `CurrentUserService` is PROVIDED here rather than imported from `AuthModule`:
 * no module imports another, and the service itself lives in
 * `shared/authorisation` because every module needs to know who is asking.
 */
@Module({
  controllers: [
    EncounterOrderController,
    ServiceOrderController,
    DiagnosticReportController,
    ExamCatalogueController,
    ExamAdministrationController,
  ],
  providers: [
    ServiceOrderService,
    DiagnosticReportService,
    ExamCatalogueService,
    ExamAdministrationService,
    CurrentUserService,
    {
      provide: SERVICE_ORDER_REPOSITORY,
      useClass: PrismaServiceOrderRepository,
    },
    {
      provide: DIAGNOSTIC_REPORT_REPOSITORY,
      useClass: PrismaDiagnosticReportRepository,
    },
    {
      provide: EXAM_CATALOGUE_REPOSITORY,
      useClass: PrismaExamCatalogueRepository,
    },
    {
      provide: EXAM_ADMINISTRATION_REPOSITORY,
      useClass: PrismaExamAdministrationRepository,
    },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class OrdersModule {}
