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
          _count: { select: { diagnoses: true } },
        },
      });
      if (!encounter) throw new CertificateEncounterNotFoundError();

      const plan = decide({
        encounterStatus: encounter.status,
        diagnosisCount: encounter._count.diagnoses,
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

  /** CER-010. One certificate within the caller's scope, or `null`. */
  async findById(query: CertificateQuery): Promise<CertificateView | null> {
    const row = await this.prisma.medicalCertificate.findFirst({
      where: { id: query.certificateId, ...siteFilter(query.sites) },
      select: CERTIFICATE_SELECT,
    });
    return row === null ? null : toView(row);
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
    revokedAt: row.revokedAt,
    revokedById: row.revokedById,
    revocationReason: row.revocationReason,
  };
}
