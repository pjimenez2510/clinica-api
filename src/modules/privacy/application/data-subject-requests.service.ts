import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  answerProposal,
  EXPORT_OMISSIONS,
  EXPORTABLE_RIGHTS,
} from '../domain/data-export';
import {
  DUE_DATE_HORIZON_DAYS,
  legalDueDate,
  type DataSubjectRight,
} from '../domain/legal-due-date';
import {
  DataExportNotApplicableError,
  DataRequestAlreadyAnsweredError,
  DataRequestNotAnsweredError,
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
 * The rights a data subject exercises over their data (D3, D4).
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
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
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
    if (input.receivedAt && input.receivedAt.getTime() > now.getTime()) {
      throw new DataRequestReceivedInFutureError();
    }
    await this.assertActiveChart(input.patientId);

    const dueOn = await this.dueOn(input.right, input.receivedAt ?? now);

    const created = await this.requests.register(
      { ...input, dueOn },
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
    const result = await this.requests.answer(
      requestId,
      answer,
      requester,
      now,
    );
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'already-answered':
        throw new DataRequestAlreadyAnsweredError();
      case 'answered':
        return this.entry(result.request, now);
    }
  }

  /**
   * PD-046 (D-127, D-128.9). Edits what was asked while it is unanswered: the
   * right, what it asks and when it was received. The due date is a function
   * of the right and the receipt (PD-032), so it is RECOMPUTED when either
   * changes —with today's rule and holidays— and only then; the previous row
   * is kept by `record_version`.
   *
   * ⚠️ THE REPOSITORY RECOMPUTES IT, UNDER THE ROW LOCK. Computed here, from
   * the row read before the lock, two simultaneous edits —one of the right,
   * one of the receipt— each left the due date of a combination that never
   * existed.
   */
  async edit(
    requestId: string,
    changes: {
      right?: DataSubjectRight;
      description?: string;
      receivedAt?: Date;
    },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const current = await this.requests.find(requestId);
    if (!current) throw new DataRequestNotFoundError();
    if (current.answer !== null) throw new DataRequestAlreadyAnsweredError();
    // PD-031. Not after now, and not after it was registered: the base
    // repeats the second (`data_subject_request_received_not_future`).
    if (
      changes.receivedAt &&
      (changes.receivedAt.getTime() > now.getTime() ||
        changes.receivedAt.getTime() > current.registeredAt.getTime())
    ) {
      throw new DataRequestReceivedInFutureError();
    }

    const result = await this.requests.edit(requestId, changes, requester, now);
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'already-answered':
        throw new DataRequestAlreadyAnsweredError();
      case 'edited':
        return this.entry(result.request, now);
    }
  }

  /**
   * PD-047 (D-128.9). «Corregir respuesta»: a rectified answer linked to the
   * one that stands. The original stays on the request and every
   * rectification stays too; the answer is content, so it is required.
   */
  async correctAnswer(
    requestId: string,
    answer: { outcome: DataRequestOutcome; response: string },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const result = await this.requests.correctAnswer(
      requestId,
      answer,
      requester,
      now,
    );
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'not-answered':
        throw new DataRequestNotAnsweredError();
      case 'corrected':
        return this.entry(result.request, now);
    }
  }

  /** PD-036. */
  async requestsOf(
    patientId: string,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry[]> {
    const chart = await this.requests.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    const rows = await this.requests.requestsOf(patientId);
    // What the patient asked can carry health data, so reading it is a READ
    // of the chart (REQ-110), not a listing (REQ-111). Through the recorder,
    // whose policy is the right one for a read: log, never refuse.
    await this.audit.record({
      userId: requester.userId,
      // Its own type, keyed by the CHART: `data_subject_request` rows carry a
      // request id, and «who read this patient's requests» is a question
      // about the chart.
      resourceType: 'patient_data_requests',
      resourceId: patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
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
      request.id,
      request.patientId,
      EXPORT_OMISSIONS,
      requester,
      now,
    );
  }

  /**
   * PD-049 (D-164.2). The answer proposed for an access or portability
   * request: what the export leaves out and why. Reads only the request's
   * right — no data of the chart —, so it writes nothing, not even an audit
   * row; what the data subject was told is recorded when the answer is saved.
   */
  async answerProposal(requestId: string): Promise<string> {
    const request = await this.requests.find(requestId);
    if (!request) throw new DataRequestNotFoundError();
    if (!EXPORTABLE_RIGHTS.has(request.right)) {
      throw new DataExportNotApplicableError();
    }
    return answerProposal(EXPORT_OMISSIONS);
  }

  /** PD-032. The legal due date of a right received at an instant. */
  private async dueOn(
    right: DataSubjectRight,
    receivedAt: Date,
  ): Promise<ClinicalDate> {
    const receivedOn = clinicalDateOf(receivedAt);
    const holidays = await this.requests.clinicWideHolidays(
      receivedOn,
      addDays(receivedOn, DUE_DATE_HORIZON_DAYS),
    );
    return legalDueDate(right, receivedOn, holidays);
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
