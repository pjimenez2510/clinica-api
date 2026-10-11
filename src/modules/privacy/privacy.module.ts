import './infrastructure/privacy.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { AuthorizationService } from './application/authorization.service';
import { DataSubjectRequestsService } from './application/data-subject-requests.service';
import { PrivacyNoticeService } from './application/privacy-notice.service';
import {
  AUTHORIZATION_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
  PRIVACY_NOTICE_REPOSITORY,
} from './domain/privacy.repository';
import { PrismaAuthorizationRepository } from './infrastructure/prisma-authorization.repository';
import { PrismaDataSubjectRequestRepository } from './infrastructure/prisma-data-subject-request.repository';
import { PrismaPrivacyNoticeRepository } from './infrastructure/prisma-privacy-notice.repository';
import { PrivacyController } from './privacy.controller';

/**
 * The privacy notice, the optional authorizations and the data subject's
 * rights (LOPDP), ADR-011: it owns the notice, the authorizations and the
 * requests.
 *
 * THREE SERVICES (ADR-008 §2): the notice, the authorizations and the
 * requests share no dependencies — different tables, different permissions,
 * different reasons to change. One controller, because one URL space is one screen to the
 * person reading the OpenAPI.
 *
 * `ACCESS_AUDIT_RECORDER` ONLY FOR THE READ. Every act of this module must
 * fail closed — an authorization, an answer or an export without its trail row must
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
    PrivacyNoticeService,
    AuthorizationService,
    DataSubjectRequestsService,
    CurrentUserService,
    { provide: PRIVACY_NOTICE_REPOSITORY, useClass: PrismaPrivacyNoticeRepository }, // prettier-ignore
    { provide: AUTHORIZATION_REPOSITORY, useClass: PrismaAuthorizationRepository }, // prettier-ignore
    { provide: DATA_SUBJECT_REQUEST_REPOSITORY, useClass: PrismaDataSubjectRequestRepository }, // prettier-ignore
    // Only for the READ of a chart's requests: everything that WRITES writes
    // its trail row in its own transaction instead (see `writeTrail`).
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class PrivacyModule {}
