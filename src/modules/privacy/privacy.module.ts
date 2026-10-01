import './infrastructure/privacy.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { ConsentService } from './application/consent.service';
import { DataSubjectRequestsService } from './application/data-subject-requests.service';
import {
  CONSENT_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
} from './domain/privacy.repository';
import { PrismaConsentRepository } from './infrastructure/prisma-consent.repository';
import { PrismaDataSubjectRequestRepository } from './infrastructure/prisma-data-subject-request.repository';
import { PrivacyController } from './privacy.controller';

/**
 * The consent and the data subject's rights (LOPDP), ADR-011: it owns the
 * consent text, the patients' consents and the requests.
 *
 * TWO SERVICES (ADR-008 §2): the consent and the requests share no
 * dependencies — different tables, different permissions, different reasons
 * to change. One controller, because one URL space is one screen to the
 * person reading the OpenAPI.
 *
 * `ACCESS_AUDIT_RECORDER` ONLY FOR THE READ. Every act of this module must
 * fail closed — a consent, an answer or an export without its trail row must
 * not exist — and that recorder's contract is to log and never throw. The
 * repositories write the row inside their own transaction instead
 * (`writeTrail`), as `resetMfa` does.
 *
 * `CurrentUserService` is PROVIDED here, not imported from `AuthModule`: no
 * module imports another.
 */
@Module({
  controllers: [PrivacyController],
  providers: [
    ConsentService,
    DataSubjectRequestsService,
    CurrentUserService,
    { provide: CONSENT_REPOSITORY, useClass: PrismaConsentRepository },
    { provide: DATA_SUBJECT_REQUEST_REPOSITORY, useClass: PrismaDataSubjectRequestRepository }, // prettier-ignore
    // Only for the READ of a chart's requests: everything that WRITES writes
    // its trail row in its own transaction instead (see `writeTrail`).
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class PrivacyModule {}
