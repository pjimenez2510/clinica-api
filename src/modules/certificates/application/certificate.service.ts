import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';
import {
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  admitsNewCertificates,
  missingPatientWork,
  patientWorkNotice,
  assertIssuableType,
  assertRestStartsInTime,
  assertRestWithinAttention,
  assertMaternityWithinLeave,
  assertRestDoesNotOverlapMaternity,
  backdatingReasonOf,
  lateIssueDayOf,
  iessValidationOf,
  issuerReasonOf,
  restDetailsOf,
  restNoticesOf,
  type CertificateType,
  type ContingencyType,
  type IessValidation,
} from '../domain/certificate';
import {
  CertificateDiagnosisRequiredError,
  CertificateEncounterNotFoundError,
  CertificateEncounterNotOpenError,
  CertificateEstablishmentIncompleteError,
  CertificateNotFoundError,
  CertificateRevokeForbiddenError,
  CertifierProfileRequiredError,
  type PatientWorkField,
} from '../domain/certificate.errors';
import {
  composeForm117,
  type Form117,
} from '../../../shared/domain/form-117/form-117';
import {
  CERTIFICATE_CLOCK,
  CERTIFICATE_REPOSITORY,
  type CertificateClock,
  type CertificateRepository,
  type CertificateView,
  type SiteScopeFilter,
} from '../domain/certificate.repository';

/**
 * Its own resource type in the trail. «¿Quién abrió la atención?» and «¿quién
 * leyó el certificado de reposo?» are two questions, and the second is the one
 * an employer's inquiry asks.
 */
const RESOURCE_TYPE = 'certificate';

/**
 * CER-004, CER-010. Who is asking. Declared here and not imported: no module
 * imports another.
 */
export interface Requester {
  /** The account id. Never a cedula (REQ-110). */
  userId: string;
  /** The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  ip?: string;
  userAgent?: string;
}

/**
 * CER-001 to CER-008. What issuing a certificate needs to be told.
 *
 * ⚠️ THERE IS NO ISSUER HERE (CER-004): the issuer is the practitioner of the
 * session, never an identifier the caller supplies.
 */
export interface IssueCertificateRequest {
  encounterId: string;
  /** CER-005. Any value of the enum; only two are a form 117. */
  type: CertificateType;
  /** CER-006. Calendar dates in Ecuador, or `null`. */
  restFrom: ClinicalDate | null;
  restTo: ClinicalDate | null;
  /**
   * CER-007. Answered explicitly on every certificate; on a rest it has to be
   * `true` — the IESS does not validate a rest without its CIE-10.
   */
  includeDiagnosis: boolean;
  /** CER-034. Obligatory on a rest, refused on attendance. */
  contingencyType: ContingencyType | null;
  /** CER-035. The three, exactly with `MATERNITY`. */
  maternityAdmissionOn: ClinicalDate | null;
  birthOn: ClinicalDate | null;
  maternityDischargeOn: ClinicalDate | null;
  /**
   * CER-030. Demanded only when the rest starts before the attention or is
   * issued on a later day.
   */
  backdatingReason: string | null;
  /** CER-039. Demanded only when the issuer is not who attended. */
  issuedByOtherReason: string | null;
}

/** CER-013. The certificate, and what the IESS needs to be said about it. */
export interface IssuedCertificate {
  certificate: CertificateView;
  /** `null` on an attendance certificate. */
  iess: IessValidation | null;
  /** CER-032. Notices of a rest over 3 and over 7 days; they never refuse. */
  restNotices: string[];
}

/**
 * The medical certificate: issuing it from an attention, reading it and
 * annulling it with a reason.
 *
 * ONE SERVICE, ONE AGGREGATE: four use cases around one row, changing for one
 * reason — form 117 and REQ-070 to REQ-074.
 *
 * ⚠️ EVERY ACT IS AUDITED (CER-016), the listing included: a rest certificate
 * says that a person was ill on given days, and «¿quién lo vio?» has to be
 * answerable.
 */
@Injectable()
export class CertificateService {
  constructor(
    @Inject(CERTIFICATE_REPOSITORY)
    private readonly certificates: CertificateRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
    @Inject(CERTIFICATE_CLOCK)
    private readonly clock: CertificateClock,
  ) {
    this.logger.setContext(CertificateService.name);
  }

  /**
   * CER-001 to CER-009, CER-013. Issues a certificate from an attention.
   *
   * What is refused BEFORE touching storage is what depends only on the
   * request (CER-005, CER-006) and on who the caller is (CER-004). What
   * depends on the attention (CER-003, CER-008) is judged INSIDE the
   * transaction that writes: it can be closed, or lose its diagnosis, between
   * a read and an insert.
   */
  async issue(
    request: IssueCertificateRequest,
    requester: Requester,
  ): Promise<IssuedCertificate> {
    const { type } = request;
    assertIssuableType(type);
    // CER-006, CER-007, CER-031, CER-034, CER-035: everything the request
    // alone can be judged on, refused before touching storage.
    const details = restDetailsOf(type, request);

    const issuedAt = this.clock();
    // CER-030, CER-041. The calendar date of the issue, in Ecuador.
    const issueDate = clinicalDateOf(issuedAt);
    if (details !== null) assertRestStartsInTime(details.period, issueDate);
    // CER-030, D-106 §5. The issue's day for lateness, dawn counted as before.
    const lateIssueDay = lateIssueDayOf(issuedAt);

    const certifier = await this.certificates.findCertifierByUser(
      requester.userId,
    );
    if (!certifier) throw new CertifierProfileRequiredError();

    const verificationCode = newVerificationCode();

    // CER-038. Filled from the snapshot, inside the transaction.
    let missingWork: PatientWorkField[] = [];
    const certificate = await this.certificates.issue(
      { encounterId: request.encounterId, sites: requester.sites },
      (snapshot) => {
        if (!admitsNewCertificates(snapshot.encounterStatus)) {
          throw new CertificateEncounterNotOpenError(snapshot.encounterStatus);
        }
        // CER-044, CER-045 (D-106). The window around the attention, which no
        // reason widens; maternity has its own (D-108).
        const attentionDate = clinicalDateOf(snapshot.encounterStartedAt);
        if (details !== null) {
          assertRestWithinAttention(
            details.period,
            attentionDate,
            lateIssueDay,
            details.maternity,
          );
          // CER-046 to CER-050 (D-109, D-110). What bounds a maternity rest;
          // any other rest does not fall on a maternity rest (D-110 §5).
          if (details.maternity !== null) {
            assertMaternityWithinLeave(
              details.period,
              details.maternity,
              attentionDate,
              lateIssueDay,
              snapshot.diagnosisCodes,
              snapshot.patientRests,
            );
          } else {
            assertRestDoesNotOverlapMaternity(
              details.period,
              snapshot.patientRests,
            );
          }
        }
        // CER-039. Who attended is read under the lock, with the attention.
        const issuedByOtherReason = issuerReasonOf(
          certifier.practitionerId,
          snapshot.attendingPractitionerId,
          request.issuedByOtherReason,
        );
        // CER-036. The place of issue is the canton of the site's parish.
        if (snapshot.cityOfIssue === null) {
          throw new CertificateEstablishmentIncompleteError();
        }
        // CER-038, D-101. A rest prints the patient's work and contact, read
        // from the chart in this transaction. What is missing does not stop
        // the issue: the doctor is warned.
        missingWork =
          details === null ? [] : missingPatientWork(snapshot.patientWork);
        // CER-008. The diagnosis is read from the attention, never typed; a
        // rest always carries it (CER-007).
        const includeDiagnosis = details !== null || request.includeDiagnosis;
        if (includeDiagnosis && snapshot.diagnosisCodes.length === 0) {
          throw new CertificateDiagnosisRequiredError();
        }
        return {
          type,
          rest: details?.period ?? null,
          includeDiagnosis,
          contingencyType: details?.contingencyType ?? null,
          maternity: details?.maternity ?? null,
          // CER-030. Against the clinical date of the attention in Ecuador,
          // read inside the transaction, and the day of the issue with its
          // dawn (D-106 §5).
          backdatingReason:
            details === null
              ? null
              : backdatingReasonOf(
                  details.period,
                  attentionDate,
                  lateIssueDay,
                  request.backdatingReason,
                ),
          issuedByOtherReason,
          issuedById: certifier.practitionerId,
          issuedAt,
          verificationCode,
        };
      },
    );

    await this.trail(certificate.id, 'CREATE', requester);

    // CER-014. The fact only: no patient, no diagnosis, nothing interpolated.
    this.logger.info({ action: 'CERTIFICATE_ISSUED' }, 'certificate issued');

    return {
      certificate,
      iess: details === null ? null : iessValidationOf(details.period.to),
      restNotices:
        details === null
          ? []
          : [
              ...restNoticesOf(
                details.days,
                certifier.primarySpecialtyCode,
                details.contingencyType,
              ),
              ...[patientWorkNotice(missingWork)].filter(
                (notice): notice is string => notice !== null,
              ),
            ],
    };
  }

  /** CER-010, CER-016. The certificates of one attention, newest first. */
  async listOfEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<CertificateView[]> {
    const query = { encounterId, sites: requester.sites };
    if (!(await this.certificates.encounterExists(query))) {
      throw new CertificateEncounterNotFoundError();
    }

    const certificates = await this.certificates.listOfEncounter(query);
    for (const certificate of certificates) {
      await this.trail(certificate.id, 'READ', requester);
    }
    return certificates;
  }

  /**
   * CER-010, CER-016, CER-020 to CER-029. One certificate within the caller's
   * scope, as the five blocks of form 117. Audited: it is the name, the age,
   * the days of rest and, if the doctor said so, the diagnosis of an
   * identifiable person.
   */
  async form117(certificateId: string, requester: Requester): Promise<Form117> {
    const source = await this.certificates.form117SourceOf({
      certificateId,
      sites: requester.sites,
    });
    if (!source) throw new CertificateNotFoundError();

    await this.trail(source.certificate.id, 'READ', requester);
    return composeForm117(source);
  }

  /**
   * CER-011, CER-012, CER-016, CER-040. Annuls a certificate. NOTHING IS
   * DELETED.
   *
   * Who, when and why are written together, which is also what
   * `medical_certificate_revocation_states_who_when_and_why` demands. Only the
   * account that issued it, or whoever holds `certificate:revoke-any` at the
   * certificate's site (`directionSites`), may do it (D-105 §2).
   */
  async revoke(
    certificateId: string,
    reason: string,
    requester: Requester,
    directionSites: SiteScopeFilter,
  ): Promise<CertificateView> {
    const revoked = await this.certificates.revoke(
      { certificateId, sites: requester.sites },
      {
        revokedAt: this.clock(),
        // The ACCOUNT, never a cedula and never the practitioner (REQ-110).
        revokedById: requester.userId,
        reason,
      },
      ({ issuerUserId, siteId }) => {
        const issuedIt = issuerUserId === requester.userId;
        const directsTheSite =
          directionSites === 'all' || directionSites.includes(siteId);
        if (!issuedIt && !directsTheSite) {
          throw new CertificateRevokeForbiddenError();
        }
      },
    );

    await this.trail(revoked.id, 'UPDATE', requester);

    // CER-014. The reason is free text and belongs in the row, not in a log.
    this.logger.info({ action: 'CERTIFICATE_REVOKED' }, 'certificate revoked');

    return revoked;
  }

  /** CER-016. One row of the access trail. */
  private trail(
    certificateId: string,
    action: AuditAction,
    requester: Requester,
  ): Promise<void> {
    return this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: certificateId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}

/**
 * The short code a third party verifies the certificate with, WITHOUT
 * receiving any clinical datum.
 *
 * RANDOM AND NOT THE NUMBER: it is printed on paper that leaves the building,
 * and a sequential code lets whoever holds one enumerate the others. Sixteen
 * hexadecimal characters fit `verification_code` (`varchar(24)`), and its
 * `UNIQUE` arbitrates the collision that will not happen.
 */
function newVerificationCode(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}
