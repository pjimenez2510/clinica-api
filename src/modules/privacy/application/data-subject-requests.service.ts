import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  CLINICAL_RECORD_COPY_FREEZER,
  type ClinicalRecordCopyFreezer,
} from '../../../shared/documents/clinical-record-copy-freezer.port';
import {
  holdsRecordKey,
  type RecordReadScope,
} from '../../../shared/domain/clinical-record-key';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  authorisesDelivery,
  copyNeedsReview,
  copyPeriodOf,
} from '../domain/clinical-record-copy';
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
  type DataRequestRelationship,
} from '../domain/data-request-party';
import {
  DUE_DATE_HORIZON_DAYS,
  legalDeadline,
  type DataSubjectRight,
} from '../domain/legal-due-date';
import {
  ClinicalRecordCopyAlreadyReviewedError,
  ClinicalRecordCopyInvalidError,
  ClinicalRecordCopyReviewRequiredError,
  DataExportNotApplicableError,
  DataRequestAlreadyAnsweredError,
  DataRequestNotAnsweredError,
  DataRequestNotFoundError,
  DataRequestPatientDeceasedError,
  DataRequestPatientNotDeceasedError,
  DataRequestReceivedInFutureError,
  DataSubjectNotFoundError,
} from '../domain/privacy.errors';
import {
  DATA_SUBJECT_REQUEST_REPOSITORY,
  type CopyPeriod,
  type DataExportDocument,
  type DataRequestOutcome,
  type DataRequestView,
  type DataSubjectRequestRepository,
  type GivenAnswer,
  type Requester,
} from '../domain/privacy.repository';

/** PD-030, PD-033. */
export const DATA_REQUEST_TEXT_MAX_LENGTH = 4_000;

export interface DataRequestEntry extends Omit<DataRequestView, 'copySites'> {
  /** PD-035, PD-054. Unanswered and its deadline has been reached. */
  isOverdue: boolean;
  /**
   * PD-060 (D-203 §12). Whoever reads it may authorise it: always, unless it
   * is a copy and they do not hold the key of the record for that person.
   */
  canAuthorise: boolean;
}

/** PD-059. An answer as the screen sends it. */
export interface AnswerInput {
  outcome: DataRequestOutcome;
  response: string;
  copyPeriod?: CopyPeriod | null;
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
    @Inject(CLINICAL_RECORD_COPY_FREEZER)
    private readonly freezer: ClinicalRecordCopyFreezer,
  ) {}

  /** PD-030, PD-031, PD-032, PD-037, PD-052 to PD-054. */
  async register(
    input: {
      patientId: string;
      right: DataSubjectRight;
      requestedBy: DataRequestParty;
      requesterName?: string | null;
      requesterDocument?: string | null;
      requesterRelationship?: DataRequestRelationship | null;
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
    // PD-065 (D-203 §8). The holder of a deceased chart presents nothing; the
    // last legal representative still may (LOPDP art. 27).
    if (presentation.requestedBy === 'HOLDER' && chart.deceased) {
      throw new DataRequestPatientDeceasedError();
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
    return this.entry(created, requester, now);
  }

  /** PD-033, PD-034, PD-037, PD-038, PD-059, PD-062. */
  async answer(
    requestId: string,
    answer: AnswerInput,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const given = await this.authorised(requestId, answer, requester, now);
    const result = await this.requests.answer(requestId, given, requester, now);
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'already-answered':
        throw new DataRequestAlreadyAnsweredError();
      case 'review-required':
        throw new ClinicalRecordCopyReviewRequiredError();
      case 'answered':
        return this.entry(result.request, requester, now);
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
        return this.entry(result.request, requester, now);
    }
  }

  /**
   * PD-047 (D-128.9). «Corregir respuesta»: a rectified answer linked to the
   * one that stands. The original stays on the request and every
   * rectification stays too; the answer is content, so it is required.
   */
  async correctAnswer(
    requestId: string,
    answer: AnswerInput,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const given = await this.authorised(requestId, answer, requester, now);
    const result = await this.requests.correctAnswer(
      requestId,
      given,
      requester,
      now,
    );
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'not-answered':
        throw new DataRequestNotAnsweredError();
      case 'review-required':
        throw new ClinicalRecordCopyReviewRequiredError();
      case 'corrected':
        return this.entry(result.request, requester, now);
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
    return rows.map((row) => this.entry(row, requester, now));
  }

  /**
   * PD-061 (D-203 §5, §6). The professional's review of a copy: with the
   * casilla, once, and before the copy is authorised; whether it includes the
   * violence screening. The key is `record:protected` at a site where the
   * person was attended — without it, as if the request did not exist.
   */
  async reviewCopy(
    requestId: string,
    review: { reviewed: boolean; includesScreening: boolean },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry> {
    const facts = await this.requests.copyFactsOf(requestId);
    if (
      !facts ||
      !facts.clinicalRecordCopy ||
      !holdsReviewKey(
        requester.protectedScope ?? [],
        facts.patientSites,
        facts.reviewSites,
      )
    ) {
      throw new DataRequestNotFoundError();
    }
    if (review.reviewed !== true) {
      throw new ClinicalRecordCopyInvalidError('reviewed');
    }
    const result = await this.requests.reviewCopy(
      requestId,
      { includesScreening: review.includesScreening },
      requester,
      now,
    );
    switch (result.status) {
      case 'missing':
        throw new DataRequestNotFoundError();
      case 'already-reviewed':
        throw new ClinicalRecordCopyAlreadyReviewedError();
      case 'already-authorised':
        throw new DataRequestAlreadyAnsweredError();
      case 'reviewed':
        return this.entry(result.request, requester, now);
    }
  }

  /**
   * PD-061. The copies of a chart a professional may review: not authorised
   * yet, and only those whose person they hold `record:protected` for. Like
   * every read of what a patient asked, it leaves its row (REQ-110).
   */
  async pendingCopiesOf(
    patientId: string,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<DataRequestEntry[]> {
    const chart = await this.requests.chartOf(patientId);
    if (chart.status === 'missing') throw new DataSubjectNotFoundError();
    const rows = (await this.requests.pendingCopiesOf(patientId)).filter(
      (row) => holdsRecordKey(requester.protectedScope ?? [], row.copySites),
    );
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient_data_requests',
      resourceId: patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    return rows.map((row) => this.entry(row, requester, now));
  }

  /** PD-035, PD-051. */
  async open(
    filter: { right?: DataSubjectRight; overdueOnly: boolean },
    page: { page: number; pageSize: number },
    requester: Requester,
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
    return {
      items: items.map((row) => this.entry(row, requester, now)),
      total,
    };
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
    // PD-067. The proposal says what THIS caller's file leaves out.
    const clinical = await this.requests.clinicalOmissionOf(
      requestId,
      requester.recordScope ?? [],
    );
    return answerProposal(
      clinical ? [...EXPORT_OMISSIONS, clinical] : EXPORT_OMISSIONS,
    );
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

  private entry(
    row: DataRequestView,
    requester: Requester,
    now: Date,
  ): DataRequestEntry {
    const { copySites, ...view } = row;
    const canAuthorise =
      !row.clinicalRecordCopy ||
      holdsRecordKey(requester.recordScope ?? [], copySites);
    const protectedKey =
      row.clinicalRecordCopy &&
      holdsRecordKey(requester.protectedScope ?? [], copySites);
    // PD-062 (revisión clínica, A.M. 5216 art. 13). That a copy waits for a
    // review —or that it carries the screening— says the record holds
    // something sensitive: only whoever holds a key to that record reads it.
    const seesReview = row.clinicalRecordCopy && (canAuthorise || protectedKey);
    return {
      ...view,
      isOverdue: row.answer === null && row.dueAt.getTime() <= now.getTime(),
      canAuthorise,
      reviewRequired: seesReview ? row.reviewRequired : false,
      review:
        seesReview && row.review
          ? {
              ...row.review,
              includesScreening: protectedKey
                ? row.review.includesScreening
                : false,
            }
          : null,
    };
  }

  /**
   * PD-059, PD-062 (D-203 §2, §5, §12). An answer as it may be saved: the
   * period of a copy answered «Atendida en parte», checked against the day of
   * the answer; and, when it hands the copy over, the key of the record —
   * without it, as if the request did not exist — and the professional's
   * review when the copy is not the holder's and the record is sensitive.
   * «Denegada» hands nothing over and asks for neither.
   */
  private async authorised(
    requestId: string,
    answer: AnswerInput,
    requester: Requester,
    now: Date,
  ): Promise<GivenAnswer> {
    const facts = await this.requests.copyFactsOf(requestId);
    if (!facts) throw new DataRequestNotFoundError();
    const delivers =
      facts.clinicalRecordCopy && authorisesDelivery(answer.outcome);
    if (delivers) {
      if (!holdsRecordKey(requester.recordScope ?? [], facts.patientSites)) {
        throw new DataRequestNotFoundError();
      }
      if (
        copyNeedsReview(facts.requestedBy, facts.sensitive) &&
        !facts.reviewed
      ) {
        throw new ClinicalRecordCopyReviewRequiredError();
      }
    }
    const copyPeriod = copyPeriodOf({
      clinicalRecordCopy: facts.clinicalRecordCopy,
      outcome: answer.outcome,
      period: answer.copyPeriod,
      answeredOn: clinicalDateOf(now),
    });
    if (!delivers) return { ...answer, copyPeriod };
    // DOC-122. What it hands over, frozen now and saved with the answer; the
    // review is checked again under the request's lock (PD-062).
    const snapshot = await this.freezer.freeze({
      requestId,
      recordScope: requester.recordScope ?? [],
      authorisedAt: now,
      authorisedById: requester.userId,
      copyPeriod,
    });
    if (snapshot === null) throw new DataRequestNotFoundError();
    return {
      ...answer,
      copyPeriod,
      snapshot,
      guardReview: facts.requestedBy !== 'HOLDER',
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
    const key = await this.requests.copyFactsOf(requestId);
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

/**
 * PD-061 (revisión clínica del 10-10-2026). Whoever gives the review must be
 * able to see what it approves: `record:protected` at every site where the
 * person has something sensitive or a screening answered —what «Incluir el
 * tamizaje» would hand over—; with none of those, at one site where the
 * person was attended (the shared key).
 */
function holdsReviewKey(
  scope: RecordReadScope,
  patientSites: readonly string[],
  reviewSites: readonly string[],
): boolean {
  if (scope === 'all') return true;
  if (reviewSites.length === 0) return holdsRecordKey(scope, patientSites);
  return reviewSites.every((site) => scope.includes(site));
}
