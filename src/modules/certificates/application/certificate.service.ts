import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  admitsNewCertificates,
  assertIssuableType,
  iessValidationOf,
  restPeriodOf,
  type CertificateType,
  type IessValidation,
} from '../domain/certificate';
import {
  CertificateDiagnosisRequiredError,
  CertificateEncounterNotFoundError,
  CertificateEncounterNotOpenError,
  CertificateNotFoundError,
  CertifierProfileRequiredError,
} from '../domain/certificate.errors';
import {
  CERTIFICATE_REPOSITORY,
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
  /** CER-007. Answered explicitly by the doctor; never defaulted. */
  includeDiagnosis: boolean;
}

/** CER-013. The certificate, and what the IESS needs to be said about it. */
export interface IssuedCertificate {
  certificate: CertificateView;
  /** `null` on an attendance certificate. */
  iess: IessValidation | null;
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
    const rest = restPeriodOf(type, request.restFrom, request.restTo);

    const certifier = await this.certificates.findCertifierByUser(
      requester.userId,
    );
    if (!certifier) throw new CertifierProfileRequiredError();

    const issuedAt = new Date();
    const verificationCode = newVerificationCode();

    const certificate = await this.certificates.issue(
      { encounterId: request.encounterId, sites: requester.sites },
      (snapshot) => {
        if (!admitsNewCertificates(snapshot.encounterStatus)) {
          throw new CertificateEncounterNotOpenError(snapshot.encounterStatus);
        }
        // CER-008. The diagnosis is read from the attention, never typed.
        if (request.includeDiagnosis && snapshot.diagnosisCount === 0) {
          throw new CertificateDiagnosisRequiredError();
        }
        return {
          type,
          rest,
          includeDiagnosis: request.includeDiagnosis,
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
      iess: rest === null ? null : iessValidationOf(rest.to),
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

  /** CER-010, CER-016. One certificate within the caller's scope. */
  async findOne(
    certificateId: string,
    requester: Requester,
  ): Promise<CertificateView> {
    const certificate = await this.certificates.findById({
      certificateId,
      sites: requester.sites,
    });
    if (!certificate) throw new CertificateNotFoundError();

    await this.trail(certificate.id, 'READ', requester);
    return certificate;
  }

  /**
   * CER-011, CER-012, CER-016. Annuls a certificate. NOTHING IS DELETED.
   *
   * Who, when and why are written together, which is also what
   * `medical_certificate_revocation_states_who_when_and_why` demands.
   */
  async revoke(
    certificateId: string,
    reason: string,
    requester: Requester,
  ): Promise<CertificateView> {
    const revoked = await this.certificates.revoke(
      { certificateId, sites: requester.sites },
      {
        revokedAt: new Date(),
        // The ACCOUNT, never a cedula and never the practitioner (REQ-110).
        revokedById: requester.userId,
        reason,
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
