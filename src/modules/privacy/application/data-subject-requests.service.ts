import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import { holdsRecordKey } from '../../../shared/domain/clinical-record-key';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  answerProposal,
  clinicalRecordCopyProposal,
  EXPORT_OMISSIONS,
  EXPORTABLE_RIGHTS,
} from '../domain/data-export';
import {
  isThirdParty,
  presentationOf,
  type DataRequestParty,
} from '../domain/data-request-party';
import {
  DUE_DATE_HORIZON_DAYS,
  legalDeadline,
  type DataSubjectRight,
} from '../domain/legal-due-date';
import {
  ClinicalRecordCopyInvalidError,
  DataExportNotApplicableError,
  DataRequestAlreadyAnsweredError,
  DataRequestNotAnsweredError,
  DataRequestNotFoundError,
  DataRequestPatientNotDeceasedError,
  DataRequestReceivedInFutureError,
  DataSubjectNotFoundError,
} from '../domain/privacy.errors';
import {
  DATA_SUBJECT_REQUEST_REPOSITORY,
  type DataExportDocument,
  type DataRequestOutcome,
  type DataRequestView,
  type DataSubjectRequestRepository,
  type Requester,
} from '../domain/privacy.repository';

/** PD-030, PD-033. */
export const DATA_REQUEST_TEXT_MAX_LENGTH = 4_000;

export interface DataRequestEntry extends DataRequestView {
  /** PD-035, PD-054. Unanswered and its deadline has been reached. */
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

  /** PD-030, PD-031, PD-032, PD-037, PD-052 to PD-054. */
  async register(
    input: {
      patientId: string;
      right: DataSubjectRight;
      requestedBy: DataRequestParty;
      requesterName?: string | null;
      requesterDocument?: string | null;
      clinicalRecordCopy?: boolean;
      documentsChecked?: boolean;
      description: string;
      receivedAt?: Date;
    },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    if (input.receivedAt && input.receivedAt.getTime() > now.getTime()) {
      throw new DataRequestReceivedInFutureError();
    }
    // PD-052, PD-053. Who presents it and what for, as the A.M. 5216 admits.
    const presentation = presentationOf(input);
    const chart = await this.activeChart(input.patientId);
    if (presentation.requestedBy === 'DECEASED_RELATIVE' && !chart.deceased) {
      throw new DataRequestPatientNotDeceasedError();
    }

    const receivedAt = input.receivedAt ?? now;
    const dueAt = await this.deadline(presentation, receivedAt);

    const created = await this.requests.register(
      {
        patientId: input.patientId,
        description: input.description,
        receivedAt,
        registeredAt: now,
        ...presentation,
        dueAt,
      },
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
    await this.assertRecordKey(requestId, requester);
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
    // PD-053. Whether it asks for the copy never changes (the base refuses
    // it), so reading it before the lock is safe: a copy stays an access.
    if (
      current.clinicalRecordCopy &&
      changes.right !== undefined &&
      changes.right !== 'ACCESS'
    ) {
      throw new ClinicalRecordCopyInvalidError('clinicalRecordCopy');
    }
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
    await this.assertRecordKey(requestId, requester);
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

  /** PD-035, PD-051. */
  async open(
    filter: { right?: DataSubjectRight; overdueOnly: boolean },
    page: { page: number; pageSize: number },
    now: Date = new Date(),
  ): Promise<{ items: DataRequestEntry[]; total: number }> {
    const { items, total } = await this.requests.open(
      {
        ...(filter.right ? { right: filter.right } : {}),
        // Overdue is «its deadline has been reached», the test `entry` marks.
        ...(filter.overdueOnly ? { dueBy: now } : {}),
      },
      page,
    );
    return { items: items.map((row) => this.entry(row, now)), total };
  }

  /** PD-040 to PD-043. */
  async export(
    requestId: string,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataExportDocument> {
    const request = await this.requests.find(requestId);
    if (!request) throw new DataRequestNotFoundError();
    // PD-055. A third party is handed the copy of the record (DOC-118), not
    // the holder's chart, consents and requests.
    if (
      !EXPORTABLE_RIGHTS.has(request.right) ||
      isThirdParty(request.requestedBy)
    ) {
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
   * PD-049 (D-164.2), PD-055, PD-056. The answer proposed for an access or
   * portability request: what the export leaves out and why; for the copy of
   * the clinical record, what the copy carries and to whom it is handed.
   * Reads only what the request says of itself — no data of the chart —, so
   * it writes nothing, not even an audit row; what was answered is recorded
   * when the answer is saved.
   */
  async answerProposal(
    requestId: string,
    requester: Requester,
  ): Promise<string> {
    await this.assertRecordKey(requestId, requester);
    const facts = await this.requests.proposalFactsOf(requestId);
    if (!facts) throw new DataRequestNotFoundError();
    if (facts.clinicalRecordCopy) return clinicalRecordCopyProposal(facts);
    if (
      !EXPORTABLE_RIGHTS.has(facts.right) ||
      isThirdParty(facts.requestedBy)
    ) {
      throw new DataExportNotApplicableError();
    }
    return answerProposal(EXPORT_OMISSIONS);
  }

  /** PD-032, PD-054. The legal deadline of a request received at an instant. */
  private async deadline(
    request: { right: DataSubjectRight; clinicalRecordCopy: boolean },
    receivedAt: Date,
  ): Promise<Date> {
    // PD-054. Running hours: no holiday to read.
    if (request.clinicalRecordCopy) {
      return legalDeadline(request, receivedAt, new Set());
    }
    const receivedOn = clinicalDateOf(receivedAt);
    const holidays = await this.requests.clinicWideHolidays(
      receivedOn,
      addDays(receivedOn, DUE_DATE_HORIZON_DAYS),
    );
    return legalDeadline(request, receivedAt, holidays);
  }

  private entry(row: DataRequestView, now: Date): DataRequestEntry {
    return {
      ...row,
      isOverdue: row.answer === null && row.dueAt.getTime() <= now.getTime(),
    };
  }

  /**
   * D-203 §1, decided by the author on 10-10-2026. Answering a request for the
   * copy of the clinical record IS authorising its delivery, so it asks for
   * the key of the record: `record:read` at a site where the person was
   * attended. Without it the request answers as if it did not exist, like
   * every clinical read: the refusal does not say there is a record behind.
   */
  private async assertRecordKey(
    requestId: string,
    requester: Requester,
  ): Promise<void> {
    const key = await this.requests.copyKeyOf(requestId);
    if (!key) throw new DataRequestNotFoundError();
    if (
      key.clinicalRecordCopy &&
      !holdsRecordKey(requester.recordScope ?? [], key.patientSites)
    ) {
      throw new DataRequestNotFoundError();
    }
  }

  private async activeChart(patientId: string): Promise<{ deceased: boolean }> {
    const chart = await this.requests.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    if (chart.status === 'merged') {
      throw new PatientMergedError(chart.survivingMrn);
    }
    return chart;
  }
}
