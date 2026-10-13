import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  medicationsOf,
  seriesKeyOf,
  timelineOf,
  type HistoryResult,
  type Medication,
  type TimelineDay,
} from '../domain/clinical-history';
import { ClinicalHistoryChartNotOpenError } from '../domain/assistant.errors';

import {
  CLINICAL_HISTORY_CLOCK,
  CLINICAL_HISTORY_READER,
  type ClinicalHistoryReader,
  type HistorySites,
} from './clinical-history.reader';

/**
 * Its own resource type in the trail: this read discloses the chart's
 * laboratory, prescriptions and attentions at once — «¿quién miró la
 * historia de esta paciente?» has rows of its own to find.
 */
const RESOURCE_TYPE = 'patient_clinical_history';

/**
 * AS-207. Bounds, and not request parameters: a caller-supplied limit is a
 * bulk extraction that leaves one audit row (the argument of
 * `VITALS_HISTORY_LIMIT`). Each total is said, so a cut is visible.
 */
export const HISTORY_LIMITS = {
  results: 300,
  visits: 100,
  prescriptions: 200,
} as const;

export interface HistoryRequester {
  userId: string;
  sites: HistorySites;
  ip?: string;
  userAgent?: string;
}

export interface ClinicalHistory {
  patientId: string;
  results: {
    items: (HistoryResult & { seriesKey: string | null })[];
    total: number;
  };
  medications: { items: Medication[]; prescriptionTotal: number };
  visits: { total: number };
  timeline: TimelineDay[];
  hasEntriesOutsideScope: boolean;
}

/**
 * AS-200 to AS-207. The patient's history without a model (B1).
 *
 * A READ MODEL: it composes and audits, and writes no clinical content. Not
 * behind `ASSISTANT_ENABLED` nor `assistant:use` (D-256 §1): no model is
 * called and nothing leaves the database.
 */
@Injectable()
export class ClinicalHistoryService {
  constructor(
    @Inject(CLINICAL_HISTORY_READER)
    private readonly reader: ClinicalHistoryReader,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    @Inject(CLINICAL_HISTORY_CLOCK) private readonly clock: () => Date,
  ) {}

  /**
   * AS-200. THE CHART MUST BE OPEN, and a refusal is not audited: nothing
   * was disclosed. ONE AUDIT ENTRY otherwise, written before anything is
   * returned (AS-207).
   */
  async forChart(
    patientId: string,
    requester: HistoryRequester,
  ): Promise<ClinicalHistory> {
    if (!(await this.reader.chartIsOpen(patientId))) {
      throw new ClinicalHistoryChartNotOpenError();
    }

    const query = { patientId, sites: requester.sites };
    const [results, resultTotal, lines, prescriptionTotal, visits, visitTotal, outside] =
      await Promise.all([
        this.reader.results(query, HISTORY_LIMITS.results),
        this.reader.countResults(query),
        this.reader.prescribedLines(query, HISTORY_LIMITS.prescriptions),
        this.reader.countPrescriptions(query),
        this.reader.visits(query, HISTORY_LIMITS.visits),
        this.reader.countVisits(query),
        requester.sites === 'all'
          ? Promise.resolve(false)
          : this.reader.hasVisitsOutsideScope(query),
      ]); // prettier-ignore

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    const today = clinicalDateOf(this.clock());
    return {
      patientId,
      results: {
        items: results.map((result) => ({
          ...result,
          seriesKey: seriesKeyOf(result),
        })),
        total: resultTotal,
      },
      medications: { items: medicationsOf(lines, today), prescriptionTotal },
      visits: { total: visitTotal },
      timeline: timelineOf({ visits, lines, results, today }),
      hasEntriesOutsideScope: outside,
    };
  }
}
