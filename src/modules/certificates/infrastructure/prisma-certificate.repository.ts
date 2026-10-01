import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  CertificateAlreadyRevokedError,
  CertificateEncounterNotFoundError,
  CertificateNotFoundError,
} from '../domain/certificate.errors';
import type {
  CertificatePlan,
  CertificateQuery,
  CertificateRepository,
  CertificateView,
  CertifierIdentity,
  EncounterCertificatesQuery,
  IssueSnapshot,
  RevocationPlan,
  SiteScopeFilter,
} from '../domain/certificate.repository';
import type { Form117Source } from '../../../shared/domain/form-117/form-117';

/**
 * The certificate's rows in, domain shapes out.
 *
 * ⚠️ THE ADAPTER IS NOT THE GUARANTEE OF THE NUMBER, OF THE PERIOD OR OF THE
 * ANNULMENT. `medical_certificate_number_assigned`,
 * `medical_certificate_rest_range` and
 * `medical_certificate_revocation_states_who_when_and_why` are the database's,
 * and they also stop an import and a `psql`. What this file adds is reading
 * the attention inside the transaction that writes, and the conditional update
 * that decides who wins an annulment.
 */

const CERTIFICATE_SELECT = {
  id: true,
  encounterId: true,
  patientId: true,
  issuedById: true,
  type: true,
  number: true,
  verificationCode: true,
  issuedAt: true,
  restFrom: true,
  restTo: true,
  includeDiagnosis: true,
  contingencyType: true,
  maternityAdmissionOn: true,
  birthOn: true,
  maternityDischargeOn: true,
  restBackdatingReason: true,
  revokedAt: true,
  revokedById: true,
  revocationReason: true,
} satisfies Prisma.MedicalCertificateSelect;

/** The shape `CERTIFICATE_SELECT` produces. */
type CertificateRow = Prisma.MedicalCertificateGetPayload<{
  select: typeof CERTIFICATE_SELECT;
}>;

/** The `CertificateRepository` adapter. */
@Injectable()
export class PrismaCertificateRepository implements CertificateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** CER-004. The caller's ACTIVE clinical profile. */
  async findCertifierByUser(userId: string): Promise<CertifierIdentity | null> {
    const practitioner = await this.prisma.practitioner.findFirst({
      where: { userId, active: true },
      select: { id: true },
    });
    return practitioner === null ? null : { practitionerId: practitioner.id };
  }

  /** CER-002, CER-010. Whether the attention exists within the scope. */
  async encounterExists(query: EncounterCertificatesQuery): Promise<boolean> {
    const encounter = await this.prisma.encounter.findFirst({
      where: { id: query.encounterId, ...encounterSiteFilter(query.sites) },
      select: { id: true },
    });
    return encounter !== null;
  }

  /**
   * CER-001 to CER-009. The attention is read and the row inserted in ONE
   * transaction, so a close or a removed diagnosis between the two cannot
   * slip through; the number is assigned by the trigger inside the same
   * transaction, so a rolled-back issue gives it back.
   */
  async issue(
    query: EncounterCertificatesQuery,
    decide: (snapshot: IssueSnapshot) => CertificatePlan,
  ): Promise<CertificateView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const encounter = await tx.encounter.findFirst({
        where: { id: query.encounterId, ...encounterSiteFilter(query.sites) },
        select: {
          id: true,
          siteId: true,
          patientId: true,
          status: true,
          startedAt: true,
          _count: { select: { diagnoses: true } },
          // CER-036. The city is the CANTON: the parent of the site's DPA
          // parish, as PR-021 reads it.
          site: {
            select: {
              parish: { select: { parent: { select: { display: true } } } },
            },
          },
        },
      });
      if (!encounter) throw new CertificateEncounterNotFoundError();

      const plan = decide({
        encounterStatus: encounter.status,
        diagnosisCount: encounter._count.diagnoses,
        encounterStartedAt: encounter.startedAt,
        cityOfIssue: encounter.site.parish?.parent?.display ?? null,
      });

      return tx.medicalCertificate.create({
        data: {
          encounterId: encounter.id,
          // CER-009. `medical_certificate_number_assigned` takes it from the
          // attention whatever is sent; sending the right one keeps Prisma's
          // type honest.
          siteId: encounter.siteId,
          // CER-001. The patient OF THE ATTENTION, never one of the request.
          patientId: encounter.patientId,
          issuedById: plan.issuedById,
          type: plan.type,
          restFrom: plan.rest === null ? null : dateColumn(plan.rest.from),
          restTo: plan.rest === null ? null : dateColumn(plan.rest.to),
          includeDiagnosis: plan.includeDiagnosis,
          contingencyType: plan.contingencyType,
          maternityAdmissionOn: optionalDate(plan.maternity?.admissionOn),
          birthOn: optionalDate(plan.maternity?.birthOn),
          maternityDischargeOn: optionalDate(plan.maternity?.dischargeOn),
          restBackdatingReason: plan.backdatingReason,
          verificationCode: plan.verificationCode,
          issuedAt: plan.issuedAt,
        },
        select: CERTIFICATE_SELECT,
      });
    });

    return toView(row);
  }

  /** CER-010. The certificates of one attention, newest first. */
  async listOfEncounter(
    query: EncounterCertificatesQuery,
  ): Promise<CertificateView[]> {
    const rows = await this.prisma.medicalCertificate.findMany({
      where: { encounterId: query.encounterId, ...siteFilter(query.sites) },
      orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
      select: CERTIFICATE_SELECT,
    });
    return rows.map(toView);
  }

  /**
   * CER-010, CER-020 to CER-029. Everything form 117 prints, in ONE statement
   * (`relationJoins` is on), so the answers describe the same instant.
   */
  async form117SourceOf(
    query: CertificateQuery,
  ): Promise<Form117Source | null> {
    const row = await this.prisma.medicalCertificate.findFirst({
      where: { id: query.certificateId, ...siteFilter(query.sites) },
      select: {
        ...CERTIFICATE_SELECT,
        // CER-020. The site is the «establecimiento de salud», with its own
        // unicódigo (D-074).
        // CER-036, CER-037. The canton for the place of issue, and the
        // address and phone of the letterhead. The establishment has none of
        // the three in the schema, so there is nothing to fall back to.
        site: {
          select: {
            name: true,
            mspUnicode: true,
            addressLine: true,
            phone: true,
            parish: { select: { parent: { select: { display: true } } } },
          },
        },
        patient: {
          select: {
            familyName: true,
            secondFamilyName: true,
            givenName: true,
            secondGivenName: true,
            sex: true,
            mrn: true,
            // CER-020. The official documents still in force on this chart;
            // the domain picks the one the instructivo names.
            identifiers: {
              where: { use: 'OFFICIAL', patientMerged: false },
              select: { type: true, value: true },
            },
          },
        },
        encounter: {
          select: {
            startedAt: true,
            endedAt: true,
            // CER-021. The FROZEN age of the attention, never today's.
            ageYears: true,
            ageMonths: true,
            ageDays: true,
            // CER-027. Principal first, with the code and description
            // `trg_diagnosis_snapshot` froze.
            diagnoses: {
              orderBy: [{ rank: 'asc' }, { recordedAt: 'asc' }],
              select: { cie10Code: true, cie10Display: true },
            },
          },
        },
        issuedBy: {
          select: {
            // CER-028. Whether there is a seal; the image itself is
            // `documents`'. The drawn signature is deliberately NOT read.
            sealImageId: true,
            user: {
              select: { firstName: true, lastName: true, cedula: true },
            },
            // CER-022. The PRIMARY specialty, if any.
            specialties: {
              where: { isPrimary: true },
              select: { specialty: { select: { name: true } } },
              take: 1,
            },
          },
        },
      },
    });
    if (row === null) return null;

    const view = toView(row);
    return {
      certificate: view,
      site: {
        name: row.site.name,
        mspUnicode: row.site.mspUnicode,
        city: row.site.parish?.parent?.display ?? null,
        address: row.site.addressLine,
        phone: row.site.phone,
      },
      patient: {
        familyName: row.patient.familyName,
        secondFamilyName: row.patient.secondFamilyName,
        givenName: row.patient.givenName,
        secondGivenName: row.patient.secondGivenName,
        sex: row.patient.sex,
        mrn: row.patient.mrn,
        identifiers: row.patient.identifiers,
      },
      encounter: {
        startedAt: row.encounter.startedAt,
        endedAt: row.encounter.endedAt,
        ageYears: row.encounter.ageYears,
        ageMonths: row.encounter.ageMonths,
        ageDays: row.encounter.ageDays,
      },
      diagnoses: row.encounter.diagnoses.map((diagnosis) => ({
        code: diagnosis.cie10Code,
        display: diagnosis.cie10Display,
      })),
      practitioner: {
        givenNames: row.issuedBy.user.firstName,
        familyNames: row.issuedBy.user.lastName,
        cedula: row.issuedBy.user.cedula,
        primarySpecialty: row.issuedBy.specialties[0]?.specialty.name ?? null,
        hasSeal: row.issuedBy.sealImageId !== null,
      },
    };
  }

  /**
   * CER-011, CER-012. CONDITIONAL ON `revoked_at IS NULL`: of two people
   * annulling at once, the loser matches zero rows and is told it is already
   * annulled, never handed a second annulment that rewrites the first.
   */
  async revoke(
    query: CertificateQuery,
    plan: RevocationPlan,
  ): Promise<CertificateView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.medicalCertificate.findFirst({
        where: { id: query.certificateId, ...siteFilter(query.sites) },
        select: { id: true },
      });
      if (!current) throw new CertificateNotFoundError();

      const updated = await tx.medicalCertificate.updateMany({
        where: { id: current.id, revokedAt: null },
        data: {
          revokedAt: plan.revokedAt,
          revokedById: plan.revokedById,
          revocationReason: plan.reason,
        },
      });
      if (updated.count === 0) throw new CertificateAlreadyRevokedError();

      return tx.medicalCertificate.findUniqueOrThrow({
        where: { id: current.id },
        select: CERTIFICATE_SELECT,
      });
    });

    return toView(row);
  }
}

/**
 * CER-010. The caller's resolved scope as a `where` fragment on the
 * certificate. `'all'` yields no filter; an empty list never reaches here
 * (`siteScope` throws `SITE_SCOPE_DENIED` first).
 */
function siteFilter(
  sites: SiteScopeFilter,
): Prisma.MedicalCertificateWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/** The same scope when the row being read IS the attention. */
function encounterSiteFilter(
  sites: SiteScopeFilter,
): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/**
 * A calendar date as a `date` column takes it: midnight UTC of that day, which
 * the driver writes as exactly that date whatever the session's zone.
 */
function dateColumn(date: ClinicalDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** An optional calendar date for an optional `date` column. */
function optionalDate(date: ClinicalDate | undefined): Date | null {
  return date === undefined ? null : dateColumn(date);
}

/** A `date` column back to the calendar date it holds. */
function clinicalDateColumn(value: Date | null): ClinicalDate | null {
  return value === null ? null : (value.toISOString().slice(0, 10) as ClinicalDate); // prettier-ignore
}

/** A `medical_certificate` row as the domain reads it. */
function toView(row: CertificateRow): CertificateView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    patientId: row.patientId,
    issuedById: row.issuedById,
    type: row.type,
    number: row.number,
    verificationCode: row.verificationCode,
    issuedAt: row.issuedAt,
    restFrom: clinicalDateColumn(row.restFrom),
    restTo: clinicalDateColumn(row.restTo),
    includeDiagnosis: row.includeDiagnosis,
    contingencyType: row.contingencyType,
    maternity:
      row.maternityAdmissionOn === null ||
      row.birthOn === null ||
      row.maternityDischargeOn === null
        ? null
        : {
            admissionOn: clinicalDateColumn(row.maternityAdmissionOn) as ClinicalDate, // prettier-ignore
            birthOn: clinicalDateColumn(row.birthOn) as ClinicalDate,
            dischargeOn: clinicalDateColumn(row.maternityDischargeOn) as ClinicalDate, // prettier-ignore
          },
    backdatingReason: row.restBackdatingReason,
    revokedAt: row.revokedAt,
    revokedById: row.revokedById,
    revocationReason: row.revocationReason,
  };
}
