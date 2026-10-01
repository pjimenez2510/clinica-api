import { Inject, Injectable } from '@nestjs/common';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import { EXPORT_OMISSIONS, EXPORTABLE_RIGHTS } from '../domain/data-export';
import {
  DUE_DATE_HORIZON_DAYS,
  legalDueDate,
  type DataSubjectRight,
} from '../domain/legal-due-date';
import {
  DataExportNotApplicableError,
  DataRequestAlreadyAnsweredError,
  DataRequestNotFoundError,
  DataRequestReceivedInFutureError,
  DataSubjectNotFoundError,
} from '../domain/privacy.errors';
import {
  DATA_SUBJECT_REQUEST_REPOSITORY,
  type DataExportDocument,
  type DataRequestOutcome,
  type DataRequestView,
  type DataSubjectParty,
  type DataSubjectRequestRepository,
  type Requester,
} from '../domain/privacy.repository';

/** PD-030, PD-033. */
export const DATA_REQUEST_TEXT_MAX_LENGTH = 4_000;

export interface DataRequestEntry extends DataRequestView {
  /** PD-035. Unanswered and its due date is before today's clinical date. */
  isOverdue: boolean;
}

/**
 * The rights a data subject exercises over their data (PD3, PD4).
 *
 * NOTHING HERE DELETES ANYTHING (PD-034, D-055). Answering an erasure request
 * is writing what was answered and why; the chart and the clinical record are
 * never touched from this module.
 */
@Injectable()
export class DataSubjectRequestsService {
  constructor(
    @Inject(DATA_SUBJECT_REQUEST_REPOSITORY)
    private readonly requests: DataSubjectRequestRepository,
  ) {}

  /** PD-030, PD-031, PD-032, PD-037. */
  async register(
    input: {
      patientId: string;
      right: DataSubjectRight;
      requestedBy: DataSubjectParty;
      description: string;
      receivedAt?: Date;
    },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const receivedAt = input.receivedAt ?? now;
    if (receivedAt.getTime() > now.getTime()) {
      throw new DataRequestReceivedInFutureError();
    }
    await this.assertActiveChart(input.patientId);

    const receivedOn = clinicalDateOf(receivedAt);
    const holidays = await this.requests.clinicWideHolidays(
      receivedOn,
      addDays(receivedOn, DUE_DATE_HORIZON_DAYS),
    );
    const dueOn = legalDueDate(input.right, receivedOn, holidays);

    const created = await this.requests.register(
      { ...input, receivedAt, dueOn },
      requester,
    );
    return this.entry(created, now);
  }

  /** PD-033, PD-034, PD-037, PD-038. */
  async answer(
    requestId: string,
    answer: { outcome: DataRequestOutcome; response: string },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const result = await this.requests.answer(requestId, answer, requester);
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'already-answered':
        throw new DataRequestAlreadyAnsweredError();
      case 'answered':
        return this.entry(result.request, now);
    }
  }

  /** PD-036. */
  async requestsOf(
    patientId: string,
    now: Date = new Date(),
  ): Promise<DataRequestEntry[]> {
    const chart = await this.requests.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    const rows = await this.requests.requestsOf(patientId);
    return rows.map((row) => this.entry(row, now));
  }

  /** PD-035. */
  async open(now: Date = new Date()): Promise<DataRequestEntry[]> {
    const rows = await this.requests.open();
    return rows.map((row) => this.entry(row, now));
  }

  /** PD-040 to PD-043. */
  async export(
    requestId: string,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataExportDocument> {
    const request = await this.requests.find(requestId);
    if (!request) throw new DataRequestNotFoundError();
    if (!EXPORTABLE_RIGHTS.has(request.right)) {
      throw new DataExportNotApplicableError();
    }
    return this.requests.exportChart(
      request.patientId,
      EXPORT_OMISSIONS,
      requester,
      now,
    );
  }

  private entry(row: DataRequestView, now: Date): DataRequestEntry {
    return {
      ...row,
      isOverdue: row.answer === null && row.dueOn < clinicalDateOf(now),
    };
  }

  private async assertActiveChart(patientId: string): Promise<void> {
    const chart = await this.requests.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    if (chart.status === 'merged') {
      throw new PatientMergedError(chart.survivingMrn);
    }
  }
}
