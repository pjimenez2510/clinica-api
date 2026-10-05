import { Inject, Injectable } from '@nestjs/common';

import {
  ACTIVE_ALLERGY_READER,
  type ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  backgroundSnapshotOf,
  type BackgroundSnapshot,
} from '../domain/background-snapshot';
import {
  PATIENT_ALLERGY_REPOSITORY,
  type PatientAllergyRepository,
} from '../domain/patient-allergy.repository';
import {
  PATIENT_HISTORY_REPOSITORY,
  type PatientHistoryRepository,
} from '../domain/patient-history.repository';

/**
 * EN-206. The chart's active background at one instant, for EVERY path that
 * signs a note: the signature (`ClinicalNoteService.sign`) and the
 * interruption that signs the drafts «con lo hecho» (`EncounterExitService`).
 * One reader, so the two cannot freeze different things.
 *
 * Read through the same readers as the history summary (EN-159), with
 * `chartScope`, so the snapshot and the band say the same thing.
 *
 * ⚠️ READ JUST BEFORE THE SIGNING TRANSACTION, NOT INSIDE IT. The readers are
 * the shared adapters; an allergy recorded or ruled out in the same
 * milliseconds is on the chart for the next reader and in its own trail. The
 * snapshot is what the chart said at `takenAt`, which is the accepted limit
 * EN-206 records.
 */
@Injectable()
export class BackgroundSnapshotReader {
  constructor(
    @Inject(ACTIVE_ALLERGY_READER)
    private readonly allergies: ActiveAllergyReader,
    @Inject(PATIENT_ALLERGY_REPOSITORY)
    private readonly allergyRecords: PatientAllergyRepository,
    @Inject(PATIENT_HISTORY_REPOSITORY)
    private readonly historyRecords: PatientHistoryRepository,
  ) {}

  async snapshotOf(chartId: string, now: Date): Promise<BackgroundSnapshot> {
    const [allergies, noKnownAllergies, history] = await Promise.all([
      this.allergies.activeFor(chartId),
      this.allergyRecords.standingAbsenceFor(chartId),
      this.historyRecords.activeFor(chartId),
    ]);
    return backgroundSnapshotOf({
      takenAt: now,
      allergies,
      noKnownAllergies,
      history,
    });
  }
}
