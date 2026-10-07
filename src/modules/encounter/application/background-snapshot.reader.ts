import { Inject, Injectable } from '@nestjs/common';

import {
  ACTIVE_ALLERGY_READER,
  type ActiveAllergyReader,
  type SurvivingChartAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  backgroundSnapshotOf,
  type BackgroundSnapshot,
} from '../domain/background-snapshot';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import {
  PATIENT_ALLERGY_REPOSITORY,
  type PatientAllergyRepository,
} from '../domain/patient-allergy.repository';
import {
  PATIENT_HISTORY_REPOSITORY,
  type PatientHistoryRepository,
} from '../domain/patient-history.repository';
import { chartOfRecord } from './chart-of-record';

/**
 * EN-206. The chart's active background at one instant, for EVERY path that
 * signs a note: the signature (`ClinicalNoteService.sign`) and the
 * interruption that signs the drafts «con lo hecho» (`EncounterExitService`).
 * One reader, so the two cannot freeze different things.
 *
 * Read through the same readers as the history summary (EN-159), with
 * `chartScope`, so the snapshot and the band say the same thing — and FROM THE
 * SAME CHART: the surviving one when the attention's own was merged while it
 * was open (EN-237), or the note would freeze a background without the
 * survivor's allergy into the signed record.
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
    private readonly allergies: ActiveAllergyReader &
      SurvivingChartAllergyReader,
    @Inject(PATIENT_ALLERGY_REPOSITORY)
    private readonly allergyRecords: PatientAllergyRepository,
    @Inject(PATIENT_HISTORY_REPOSITORY)
    private readonly historyRecords: PatientHistoryRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
  ) {}

  /** `attentionChartId` is the attention's own chart; the survivor is resolved here. */
  async snapshotOf(
    attentionChartId: string,
    now: Date,
  ): Promise<BackgroundSnapshot> {
    const chartId = await chartOfRecord(this.encounters, attentionChartId);
    const [allergies, noKnownAllergies, history] = await Promise.all([
      // EN-237. In ONE statement from the attention's chart, the one the
      // prescription checks: what is frozen into a signed record does not
      // depend on a merge or an undo landing between two reads.
      this.allergies.activeForSurvivorOf(attentionChartId),
      // EN-237, PR-117. Asked of the ATTENTION's chart, like the receta: an
      // absorbed chart answers `null` («no registradas», the safe side), and
      // the survivor's assertion was never made about this attention.
      this.allergyRecords.standingAbsenceFor(attentionChartId),
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
