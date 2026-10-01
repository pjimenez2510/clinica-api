import './infrastructure/certificate.constraints';
import { Module } from '@nestjs/common';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';

import { CertificateService } from './application/certificate.service';
import { CertificateController } from './certificate.controller';
import { CERTIFICATE_REPOSITORY } from './domain/certificate.repository';
import { EncounterCertificatesController } from './encounter-certificates.controller';
import { PrismaCertificateRepository } from './infrastructure/prisma-certificate.repository';

/**
 * The medical certificate (form SNS-MSP/HCU-form.117/2021): the module that
 * makes `medical_certificate` writable.
 *
 * Composition root: the only place where the application's ports meet
 * concrete infrastructure. `CurrentUserService` is PROVIDED here rather than
 * imported, because no module imports another.
 *
 * It wires an access audit recorder (CER-016): a rest certificate says that an
 * identifiable person was ill on given days.
 */
@Module({
  controllers: [EncounterCertificatesController, CertificateController],
  providers: [
    CertificateService,
    CurrentUserService,
    { provide: CERTIFICATE_REPOSITORY, useClass: PrismaCertificateRepository },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
  ],
})
export class CertificatesModule {}
