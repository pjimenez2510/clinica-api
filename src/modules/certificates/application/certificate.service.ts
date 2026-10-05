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
  assertMaternityCoherent,
  assertRestDoesNotOverlapMaternity,
  backdatingReasonOf,
  lateIssueDayOf,
  iessValidationOf,
  issuerReasonOf,
  restDetailsOf,
  restLimitNoticesOf,
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
  type CertificatePlan,
  type CertificateRepository,
  type CertificateView,
  type CertifierIdentity,
  type IssueSnapshot,
  type RevocationSnapshot,
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

/**
 * CER-053. Correcting an issued certificate: the new one as it should read —
 * the same fields as issuing it, on the same attention — and the reason of
 * the annulment (CER-011).
 */
export interface CorrectCertificateRequest extends Omit<
  IssueCertificateRequest,
  'encounterId'
> {
  reason: string;
}

/** CER-053. The annulled certificate, and the one that replaces it. */
export interface CorrectedCertificate {
  revoked: CertificateView;
  issued: IssuedCertificate;
}

/** CER-013. The certificate, and what the IESS needs to be said about it. */
export interface IssuedCertificate {
  certificate: CertificateView;
  /** `null` on an attendance certificate. */
  iess: IessValidation | null;
  /**
   * CER-032, CER-038, CER-043, CER-055. What the doctor is warned of: a long
   * rest, the limits it passes, the maternity procedure, the chart's missing
   * work data. They never refuse.
   */
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
    const issuing = await this.prepareIssue(request, requester);

    const certificate = await this.certificates.issue(
      { encounterId: request.encounterId, sites: requester.sites },
      issuing.decide,
    );

    await this.trail(certificate.id, 'CREATE', requester);

    // CER-014. The fact only: no patient, no diagnosis, nothing interpolated.
    this.logger.info({ action: 'CERTIFICATE_ISSUED' }, 'certificate issued');

    return issuing.respond(certificate);
  }

  /**
   * CER-053 (D-127.4). Corrects an issued certificate IN ONE STEP: annuls it
   * with its reason (CER-011) and issues the new one on the same attention,
   * in ONE transaction. If the new one cannot be issued —any rule of the
   * issue, judged exactly as `issue` judges it— nothing is annulled.
   *
   * Who may: whoever may annul it (CER-040). The new one is issued by the
   * session (CER-004), so a medical director correcting a colleague's
   * certificate states why they issue instead of who attended (CER-039).
   *
   * ⚠️ THE ANNULMENT COMES FIRST INSIDE THE TRANSACTION, so the rests the issue
   * reads no longer include the one being replaced: a corrected period that
   * overlaps the old one is not an overlap (CER-048), the old one is gone.
   */
  async correct(
    certificateId: string,
    request: CorrectCertificateRequest,
    requester: Requester,
    directionSites: SiteScopeFilter,
  ): Promise<CorrectedCertificate> {
    const { reason, ...fields } = request;
    const issuing = await this.prepareIssue(fields, requester);

    const { revoked, issued } = await this.certificates.correct(
      { certificateId, sites: requester.sites },
      {
        revokedAt: issuing.issuedAt,
        // The ACCOUNT, never a cedula and never the practitioner (REQ-110).
        revokedById: requester.userId,
        reason,
      },
      (snapshot) => authoriseRevocation(snapshot, requester, directionSites),
      issuing.decide,
    );

    await this.trail(revoked.id, 'UPDATE', requester);
    await this.trail(issued.id, 'CREATE', requester);

    // CER-014. The facts only; the reason is free text and stays in the row.
    this.logger.info(
      { action: 'CERTIFICATE_CORRECTED' },
      'certificate corrected',
    );

    return { revoked, issued: issuing.respond(issued) };
  }

  /**
   * CER-001 to CER-009, CER-013, CER-030 to CER-055. Everything an issue
   * needs, ONE place for `issue` and `correct`: what the request alone can be
   * judged on is refused here, before touching storage; what depends on the
   * attention is the `decide` the adapter calls inside its transaction; and
   * `respond` composes what the IESS needs to be told.
   */
  private async prepareIssue(
    request: Omit<IssueCertificateRequest, 'encounterId'>,
    requester: Requester,
  ): Promise<{
    issuedAt: Date;
    decide: (snapshot: IssueSnapshot) => CertificatePlan;
    respond: (certificate: CertificateView) => IssuedCertificate;
  }> {
    const { type } = request;
    assertIssuableType(type);
    // CER-006, CER-007, CER-034, CER-035: everything the request alone can be
    // judged on, refused before touching storage.
    const details = restDetailsOf(type, request);

    const issuedAt = this.clock();
    // CER-041. The calendar date of the issue, in Ecuador.
    const issueDate = clinicalDateOf(issuedAt);
    // CER-030, D-106 §5. The issue's day for lateness, dawn counted as before.
    const lateIssueDay = lateIssueDayOf(issuedAt);

    const certifier: CertifierIdentity | null =
      await this.certificates.findCertifierByUser(requester.userId);
    if (!certifier) throw new CertifierProfileRequiredError();

    const verificationCode = newVerificationCode();

    // CER-038, CER-055. Filled from the snapshot, inside the transaction.
    let missingWork: PatientWorkField[] = [];
    let limitNotices: string[] = [];
    const decide = (snapshot: IssueSnapshot): CertificatePlan => {
      if (!admitsNewCertificates(snapshot.encounterStatus)) {
        throw new CertificateEncounterNotOpenError(snapshot.encounterStatus);
      }
      const attentionDate = clinicalDateOf(snapshot.encounterStartedAt);
      if (details !== null) {
        // CER-055 (D-128.7). The limits around the attention —CER-031,
        // CER-041, CER-044 to CER-047, CER-051— warn and do not refuse.
        limitNotices = restLimitNoticesOf(details, {
          attentionDate,
          issueDate,
          lateIssueDay,
        });
        // CER-048 to CER-050 (D-109, D-110). What still refuses: coherence,
        // not limits. Any other rest does not fall on a maternity rest
        // (D-110 §5).
        if (details.maternity !== null) {
          assertMaternityCoherent(
            details.period,
            details.maternity,
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
    };

    const respond = (certificate: CertificateView): IssuedCertificate => ({
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
                limitNotices,
              ),
              ...[patientWorkNotice(missingWork)].filter(
                (notice): notice is string => notice !== null,
              ),
            ],
    });

    return { issuedAt, decide, respond };
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
      (snapshot) => authoriseRevocation(snapshot, requester, directionSites),
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
 * CER-040, D-105 §2. Annulling —and so correcting— is for the account that
 * issued it, or for whoever holds `certificate:revoke-any` at its site.
 */
function authoriseRevocation(
  { issuerUserId, siteId }: RevocationSnapshot,
  requester: Requester,
  directionSites: SiteScopeFilter,
): void {
  const issuedIt = issuerUserId === requester.userId;
  const directsTheSite =
    directionSites === 'all' || directionSites.includes(siteId);
  if (!issuedIt && !directsTheSite) {
    throw new CertificateRevokeForbiddenError();
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
