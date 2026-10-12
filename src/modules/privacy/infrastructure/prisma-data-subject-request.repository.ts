import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  holdsRecordKey,
  type RecordReadScope,
} from '../../../shared/domain/clinical-record-key';
import {
  chartScope,
  chartScopeOfSurvivor,
} from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { SENSITIVE_CIE10_PATTERN } from '../domain/clinical-record-copy';
import type {
  AnswerResult,
  ChartLookup,
  CopyFacts,
  CopyPeriod,
  CopyReviewView,
  CorrectAnswerResult,
  DataExportDocument,
  DataRequestAnswer,
  DataRequestChanges,
  DataRequestOutcome,
  DataRequestView,
  DataSubjectRequestRepository,
  EditRequestResult,
  ExportOmission,
  GivenAnswer,
  NewDataRequest,
  ProposalFacts,
  Requester,
  ReviewCopyResult,
  StaffName,
} from '../domain/privacy.repository';

import {
  chartIds,
  chartLookup,
  fromClinicalDate,
  nameOf,
  patientNames,
  staffNames,
  toClinicalDate,
  writeTrail,
  type Db,
} from './privacy-reads';
import {
  DUE_DATE_HORIZON_DAYS,
  lastDayOnTime,
  legalDeadline,
  type DataSubjectRight,
} from '../domain/legal-due-date';

import { recordVersionsOfChart } from './record-version-subjects';

/** Every request is read with its latest review: the one that stands (PD-061). */
const WITH_REVIEW = {
  copyReviews: { orderBy: { reviewedAt: 'desc' }, take: 1 },
} as const satisfies Prisma.DataSubjectRequestInclude;

type RequestRow = Prisma.DataSubjectRequestGetPayload<{
  include: typeof WITH_REVIEW;
}>;

@Injectable()
export class PrismaDataSubjectRequestRepository implements DataSubjectRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  chartOf(patientId: string): Promise<ChartLookup> {
    return chartLookup(this.prisma, patientId);
  }

  clinicWideHolidays(
    from: ClinicalDate,
    to: ClinicalDate,
  ): Promise<Set<string>> {
    return clinicWideHolidaysIn(this.prisma, from, to);
  }

  async register(
    request: NewDataRequest,
    requester: Requester,
  ): Promise<DataRequestView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dataSubjectRequest.create({
        data: {
          patientId: request.patientId,
          right: request.right,
          requestedBy: request.requestedBy,
          requesterName: request.requesterName,
          requesterDocument: request.requesterDocument,
          requesterRelationship: request.requesterRelationship,
          clinicalRecordCopy: request.clinicalRecordCopy,
          documentsChecked: request.documentsChecked,
          description: request.description,
          // PD-054. Both on the application's clock, the one the deadline is
          // computed with: «ahora» is the same instant for the receipt and
          // the registration, so the not-future CHECK holds by construction.
          receivedAt: request.receivedAt,
          registeredAt: request.registeredAt,
          dueAt: request.dueAt,
          registeredBy: requester.userId,
        },
        include: WITH_REVIEW,
      });
      await writeTrail(
        tx,
        {
          resourceType: 'data_subject_request',
          resourceId: created.id,
          action: 'CREATE',
        },
        requester,
      );
      return created;
    });
    const [view] = await this.views(this.prisma, [row]);
    return view!;
  }

  async answer(
    requestId: string,
    answer: GivenAnswer,
    requester: Requester,
    now: Date,
  ): Promise<AnswerResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      // The row lock is what makes a second answer lose cleanly: it waits
      // here, then finds the first one.
      const current = await lockRequest(tx, requestId);
      if (!current) return { status: 'missing' } as const;
      if (current.outcome !== null) {
        return { status: 'already-answered' } as const;
      }
      // PD-062. Under the lock: a review given or a sensitive datum recorded
      // meanwhile is what this answer is judged by.
      if (answer.guardReview && (await reviewMissing(tx, requestId))) {
        return { status: 'review-required' } as const;
      }
      await tx.dataSubjectRequest.update({
        where: { id: requestId },
        data: {
          outcome: answer.outcome,
          response: answer.response,
          answeredAt: now,
          answeredBy: requester.userId,
          ...periodColumns(answer.copyPeriod),
          // PD-046: answering is an UPDATE like any other, stamped, so the
          // unanswered request stays as a version.
          changedBy: requester.userId,
          changedAt: stampAfter(current.changed_at, now),
        },
      });
      // DOC-122. What it authorised, frozen with the answer.
      if (answer.snapshot !== undefined) {
        await tx.clinicalRecordCopySnapshot.create({
          data: {
            requestId,
            correctionId: null,
            data: answer.snapshot as Prisma.InputJsonValue,
            frozenAt: now,
          },
        });
      }
      await writeTrail(
        tx,
        {
          resourceType: 'data_subject_request',
          resourceId: requestId,
          action: 'UPDATE',
        },
        requester,
      );
      return { status: 'answered' } as const;
    });

    if (outcome.status !== 'answered') return outcome;
    const request = await this.find(requestId);
    return { status: 'answered', request: request! };
  }

  async edit(
    requestId: string,
    changes: DataRequestChanges,
    requester: Requester,
    now: Date,
  ): Promise<EditRequestResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await lockRequest(tx, requestId);
      if (!current) return { status: 'missing' } as const;
      if (current.outcome !== null) {
        return { status: 'already-answered' } as const;
      }

      const data: Prisma.DataSubjectRequestUncheckedUpdateInput = {};
      if (changes.right !== undefined && changes.right !== current.right) {
        data.right = changes.right;
      }
      if (
        changes.description !== undefined &&
        changes.description !== current.description
      ) {
        data.description = changes.description;
      }
      if (
        changes.receivedAt !== undefined &&
        changes.receivedAt.getTime() !== current.received_at.getTime()
      ) {
        data.receivedAt = changes.receivedAt;
      }
      // PD-046, PD-032. The due date follows the right and the receipt THAT
      // RESULT, read under the lock: a colleague's edit committed while this
      // one waited is part of what this one computes from. Recomputed only
      // when either moved, with today's rule and holidays.
      const right = changes.right ?? current.right;
      const receivedAt = changes.receivedAt ?? current.received_at;
      if (data.right !== undefined || data.receivedAt !== undefined) {
        const receivedOn = clinicalDateOf(receivedAt);
        // PD-054. The copy's 48 hours are running hours: no holiday to read.
        const holidays = current.clinical_record_copy
          ? new Set<string>()
          : await clinicWideHolidaysIn(
              tx,
              receivedOn,
              addDays(receivedOn, DUE_DATE_HORIZON_DAYS),
            );
        const dueAt = legalDeadline(
          { right, clinicalRecordCopy: current.clinical_record_copy },
          receivedAt,
          holidays,
        );
        if (dueAt.getTime() !== current.due_at.getTime()) data.dueAt = dueAt;
      }
      // Nothing to change is not an edit: no version of an identical row.
      if (Object.keys(data).length === 0) return { status: 'edited' } as const;

      await tx.dataSubjectRequest.update({
        where: { id: requestId },
        data: {
          ...data,
          changedBy: requester.userId,
          changedAt: stampAfter(current.changed_at, now),
        },
      });
      await writeTrail(
        tx,
        {
          resourceType: 'data_subject_request',
          resourceId: requestId,
          action: 'UPDATE',
        },
        requester,
      );
      return { status: 'edited' } as const;
    });

    if (outcome.status !== 'edited') return outcome;
    const request = await this.find(requestId);
    return { status: 'edited', request: request! };
  }

  async correctAnswer(
    requestId: string,
    answer: GivenAnswer,
    requester: Requester,
    now: Date,
  ): Promise<CorrectAnswerResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      // The request's lock orders two rectifications: each corrects the one
      // that stands when it gets the lock, so the chain never forks.
      const current = await lockRequest(tx, requestId);
      if (!current) return { status: 'missing' } as const;
      if (current.outcome === null) {
        return { status: 'not-answered' } as const;
      }
      if (answer.guardReview && (await reviewMissing(tx, requestId))) {
        return { status: 'review-required' } as const;
      }
      const standing = await tx.dataSubjectAnswerCorrection.findFirst({
        where: { requestId, correctedBy: null },
        select: { id: true },
      });
      const correction = await tx.dataSubjectAnswerCorrection.create({
        data: {
          requestId,
          correctsId: standing?.id ?? null,
          outcome: answer.outcome,
          response: answer.response,
          answeredAt: now,
          answeredBy: requester.userId,
          ...periodColumns(answer.copyPeriod),
        },
        select: { id: true },
      });
      if (answer.snapshot !== undefined) {
        await tx.clinicalRecordCopySnapshot.create({
          data: {
            requestId,
            correctionId: correction.id,
            data: answer.snapshot as Prisma.InputJsonValue,
            frozenAt: now,
          },
        });
      }
      await writeTrail(
        tx,
        {
          resourceType: 'data_subject_request',
          resourceId: requestId,
          action: 'UPDATE',
        },
        requester,
      );
      return { status: 'corrected' } as const;
    });

    if (outcome.status !== 'corrected') return outcome;
    const request = await this.find(requestId);
    return { status: 'corrected', request: request! };
  }

  async proposalFactsOf(requestId: string): Promise<ProposalFacts | null> {
    const row = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
      select: {
        right: true,
        requestedBy: true,
        requesterName: true,
        clinicalRecordCopy: true,
        copyReviews: {
          orderBy: { reviewedAt: 'desc' },
          take: 1,
          select: { includesScreening: true },
        },
      },
    });
    if (!row) return null;
    const { copyReviews, ...facts } = row;
    return {
      ...facts,
      includesScreening: copyReviews[0]?.includesScreening === true,
    };
  }

  async copyFactsOf(requestId: string): Promise<CopyFacts | null> {
    const request = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
      select: { patientId: true, clinicalRecordCopy: true, requestedBy: true },
    });
    if (!request) return null;
    if (!request.clinicalRecordCopy) {
      return {
        clinicalRecordCopy: false,
        requestedBy: request.requestedBy,
        patientSites: [],
        sensitive: false,
        reviewed: false,
        reviewSites: [],
      };
    }
    const facts = await sensitiveFactsOf(this.prisma, request.patientId);
    return {
      clinicalRecordCopy: true,
      requestedBy: request.requestedBy,
      patientSites: await copySitesOf(this.prisma, request.patientId),
      sensitive: facts.sensitiveSites.length > 0,
      reviewed: await reviewStands(this.prisma, requestId),
      reviewSites: facts.reviewSites,
    };
  }

  async reviewCopy(
    requestId: string,
    review: { includesScreening: boolean },
    requester: Requester,
    now: Date,
  ): Promise<ReviewCopyResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      // The request's lock orders the review against an answer and against a
      // second review: of two, the second finds the first.
      const current = await lockRequest(tx, requestId);
      if (!current || !current.clinical_record_copy) {
        return { status: 'missing' } as const;
      }
      const standing = await standingOutcome(tx, requestId, current.outcome);
      if (standing === 'GRANTED' || standing === 'PARTIALLY_GRANTED') {
        return { status: 'already-authorised' } as const;
      }
      // One that stands is enough; a new one only once something sensitive
      // was recorded after it (PD-061).
      if (await reviewStands(tx, requestId)) {
        return { status: 'already-reviewed' } as const;
      }
      await tx.clinicalRecordCopyReview.create({
        data: {
          requestId,
          includesScreening: review.includesScreening,
          reviewedAt: now,
          reviewedBy: requester.userId,
        },
      });
      await writeTrail(
        tx,
        {
          resourceType: 'clinical_record_copy_review',
          resourceId: requestId,
          action: 'CREATE',
        },
        requester,
      );
      return { status: 'reviewed' } as const;
    });
    if (outcome.status !== 'reviewed') return outcome;
    const request = await this.find(requestId);
    return { status: 'reviewed', request: request! };
  }

  async pendingCopiesOf(patientId: string): Promise<DataRequestView[]> {
    const rows = await this.prisma.dataSubjectRequest.findMany({
      where: { ...chartScope(patientId), clinicalRecordCopy: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      include: WITH_REVIEW,
    });
    const views = await this.views(this.prisma, rows);
    // Not authorised yet: unanswered, denied, or rectified to a denial.
    return views.filter(
      (view) =>
        view.answer === null ||
        (view.answer.outcome !== 'GRANTED' &&
          view.answer.outcome !== 'PARTIALLY_GRANTED'),
    );
  }

  async clinicalOmissionOf(
    requestId: string,
    scope: RecordReadScope,
  ): Promise<ExportOmission | null> {
    const request = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
      select: { patient: { select: { id: true, mergedIntoId: true } } },
    });
    if (!request) return null;
    const rootId = request.patient.mergedIntoId ?? request.patient.id;
    const keyed = holdsRecordKey(scope, await copySitesOf(this.prisma, rootId));
    return clinicalVersionsOmission(this.prisma, rootId, scope, keyed);
  }

  async find(requestId: string): Promise<DataRequestView | null> {
    const row = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
      include: WITH_REVIEW,
    });
    if (!row) return null;
    const [view] = await this.views(this.prisma, [row]);
    return view!;
  }

  async requestsOf(patientId: string): Promise<DataRequestView[]> {
    const rows = await this.prisma.dataSubjectRequest.findMany({
      where: chartScope(patientId),
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      include: WITH_REVIEW,
    });
    return this.views(this.prisma, rows);
  }

  async open(
    filter: { right?: DataSubjectRight; dueBy?: Date },
    page: { page: number; pageSize: number },
  ): Promise<{ items: DataRequestView[]; total: number }> {
    const where: Prisma.DataSubjectRequestWhereInput = {
      outcome: null,
      ...(filter.right ? { right: filter.right } : {}),
      ...(filter.dueBy ? { dueAt: { lte: filter.dueBy } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.dataSubjectRequest.findMany({
        where,
        orderBy: [{ dueAt: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        include: WITH_REVIEW,
      }),
      this.prisma.dataSubjectRequest.count({ where }),
    ]);
    return { items: await this.views(this.prisma, rows), total };
  }

  async exportChart(
    requestId: string,
    patientId: string,
    omitted: readonly ExportOmission[],
    requester: Requester,
    now: Date,
  ): Promise<DataExportDocument> {
    return this.prisma.$transaction(async (tx) => {
      // THE CHART THE PERSON HAS TODAY, not the one the request was written
      // on: if that chart was absorbed afterwards, its documents moved to the
      // survivor (PA-043) and everything since lives there. Merges never chain
      // (PA-046), so one hop is the whole resolution.
      const written = await tx.patient.findUniqueOrThrow({
        where: { id: patientId },
        select: { mergedIntoId: true },
      });
      const rootId = written.mergedIntoId ?? patientId;
      const ids = await chartIds(tx, rootId);
      // One after another: a transaction is one connection, and Prisma does
      // not run queries concurrently on it.
      const charts = await tx.patient.findMany({
        where: { id: { in: ids } },
        select: EXPORTED_PATIENT,
      });
      const identifiers = await tx.patientIdentifier.findMany({
        where: { patientId: { in: ids } },
        orderBy: { createdAt: 'asc' },
      });
      const authorizations = await tx.patientAuthorization.findMany({
        where: chartScope(rootId),
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
        include: { revocation: true },
      });
      // PD-073: who recorded and who revoked each one, by name.
      const authorizationStaff = await staffNames(
        tx,
        authorizations.flatMap((row) => [
          row.recordedBy,
          row.revocation?.revokedBy ?? null,
        ]),
      );
      const requestRows = await tx.dataSubjectRequest.findMany({
        where: chartScope(rootId),
        orderBy: { receivedAt: 'asc' },
        include: WITH_REVIEW,
      });
      const requests = await this.views(tx, requestRows);
      // PD-076 (D-176 §3b). The note the board holds today about each of the
      // subject's appointments; earlier ones are not kept anywhere (AG-185).
      const boardNotes = await tx.agendaEntry.findMany({
        where: { patientId: { in: ids }, boardNote: { not: null } },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        select: {
          patientId: true,
          startsAt: true,
          boardNote: true,
          boardNoteAt: true,
        },
      });
      // PD-048 (D-131.1). The saved versions of the subject's rows; PD-067
      // (D-203 §10), the clinical ones only as far as the caller's
      // `record:read` reaches, with the shared rule of the key.
      const scope = requester.recordScope ?? [];
      const keyed = holdsRecordKey(scope, await copySitesOf(tx, rootId));
      const versions = await recordVersionsOfChart(tx, rootId, {
        recordScope: scope,
        holdsKey: keyed,
      });
      const clinicalOmission = await clinicalVersionsOmission(
        tx,
        rootId,
        scope,
        keyed,
      );
      const concepts = await conceptsOf(tx, charts);
      const mrnOf = new Map(charts.map((chart) => [chart.id, chart.mrn]));
      const main = charts.find((chart) => chart.id === rootId)!;

      // PD-043. In the same transaction as the reads: if this row cannot be
      // written, the transaction fails and the document is never returned.
      // One row per chart whose data left, the absorbed ones included: the
      // trail of a chart absorbed later must still show that its data was
      // handed over.
      for (const chartId of ids) {
        await writeTrail(
          tx,
          { resourceType: 'patient', resourceId: chartId, action: 'EXPORT' },
          requester,
        );
      }
      // And which request it answered: the trail says not only whose data
      // left, but why (Reglamento D.E. 904 art. 15, «el detalle de la
      // atención dada»).
      await writeTrail(
        tx,
        {
          resourceType: 'data_subject_request',
          resourceId: requestId,
          action: 'EXPORT',
        },
        requester,
      );

      return {
        format: 'clinica.privacy.export',
        // 3: `authorizations` instead of `consents` (D-221).
        formatVersion: 3,
        generatedAt: now.toISOString(),
        patient: {
          ...exportedPatient(main, concepts),
          mergedCharts: charts
            .filter((chart) => chart.id !== rootId)
            .map((chart) => ({ mrn: chart.mrn, mergedAt: chart.mergedAt })),
        },
        identifiers: identifiers.map((row) => ({
          chart: mrnOf.get(row.patientId),
          type: row.type,
          issuingCountry: row.issuingCountry,
          value: row.value,
          use: row.use,
          validFrom: row.validFrom && toClinicalDate(row.validFrom),
          validTo: row.validTo && toClinicalDate(row.validTo),
        })),
        // PD-040, PD-073. Every authorization, the revoked ones too: what
        // the holder allowed and when they withdrew it.
        authorizations: authorizations.map((row) => ({
          chart: mrnOf.get(row.patientId),
          purpose: row.purpose,
          channel: row.channel,
          recordedAt: row.recordedAt.toISOString(),
          recordedBy: nameOf(authorizationStaff, row.recordedBy).fullName,
          revokedAt: row.revocation?.revokedAt.toISOString() ?? null,
          revokedBy: row.revocation
            ? nameOf(authorizationStaff, row.revocation.revokedBy).fullName
            : null,
        })),
        requests: requests.map((row) => ({
          chart: mrnOf.get(row.patientId),
          right: row.right,
          requestedBy: row.requestedBy,
          // PD-066. Of an authority, never the text of what it asked.
          description: row.requestedBy === 'AUTHORITY' ? null : row.description,
          receivedAt: row.receivedAt.toISOString(),
          // Format v1 says a date; the instant is the request's (PD-054).
          dueOn: row.dueOn,
          // PD-047. The answer that stands, and the ones it rectified.
          outcome: row.answer?.outcome ?? null,
          response: row.answer?.response ?? null,
          answeredAt: row.answer?.answeredAt.toISOString() ?? null,
          previousAnswers: row.previousAnswers.map((previous) => ({
            outcome: previous.outcome,
            response: previous.response,
            answeredAt: previous.answeredAt.toISOString(),
          })),
        })),
        // PD-076. Without who wrote it: what the holder is owed is what was
        // said about them; the author is in the clinic's own trail.
        boardNotes: boardNotes.map((row) => ({
          chart: row.patientId ? mrnOf.get(row.patientId) : undefined,
          appointmentStartsAt: row.startsAt.toISOString(),
          note: row.boardNote,
          writtenAt: row.boardNoteAt?.toISOString() ?? null,
        })),
        // PD-066 (D-203 §9). Each copy of the record that was authorised.
        deliveries: requests
          .filter(
            (row) =>
              row.clinicalRecordCopy &&
              (row.answer?.outcome === 'GRANTED' ||
                row.answer?.outcome === 'PARTIALLY_GRANTED'),
          )
          .map((row) => deliveryOf(row, mrnOf.get(row.patientId))),
        versions,
        omitted: clinicalOmission ? [...omitted, clinicalOmission] : omitted,
      };
    });
  }

  private async views(db: Db, rows: RequestRow[]): Promise<DataRequestView[]> {
    // PD-047. The rectified answers, read once for the whole list.
    const corrections =
      rows.length === 0
        ? []
        : await db.dataSubjectAnswerCorrection.findMany({
            where: { requestId: { in: rows.map((row) => row.id) } },
          });
    const [staff, patients] = await Promise.all([
      staffNames(db, [
        ...rows.flatMap((row) => [
          row.registeredBy,
          row.answeredBy,
          row.changedBy,
        ]),
        ...corrections.map((row) => row.answeredBy),
        ...rows.flatMap((row) =>
          row.copyReviews.map((review) => review.reviewedBy),
        ),
      ]),
      patientNames(
        db,
        rows.map((row) => row.patientId),
      ),
    ]);
    // D-203 §1, §5. On a copy, the person's sites and whether the record holds
    // something sensitive — one after another: `db` may be a transaction.
    const copyFacts = new Map<
      string,
      { sites: string[]; sensitive: boolean }
    >();
    for (const row of rows) {
      if (!row.clinicalRecordCopy) continue;
      copyFacts.set(row.id, {
        sites: await copySitesOf(db, row.patientId),
        sensitive:
          row.requestedBy !== 'HOLDER' &&
          (await sensitiveFactsOf(db, row.patientId)).sensitiveSites.length >
            0 &&
          !(await reviewStands(db, row.id)),
      });
    }
    return rows.map((row) => {
      const facts = copyFacts.get(row.id);
      const latest = row.copyReviews[0];
      const review: CopyReviewView | null = latest
        ? {
            reviewedAt: latest.reviewedAt,
            reviewedBy: nameOf(staff, latest.reviewedBy),
            includesScreening: latest.includesScreening,
          }
        : null;
      const answers = answerChain(
        row,
        corrections.filter((correction) => correction.requestId === row.id),
        staff,
      );
      return {
        id: row.id,
        patientId: row.patientId,
        patient: patients.get(row.patientId) ?? { mrn: '—', fullName: '—' },
        right: row.right,
        requestedBy: row.requestedBy,
        requesterName: row.requesterName,
        requesterDocument: row.requesterDocument,
        requesterRelationship: row.requesterRelationship,
        clinicalRecordCopy: row.clinicalRecordCopy,
        documentsChecked: row.documentsChecked,
        description: row.description,
        receivedAt: row.receivedAt,
        review,
        reviewRequired: facts?.sensitive ?? false,
        copySites: facts?.sites ?? [],
        dueAt: row.dueAt,
        dueOn: lastDayOnTime(row.dueAt),
        registeredAt: row.registeredAt,
        registeredBy: nameOf(staff, row.registeredBy),
        answer: answers.at(-1) ?? null,
        previousAnswers: answers.slice(0, -1).reverse(),
        changedBy: row.changedBy ? nameOf(staff, row.changedBy) : null,
        changedAt: row.changedAt,
      };
    });
  }
}

/**
 * PD-047. The answers of one request, oldest first: the original on the row,
 * then each rectification after the one it corrects. The last one stands.
 */
function answerChain(
  row: RequestRow,
  corrections: {
    id: string;
    correctsId: string | null;
    outcome: DataRequestOutcome;
    response: string;
    answeredAt: Date;
    answeredBy: string;
    copyFrom: Date | null;
    copyTo: Date | null;
  }[],
  staff: Map<string, StaffName>,
): DataRequestAnswer[] {
  if (!(row.outcome && row.response && row.answeredAt && row.answeredBy)) {
    return [];
  }
  const chain: DataRequestAnswer[] = [
    {
      outcome: row.outcome,
      response: row.response,
      answeredAt: row.answeredAt,
      answeredBy: nameOf(staff, row.answeredBy),
      isCorrection: false,
      copyPeriod: periodOf(row.copyFrom, row.copyTo),
    },
  ];
  const next = new Map(corrections.map((c) => [c.correctsId, c]));
  for (
    let correction = next.get(null);
    correction !== undefined;
    correction = next.get(correction.id)
  ) {
    chain.push({
      outcome: correction.outcome,
      response: correction.response,
      answeredAt: correction.answeredAt,
      answeredBy: nameOf(staff, correction.answeredBy),
      isCorrection: true,
      copyPeriod: periodOf(correction.copyFrom, correction.copyTo),
    });
  }
  return chain;
}

/**
 * PD-066 (D-203 §9; LOPDP arts. 12.10 and 13; 45 CFR 164.528). One delivery
 * of the copy as the holder reads it: when it was authorised, to whom and of
 * what class, what (the whole record or a period) and why. Of an authority,
 * only its name and the number of its letter; of anybody else, never their
 * cedula, which is another person's datum.
 */
function deliveryOf(
  row: DataRequestView,
  chart: string | undefined,
): Record<string, unknown> {
  const answer = row.answer!;
  const authority = row.requestedBy === 'AUTHORITY';
  return {
    chart,
    authorisedAt: answer.answeredAt.toISOString(),
    recipientClass: row.requestedBy,
    recipientName: row.requestedBy === 'HOLDER' ? null : row.requesterName,
    recipientRelationship: row.requesterRelationship,
    officialLetter: authority ? row.requesterDocument : null,
    scope: answer.copyPeriod
      ? {
          kind: 'PERIOD',
          from: answer.copyPeriod.from,
          to: answer.copyPeriod.to,
        }
      : { kind: 'COMPLETE' },
    purpose: authority ? null : row.description,
  };
}

/**
 * PD-067 (D-203 §10). What `omitted` says when clinical versions stayed out:
 * all of them, without the key; or those of the sites beyond the caller's
 * `record:read`, when the person was attended there. `null` when none did.
 */
async function clinicalVersionsOmission(
  db: Db,
  chartId: string,
  scope: RecordReadScope,
  keyed: boolean,
): Promise<ExportOmission | null> {
  if (scope === 'all') return null;
  if (scope.length === 0 || !keyed) {
    return {
      section: 'clinical_versions',
      reason:
        'Las versiones anteriores de la historia clínica (atenciones, signos vitales, diagnósticos, procedimientos, embarazo, lactancia, vacunas, suplementos, alergias, antecedentes y avisos de resultados críticos) no van: quien generó este archivo no tiene acceso a la historia clínica del paciente (D-203 §10).',
    };
  }
  const elsewhere = await db.encounter.findFirst({
    where: {
      ...chartScope(chartId),
      status: { not: 'ENTERED_IN_ERROR' },
      siteId: { notIn: [...scope] },
    },
    select: { id: true },
  });
  if (!elsewhere) return null;
  return {
    section: 'clinical_versions',
    reason:
      'Las versiones anteriores de las atenciones de otras sedes, con sus signos vitales, diagnósticos, procedimientos, datos de embarazo, lactancia, vacunas, suplementos y avisos de resultados críticos, no van: quien generó este archivo no tiene acceso a la historia clínica de esas sedes (D-203 §10).',
  };
}

/** PD-059. The period columns of an answer. */
function periodColumns(period: CopyPeriod | null): {
  copyFrom: Date | null;
  copyTo: Date | null;
} {
  return {
    copyFrom: period && fromClinicalDate(period.from),
    copyTo: period && fromClinicalDate(period.to),
  };
}

/** PD-059. The period as the answer says it. */
function periodOf(from: Date | null, to: Date | null): CopyPeriod | null {
  return from && to
    ? { from: toClinicalDate(from), to: toClinicalDate(to) }
    : null;
}

/**
 * D-203 §1. The PERSON's sites, from the chart the request was written on up
 * to the one in force and down to its absorbed ones (PA-055): those where a
 * copy would carry a signed attention.
 */
async function copySitesOf(db: Db, patientId: string): Promise<string[]> {
  const attentions = await db.encounter.findMany({
    where: {
      ...chartScopeOfSurvivor(patientId),
      status: { not: 'ENTERED_IN_ERROR' },
      notes: { some: { formCode: '002', status: 'SIGNED' } },
    },
    distinct: ['siteId'],
    select: { siteId: true },
  });
  return attentions.map((one) => one.siteId);
}

/**
 * PD-061, PD-062 (D-203 §5, §6). What the record of the person holds that a
 * copy for somebody else waits a professional's review for: the sites of the
 * attentions that stand with a violence screening with signs or a diagnosis
 * of the sensitive groups (`SENSITIVE_CIE10_PATTERN`), and when the last one
 * was recorded; and `reviewSites`, where whoever reviews must hold
 * `record:protected` —those, and the ones with any screening answered, which
 * «Incluir el tamizaje» would hand over—.
 */
async function sensitiveFactsOf(
  db: Db,
  patientId: string,
): Promise<{
  sensitiveSites: string[];
  reviewSites: string[];
  latestAt: Date | null;
}> {
  const attentions = await db.encounter.findMany({
    where: {
      ...chartScopeOfSurvivor(patientId),
      status: { not: 'ENTERED_IN_ERROR' },
    },
    select: { id: true },
  });
  if (attentions.length === 0) {
    return { sensitiveSites: [], reviewSites: [], latestAt: null };
  }
  const ids = attentions.map((one) => one.id);
  const rows = await db.$queryRaw<
    { site_id: string; sensitive: boolean; at: Date }[]
  >`
    SELECT e.site_id::text AS site_id,
           v.result IN ('SUSPECTED', 'CONFIRMED') AS sensitive,
           v.screened_at AS at
      FROM violence_screening v
      JOIN encounter e ON e.id = v.encounter_id
     WHERE v.encounter_id = ANY(${ids}::uuid[])
       AND v.result <> 'NOT_APPLIED'
    UNION ALL
    SELECT e.site_id::text, true, greatest(d.recorded_at, coalesce(d.edited_at, d.recorded_at))
      FROM encounter_diagnosis d
      JOIN encounter e ON e.id = d.encounter_id
     WHERE d.encounter_id = ANY(${ids}::uuid[])
       AND upper(d.cie10_code) ~ ${SENSITIVE_CIE10_PATTERN}`;
  const sensitive = rows.filter((row) => row.sensitive);
  const latest = sensitive.reduce<Date | null>(
    (max, row) => (max === null || row.at > max ? row.at : max),
    null,
  );
  return {
    sensitiveSites: [...new Set(sensitive.map((row) => row.site_id))],
    reviewSites: [...new Set(rows.map((row) => row.site_id))],
    latestAt: latest,
  };
}

/**
 * PD-062. Whether granting this copy waits for a review it does not have: the
 * record holds something sensitive and no review stands.
 */
async function reviewMissing(db: Db, requestId: string): Promise<boolean> {
  const request = await db.dataSubjectRequest.findUnique({
    where: { id: requestId },
    select: { patientId: true },
  });
  if (!request) return false;
  const { sensitiveSites } = await sensitiveFactsOf(db, request.patientId);
  return sensitiveSites.length > 0 && !(await reviewStands(db, requestId));
}

/**
 * PD-061 (revisión del 10-10-2026). Whether the copy holds a review that still
 * stands: the latest one, given after the last sensitive datum recorded. One
 * given before something sensitive appeared did not see it.
 */
async function reviewStands(db: Db, requestId: string): Promise<boolean> {
  const request = await db.dataSubjectRequest.findUnique({
    where: { id: requestId },
    select: {
      patientId: true,
      copyReviews: {
        orderBy: { reviewedAt: 'desc' },
        take: 1,
        select: { reviewedAt: true },
      },
    },
  });
  const latest = request?.copyReviews[0];
  if (!request || !latest) return false;
  const { latestAt } = await sensitiveFactsOf(db, request.patientId);
  return latestAt === null || latestAt <= latest.reviewedAt;
}

/** PD-047. The outcome that stands: the last rectification, or the original. */
async function standingOutcome(
  tx: Prisma.TransactionClient,
  requestId: string,
  original: DataRequestOutcome | null,
): Promise<DataRequestOutcome | null> {
  const standing = await tx.dataSubjectAnswerCorrection.findFirst({
    where: { requestId, correctedBy: null },
    select: { outcome: true },
  });
  return standing?.outcome ?? original;
}

/** The request under its row lock, with what the edit and the answer compare. */
/** PD-032. The clinic-wide holidays between two dates, on any client. */
async function clinicWideHolidaysIn(
  db: Prisma.TransactionClient | PrismaService,
  from: ClinicalDate,
  to: ClinicalDate,
): Promise<Set<string>> {
  const rows = await db.holiday.findMany({
    where: {
      siteId: null,
      date: { gte: fromClinicalDate(from), lte: fromClinicalDate(to) },
    },
    select: { date: true },
  });
  return new Set(rows.map((row) => toClinicalDate(row.date)));
}

async function lockRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<{
  right: DataRequestView['right'];
  description: string;
  received_at: Date;
  due_at: Date;
  clinical_record_copy: boolean;
  outcome: DataRequestOutcome | null;
  changed_at: Date | null;
} | null> {
  const [row] = await tx.$queryRaw<
    {
      right: DataRequestView['right'];
      description: string;
      received_at: Date;
      due_at: Date;
      clinical_record_copy: boolean;
      outcome: DataRequestOutcome | null;
      changed_at: Date | null;
    }[]
  >`
    SELECT "right", description, received_at, due_at, clinical_record_copy,
           outcome, changed_at
      FROM data_subject_request
     WHERE id = ${requestId}::uuid
       FOR UPDATE`;
  return row ?? null;
}

/**
 * EN-210. A stamp the archive trigger accepts: later than the previous one,
 * even within the same millisecond of the app's clock.
 */
function stampAfter(previous: Date | null, now: Date): Date {
  return previous && previous >= now ? new Date(previous.getTime() + 1) : now;
}

/**
 * The administrative chart as it is exported (PD-040). EXCLUDED ON PURPOSE:
 * `sexualOrientationConceptId` (PA-058) — see `EXPORT_OMISSIONS`.
 */
const EXPORTED_PATIENT = {
  id: true,
  mrn: true,
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  sex: true,
  birthDate: true,
  birthDateEstimated: true,
  deceasedAt: true,
  genderIdentityConceptId: true,
  ethnicityConceptId: true,
  nationalityConceptId: true,
  peopleConceptId: true,
  countryOfNationalityCode: true,
  residenceParishConceptId: true,
  residenceAddressLine: true,
  phone: true,
  email: true,
  bloodType: true,
  isProvisional: true,
  mergedAt: true,
  createdAt: true,
} satisfies Prisma.PatientSelect;

type ExportedPatientRow = Prisma.PatientGetPayload<{
  select: typeof EXPORTED_PATIENT;
}>;

interface Concept {
  code: string;
  display: string;
}

async function conceptsOf(
  db: Db,
  charts: ExportedPatientRow[],
): Promise<Map<string, Concept>> {
  const ids = charts.flatMap((chart) => [
    chart.genderIdentityConceptId,
    chart.ethnicityConceptId,
    chart.nationalityConceptId,
    chart.peopleConceptId,
    chart.residenceParishConceptId,
  ]);
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db.catalogConcept.findMany({
    where: { id: { in: wanted } },
    select: { id: true, code: true, display: true },
  });
  return new Map(
    rows.map((row) => [row.id, { code: row.code, display: row.display }]),
  );
}

/** Codes WITH their wording: an export of bare identifiers is not legible. */
function exportedPatient(
  row: ExportedPatientRow,
  concepts: Map<string, Concept>,
): Record<string, unknown> {
  const concept = (id: string | null) =>
    id ? (concepts.get(id) ?? null) : null;
  return {
    mrn: row.mrn,
    familyName: row.familyName,
    secondFamilyName: row.secondFamilyName,
    givenName: row.givenName,
    secondGivenName: row.secondGivenName,
    sex: row.sex,
    birthDate: toClinicalDate(row.birthDate),
    birthDateEstimated: row.birthDateEstimated,
    deceasedAt: row.deceasedAt?.toISOString() ?? null,
    genderIdentity: concept(row.genderIdentityConceptId),
    ethnicity: concept(row.ethnicityConceptId),
    indigenousNationality: concept(row.nationalityConceptId),
    people: concept(row.peopleConceptId),
    countryOfNationality: row.countryOfNationalityCode,
    residenceParish: concept(row.residenceParishConceptId),
    residenceAddressLine: row.residenceAddressLine,
    phone: row.phone,
    email: row.email,
    bloodType: row.bloodType,
    isProvisional: row.isProvisional,
    registeredAt: row.createdAt.toISOString(),
  };
}
