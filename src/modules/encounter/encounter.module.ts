import './infrastructure/encounter.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ACTIVE_ALLERGY_READER } from '../../shared/clinical/patient-allergy.port';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { PrismaActiveAllergyReader } from '../../shared/infrastructure/clinical/prisma-active-allergy.reader';

import {
  ChartSummaryController,
  VisitSequenceProposalController,
} from './chart-summary.controller';
import { ChartSummaryService } from './application/chart-summary.service';
import { ClinicalCodingController } from './clinical-coding.controller';
import { ClinicalCodingService } from './application/clinical-coding.service';
import { ClinicalNoteController } from './clinical-note.controller';
import { NoteTemplateController } from './note-template.controller';
import { NoteTemplateService } from './application/note-template.service';
import { NOTE_TEMPLATE_REPOSITORY } from './domain/note-template.repository';
import { PrismaNoteTemplateRepository } from './infrastructure/prisma-note-template.repository';
import { ClinicalNoteService } from './application/clinical-note.service';
import { EncounterController } from './encounter.controller';
import { EncounterExitController } from './encounter-exit.controller';
import { EncounterExitService } from './application/encounter-exit.service';
import { EncounterService } from './application/encounter.service';
import { PatientAllergyController } from './patient-allergy.controller';
import { PatientAllergyService } from './application/patient-allergy.service';
import { PatientHistoryController } from './patient-history.controller';
import { PatientHistoryService } from './application/patient-history.service';
import { PATIENT_HISTORY_REPOSITORY } from './domain/patient-history.repository';
import { PrismaPatientHistoryRepository } from './infrastructure/prisma-patient-history.repository';
import { CHART_SUMMARY_REPOSITORY } from './domain/chart-summary.repository';
import { CLINICAL_CODING_REPOSITORY } from './domain/clinical-coding.repository';
import { CLINICAL_NOTE_REPOSITORY } from './domain/clinical-note.repository';
import { ENCOUNTER_REPOSITORY } from './domain/encounter.repository';
import { ENCOUNTER_EXIT_REPOSITORY } from './domain/encounter-exit.repository';
import { PATIENT_ALLERGY_REPOSITORY } from './domain/patient-allergy.repository';
import { PrismaChartSummaryRepository } from './infrastructure/prisma-chart-summary.repository';
import { PrismaClinicalCodingRepository } from './infrastructure/prisma-clinical-coding.repository';
import { PrismaClinicalNoteRepository } from './infrastructure/prisma-clinical-note.repository';
import { PrismaEncounterRepository } from './infrastructure/prisma-encounter.repository';
import { PrismaEncounterExitRepository } from './infrastructure/prisma-encounter-exit.repository';
import { PrismaPatientAllergyRepository } from './infrastructure/prisma-patient-allergy.repository';

/**
 * The attention: the module everything else in Fase 1 hangs off.
 *
 * Composition root: the only place where the application's ports meet concrete
 * infrastructure. Neither service ever sees Prisma, which is what lets the
 * state machine, the closure policy and the note's amendment rules be
 * exercised with in-memory doubles while the guarantees that matter — the
 * frozen age, the BMI, the immutability of a signed note — are exercised
 * against a real PostgreSQL.
 *
 * `CurrentUserService` is PROVIDED here rather than imported from
 * `AuthModule`: no module imports another, and the service itself lives in
 * `shared/authorisation` because every module needs to know who is asking. It
 * reads `ClsService`, which is global, so providing it twice costs nothing.
 *
 * ⚠️ IT *DOES* WIRE AN ACCESS AUDIT RECORDER, and that is the difference from
 * `AgendaModule`, which deliberately does not. The agenda serves no clinical
 * content, so a recorder there would eventually be called once per listed row;
 * here, opening an attention and reading a note ARE the accountable acts the
 * LOPDP asks us to be able to reconstruct (EN-017, EN-122). What is NOT
 * audited is every listing (EN-123) — that decision lives in the services,
 * beside the reads it applies to.
 *
 * ⚠️ THREE SERVICES AND THREE REPOSITORIES BECAUSE THERE ARE THREE
 * AGGREGATES. The note chain has a lifecycle the attention does not have,
 * invariants of its own and an immutability that is the whole point of the
 * module; they share exactly one identifier. And block K — the diagnoses and
 * the procedures — asks a different KIND of question altogether: everything
 * about it is a question about a catalogue concept, so the day the CIE-10
 * edition is replaced or the tariff republished, that pair moves and neither
 * of the other two does. ADR-008 §2 splits on exactly those three limits.
 */
@Module({
  controllers: [
    // Before `EncounterController`: its literal path would otherwise be
    // swallowed by `GET /encounters/:id` (EN-185).
    VisitSequenceProposalController,
    EncounterController,
    EncounterExitController,
    ClinicalNoteController,
    ClinicalCodingController,
    PatientAllergyController,
    PatientHistoryController,
    ChartSummaryController,
    NoteTemplateController,
  ],
  providers: [
    EncounterService,
    EncounterExitService,
    ClinicalNoteService,
    ClinicalCodingService,
    PatientAllergyService,
    PatientHistoryService,
    ChartSummaryService,
    NoteTemplateService,
    CurrentUserService,
    { provide: ENCOUNTER_REPOSITORY, useClass: PrismaEncounterRepository },
    {
      provide: ENCOUNTER_EXIT_REPOSITORY,
      useClass: PrismaEncounterExitRepository,
    },
    {
      provide: CLINICAL_NOTE_REPOSITORY,
      useClass: PrismaClinicalNoteRepository,
    },
    {
      provide: CLINICAL_CODING_REPOSITORY,
      useClass: PrismaClinicalCodingRepository,
    },
    {
      provide: PATIENT_ALLERGY_REPOSITORY,
      useClass: PrismaPatientAllergyRepository,
    },
    {
      provide: PATIENT_HISTORY_REPOSITORY,
      useClass: PrismaPatientHistoryRepository,
    },
    {
      provide: CHART_SUMMARY_REPOSITORY,
      useClass: PrismaChartSummaryRepository,
    },
    {
      provide: NOTE_TEMPLATE_REPOSITORY,
      useClass: PrismaNoteTemplateRepository,
    },
    /**
     * EN-084. The SHARED reader, wired here and — identically — by
     * `PrescriptionModule` when it exists.
     *
     * ⚠️ IT IS NOT A REPOSITORY OF THIS MODULE, and that is the point. «Las
     * alergias activas de una ficha» is the one question two modules ask, and
     * no module may import another, so the statement lives in `shared` and
     * both wire the same class. The alternative — each module writing its own
     * `patientAllergy.findMany` — is two statements of one predicate, and the
     * one that would eventually be wrong is the one that forgets `chartScope`
     * and hides the penicillin allergy of an absorbed chart.
     */
    { provide: ACTIVE_ALLERGY_READER, useClass: PrismaActiveAllergyReader },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class EncounterModule {}
