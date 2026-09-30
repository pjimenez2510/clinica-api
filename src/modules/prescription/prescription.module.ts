import './infrastructure/prescription.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ACTIVE_ALLERGY_READER } from '../../shared/clinical/patient-allergy.port';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { PrismaActiveAllergyReader } from '../../shared/infrastructure/clinical/prisma-active-allergy.reader';

import { EncounterPrescriptionsController } from './encounter-prescriptions.controller';
import { PrescriptionController } from './prescription.controller';
import { PrescriptionService } from './application/prescription.service';
import { PRESCRIPTION_REPOSITORY } from './domain/prescription.repository';
import { PrismaPrescriptionRepository } from './infrastructure/prisma-prescription.repository';

/**
 * The prescription: the module that makes `prescription:write` mean something.
 *
 * Composition root: the only place where the application's ports meet concrete
 * infrastructure. The service never sees Prisma, which is what lets the content
 * rules of art. 5, the validity of arts. 18 and 19 and the allergy check be
 * exercised with in-memory doubles while the guarantees that matter — the two
 * `CHECK`s and the chart scope across a merge — are exercised against a real
 * PostgreSQL.
 *
 * `CurrentUserService` is PROVIDED here rather than imported from `AuthModule`:
 * no module imports another, and the service itself lives in
 * `shared/authorisation` because every module needs to know who is asking. It
 * reads `ClsService`, which is global, so providing it twice costs nothing.
 *
 * ⚠️ IT WIRES AN ACCESS AUDIT RECORDER, like `EncounterModule` and unlike
 * `AgendaModule`. Reading the DOCUMENT of a prescription discloses a name, an
 * age, a diagnosis and a medication of an identifiable person — a drug name IS
 * a diagnosis said differently — and that is exactly the accountable act the
 * LOPDP asks us to be able to reconstruct (PR-092). What is NOT audited is the
 * LISTING (PR-092 again), and that decision lives in the service, beside the
 * read it applies to.
 *
 * ⚠️ ONE SERVICE AND ONE REPOSITORY BECAUSE THERE IS ONE AGGREGATE. The
 * prescription and its lines share a lifecycle, a transaction and a reason to
 * change — the norm of the receta. ADR-008 §2 splits on three limits and this
 * crosses none of them; splitting the document out «because it reads and the
 * rest writes» would be a pattern by symmetry, which CLAUDE.md §9 refuses.
 */
@Module({
  controllers: [EncounterPrescriptionsController, PrescriptionController],
  providers: [
    PrescriptionService,
    CurrentUserService,
    {
      provide: PRESCRIPTION_REPOSITORY,
      useClass: PrismaPrescriptionRepository,
    },
    /**
     * PR-027, PR-062. THE SAME CLASS `EncounterModule` WIRES, and that is the
     * point of it living in `shared/`: «las alergias activas de una ficha» is
     * one statement for the whole system, so the doctor's screen and the
     * prescriber's check cannot disagree — and neither of them can forget
     * `chartScope` on its own.
     */
    { provide: ACTIVE_ALLERGY_READER, useClass: PrismaActiveAllergyReader },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class PrescriptionModule {}
