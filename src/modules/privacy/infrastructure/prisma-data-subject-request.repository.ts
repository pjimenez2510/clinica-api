import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  AnswerResult,
  ChartLookup,
  CorrectAnswerResult,
  DataExportDocument,
  DataRequestAnswer,
  DataRequestChanges,
  DataRequestOutcome,
  DataRequestView,
  DataSubjectRequestRepository,
  EditRequestResult,
  ExportOmission,
  NewDataRequest,
  Requester,
  StaffName,
} from '../domain/privacy.repository';

import {
  CONSENT_TEXT_SELECT,
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
  legalDueDate,
  type DataSubjectRight,
} from '../domain/legal-due-date';

import { recordVersionsOfChart } from './record-version-subjects';

type RequestRow = Prisma.DataSubjectRequestGetPayload<object>;

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
          description: request.description,
          // Absent = «ahora» as the BASE reads it, the same `now()` as
          // `registered_at`: an application clock a few milliseconds ahead
          // of the database's would otherwise trip the not-future CHECK.
          receivedAt: request.receivedAt,
          dueOn: fromClinicalDate(request.dueOn),
          registeredBy: requester.userId,
        },
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
    answer: { outcome: DataRequestOutcome; response: string },
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
      await tx.dataSubjectRequest.update({
        where: { id: requestId },
        data: {
          outcome: answer.outcome,
          response: answer.response,
          answeredAt: now,
          answeredBy: requester.userId,
          // PD-046: answering is an UPDATE like any other, stamped, so the
          // unanswered request stays as a version.
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
        const holidays = await clinicWideHolidaysIn(
          tx,
          receivedOn,
          addDays(receivedOn, DUE_DATE_HORIZON_DAYS),
        );
        const dueOn = legalDueDate(right, receivedOn, holidays);
        if (dueOn !== toClinicalDate(current.due_on)) {
          data.dueOn = fromClinicalDate(dueOn);
        }
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
    answer: { outcome: DataRequestOutcome; response: string },
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
      const standing = await tx.dataSubjectAnswerCorrection.findFirst({
        where: { requestId, correctedBy: null },
        select: { id: true },
      });
      await tx.dataSubjectAnswerCorrection.create({
        data: {
          requestId,
          correctsId: standing?.id ?? null,
          outcome: answer.outcome,
          response: answer.response,
          answeredAt: now,
          answeredBy: requester.userId,
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
      return { status: 'corrected' } as const;
    });

    if (outcome.status !== 'corrected') return outcome;
    const request = await this.find(requestId);
    return { status: 'corrected', request: request! };
  }

  async rightOf(requestId: string): Promise<DataSubjectRight | null> {
    const row = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
      select: { right: true },
    });
    return row?.right ?? null;
  }

  async find(requestId: string): Promise<DataRequestView | null> {
    const row = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) return null;
    const [view] = await this.views(this.prisma, [row]);
    return view!;
  }

  async requestsOf(patientId: string): Promise<DataRequestView[]> {
    const rows = await this.prisma.dataSubjectRequest.findMany({
      where: chartScope(patientId),
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    });
    return this.views(this.prisma, rows);
  }

  async open(): Promise<DataRequestView[]> {
    const rows = await this.prisma.dataSubjectRequest.findMany({
      where: { outcome: null },
      orderBy: [{ dueOn: 'asc' }, { receivedAt: 'asc' }],
    });
    return this.views(this.prisma, rows);
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
      const consents = await tx.patientConsent.findMany({
        where: chartScope(rootId),
        orderBy: { recordedAt: 'asc' },
        include: {
          textVersion: { select: CONSENT_TEXT_SELECT },
          supersededBy: { select: { id: true } },
        },
      });
      const requestRows = await tx.dataSubjectRequest.findMany({
        where: chartScope(rootId),
        orderBy: { receivedAt: 'asc' },
      });
      const requests = await this.views(tx, requestRows);
      // PD-048 (D-131.1). The saved versions of the subject's rows.
      const versions = await recordVersionsOfChart(tx, rootId);
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
        formatVersion: 1,
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
        consents: consents.map((row) => ({
          chart: mrnOf.get(row.patientId),
          recordedAt: row.recordedAt.toISOString(),
          medium: row.medium,
          grantedBy: row.grantedBy,
          textVersion: row.textVersion.version,
          text: row.textVersion.body,
          // PD-044. A correction says it is one, and the corrected one says
          // it no longer stands; both leave, nothing is hidden.
          isCorrection: row.supersedesId !== null,
          isSuperseded: row.supersededBy !== null,
        })),
        requests: requests.map((row) => ({
          chart: mrnOf.get(row.patientId),
          right: row.right,
          requestedBy: row.requestedBy,
          description: row.description,
          receivedAt: row.receivedAt.toISOString(),
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
        versions,
        omitted,
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
      ]),
      patientNames(
        db,
        rows.map((row) => row.patientId),
      ),
    ]);
    return rows.map((row) => {
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
        description: row.description,
        receivedAt: row.receivedAt,
        dueOn: toClinicalDate(row.dueOn),
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
    });
  }
  return chain;
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
  due_on: Date;
  outcome: DataRequestOutcome | null;
  changed_at: Date | null;
} | null> {
  const [row] = await tx.$queryRaw<
    {
      right: DataRequestView['right'];
      description: string;
      received_at: Date;
      due_on: Date;
      outcome: DataRequestOutcome | null;
      changed_at: Date | null;
    }[]
  >`
    SELECT "right", description, received_at, due_on, outcome, changed_at
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
