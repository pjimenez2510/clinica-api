import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import { PatientChartNotOpenError } from '../domain/encounter.errors';
import {
  VITALS_HISTORY_REPOSITORY,
  type BloodPressureReference,
  type VitalsHistoryRepository,
  type VitalsTaking,
} from '../domain/vitals-history.repository';

import type { Requester } from './encounter.service';

/**
 * Its own resource type in the trail: what this read discloses is the
 * chart's vital signs across every attention, neither one attention nor the
 * administrative chart — so «¿quién miró la evolución de esta paciente?» has
 * rows of its own to find.
 */
const RESOURCE_TYPE = 'patient_vitals_history';

/**
 * EN-269. How many takings the tab draws.
 *
 * A BOUND AND NOT A PAGE, and not a request parameter: a caller-supplied
 * limit is a bulk extraction that leaves one audit row (the argument of
 * `PREVIOUS_ENCOUNTERS`). A hundred takings is twenty-five years of a chronic
 * patient seen every three months; `total` says when there are more.
 */
export const VITALS_HISTORY_LIMIT = 100;

/** EN-269, EN-272. What the «Evolución» tab draws. */
export interface VitalsHistory {
  /** The chart asked about — always an open one. */
  patientId: string;
  /** Newest first, bounded by `VITALS_HISTORY_LIMIT`. */
  items: readonly VitalsTaking[];
  /** How many there are within the caller's scope, so «100 de 130» is said. */
  total: number;
  /** EN-272. The line the blood-pressure chart draws. */
  bloodPressureReference: BloodPressureReference | null;
  /**
   * EN-276. There are takings at sites the caller does not cover. Said, not
   * counted: the figure would still be EN-121's to withhold (D-214 §5).
   */
  hasTakingsOutsideScope: boolean;
}

/**
 * EN-269 to EN-272. The evolution of a chart's vital signs.
 *
 * A READ MODEL: it composes and audits, and writes no clinical content.
 */
@Injectable()
export class VitalsHistoryService {
  constructor(
    @Inject(VITALS_HISTORY_REPOSITORY)
    private readonly takings: VitalsHistoryRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * EN-271. THE CHART MUST BE OPEN, like the history (EN-085): an absorbed
   * chart is read from its survivor, and an identifier that names nothing
   * answers the same refusal — and neither is audited, because nothing was
   * disclosed (PA-024).
   *
   * ONE AUDIT ENTRY, written before anything is returned, and never one per
   * taking (EN-123).
   */
  async forChart(
    patientId: string,
    requester: Requester,
  ): Promise<VitalsHistory> {
    const chart = await this.encounters.findPatientChart(patientId);
    if (!chart || chart.mergedIntoId !== null) {
      throw new PatientChartNotOpenError();
    }

    const query = { patientId: chart.id, sites: requester.sites };
    const [items, total, bloodPressureReference, hasTakingsOutsideScope] =
      await Promise.all([
        this.takings.takings({ ...query, limit: VITALS_HISTORY_LIMIT }),
        this.takings.countTakings(query),
        this.takings.bloodPressureReference(requester.sites),
        // EN-276. With the whole clinic in scope there is no «outside».
        requester.sites === 'all'
          ? Promise.resolve(false)
          : this.takings.hasTakingsOutsideScope(query),
      ]);

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: chart.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return {
      patientId: chart.id,
      items,
      total,
      bloodPressureReference,
      hasTakingsOutsideScope,
    };
  }
}
