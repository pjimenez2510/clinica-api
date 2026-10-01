import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  AnswerResult,
  ChartLookup,
  DataExportDocument,
  DataRequestOutcome,
  DataRequestView,
  DataSubjectRequestRepository,
  ExportOmission,
  NewDataRequest,
  Requester,
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

type RequestRow = Prisma.DataSubjectRequestGetPayload<object>;

@Injectable()
export class PrismaDataSubjectRequestRepository implements DataSubjectRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  chartOf(patientId: string): Promise<ChartLookup> {
    return chartLookup(this.prisma, patientId);
  }

  async clinicWideHolidays(
    from: ClinicalDate,
    to: ClinicalDate,
  ): Promise<Set<string>> {
    const rows = await this.prisma.holiday.findMany({
      where: {
        siteId: null,
        date: { gte: fromClinicalDate(from), lte: fromClinicalDate(to) },
      },
      select: { date: true },
    });
    return new Set(rows.map((row) => toClinicalDate(row.date)));
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
  ): Promise<AnswerResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      // The `outcome IS NULL` in the WHERE is what makes a second answer lose
      // cleanly: it waits on the row lock, then matches nothing.
      const { count } = await tx.dataSubjectRequest.updateMany({
        where: { id: requestId, outcome: null },
        data: {
          outcome: answer.outcome,
          response: answer.response,
          answeredAt: new Date(),
          answeredBy: requester.userId,
        },
      });
      if (count === 0) {
        const exists = await tx.dataSubjectRequest.findUnique({
          where: { id: requestId },
          select: { id: true },
        });
        return exists
          ? ({ status: 'already-answered' } as const)
          : ({ status: 'missing' } as const);
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
        include: { textVersion: { select: CONSENT_TEXT_SELECT } },
      });
      const requests = await tx.dataSubjectRequest.findMany({
        where: chartScope(rootId),
        orderBy: { receivedAt: 'asc' },
      });
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
        })),
        requests: requests.map((row) => ({
          chart: mrnOf.get(row.patientId),
          right: row.right,
          requestedBy: row.requestedBy,
          description: row.description,
          receivedAt: row.receivedAt.toISOString(),
          dueOn: toClinicalDate(row.dueOn),
          outcome: row.outcome,
          response: row.response,
          answeredAt: row.answeredAt?.toISOString() ?? null,
        })),
        omitted,
      };
    });
  }

  private async views(db: Db, rows: RequestRow[]): Promise<DataRequestView[]> {
    const [staff, patients] = await Promise.all([
      staffNames(
        db,
        rows.flatMap((row) => [row.registeredBy, row.answeredBy]),
      ),
      patientNames(
        db,
        rows.map((row) => row.patientId),
      ),
    ]);
    return rows.map((row) => ({
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
      answer:
        row.outcome && row.response && row.answeredAt && row.answeredBy
          ? {
              outcome: row.outcome,
              response: row.response,
              answeredAt: row.answeredAt,
              answeredBy: nameOf(staff, row.answeredBy),
            }
          : null,
    }));
  }
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
