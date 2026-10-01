import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import {
  ELECTRONIC_VOUCHER_PREPARER,
  ELECTRONIC_VOUCHER_STATUS,
} from '../../shared/billing/electronic-voucher.port';
import type { Env } from '../../shared/config/env.schema';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { NodemailerMailer } from '../../shared/infrastructure/mail/nodemailer.mailer';
import { MAILER } from '../../shared/mail/mail.port';

import { SigningCertificateService } from './application/signing-certificate.service';
import { VoucherDispatchService } from './application/voucher-dispatch.service';
import { VoucherMonitorService } from './application/voucher-monitor.service';
import { VoucherPreparationService } from './application/voucher-preparation.service';
import {
  ELECTRONIC_VOUCHER_REPOSITORY,
  SIGNING_CERTIFICATE_REPOSITORY,
  VOUCHER_QUEUE,
} from './domain/electronic-voucher.repository';
import {
  CERTIFICATE_CIPHER,
  PKCS12_INSPECTOR,
  XADES_SIGNER,
} from './domain/signing';
import {
  SRI_CLOCK,
  SRI_SETTINGS,
  SRI_WEB_SERVICE,
  type SriSettings,
} from './domain/sri-web-service';
import { AesGcmCertificateCipher } from './infrastructure/aes-gcm-certificate.cipher';
import { EcSriXadesSigner } from './infrastructure/ec-sri-xades.signer';
import { ForgePkcs12Inspector } from './infrastructure/forge-pkcs12.inspector';
import {
  PgBossConnection,
  PgBossVoucherQueue,
  SriQueueWorker,
} from './infrastructure/pg-boss-voucher.queue';
import { PrismaElectronicVoucherRepository } from './infrastructure/prisma-electronic-voucher.repository';
import { PrismaSigningCertificateRepository } from './infrastructure/prisma-signing-certificate.repository';
import { FetchSriWebService } from './infrastructure/sri-web-service.client';
import {
  SriCertificatesController,
  SriVouchersController,
} from './sri.controller';

/**
 * The electronic voucher (sri/SPEC.md, ADR-004).
 *
 * `@Global` FOR TWO TOKENS, AND ONLY THEM. `billing` has to announce an issued
 * invoice (`ELECTRONIC_VOUCHER_PREPARER`) and show its electronic state
 * (`ELECTRONIC_VOUCHER_STATUS`) without importing this module — no module
 * imports another. Both tokens are declared in `shared/billing`; this is the
 * module that satisfies them, and nothing else of it is exported.
 */
@Global()
@Module({
  controllers: [SriVouchersController, SriCertificatesController],
  providers: [
    VoucherPreparationService,
    VoucherDispatchService,
    VoucherMonitorService,
    SigningCertificateService,
    CurrentUserService,
    PgBossConnection,
    SriQueueWorker,
    {
      provide: ELECTRONIC_VOUCHER_PREPARER,
      useExisting: VoucherPreparationService,
    },
    { provide: ELECTRONIC_VOUCHER_STATUS, useExisting: VoucherMonitorService },
    {
      provide: ELECTRONIC_VOUCHER_REPOSITORY,
      useClass: PrismaElectronicVoucherRepository,
    },
    {
      provide: SIGNING_CERTIFICATE_REPOSITORY,
      useClass: PrismaSigningCertificateRepository,
    },
    { provide: VOUCHER_QUEUE, useClass: PgBossVoucherQueue },
    { provide: SRI_WEB_SERVICE, useClass: FetchSriWebService },
    { provide: XADES_SIGNER, useClass: EcSriXadesSigner },
    { provide: PKCS12_INSPECTOR, useClass: ForgePkcs12Inspector },
    { provide: CERTIFICATE_CIPHER, useClass: AesGcmCertificateCipher },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
    { provide: MAILER, useClass: NodemailerMailer },
    { provide: SRI_CLOCK, useValue: () => new Date() },
    {
      provide: SRI_SETTINGS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): SriSettings => ({
        environment: config.get('SRI_ENVIRONMENT', { infer: true }),
        // `||` and not `??`: an empty `KEY=` comes back from `ConfigService`
        // as '' (it falls back to the raw environment), and '' is «not declared».
        paymentMethod:
          config.get('SRI_DEFAULT_PAYMENT_METHOD', { infer: true }) || null,
        softwareProviderRuc:
          config.get('SRI_SOFTWARE_PROVIDER_RUC', { infer: true }) || null,
      }),
    },
  ],
  exports: [ELECTRONIC_VOUCHER_PREPARER, ELECTRONIC_VOUCHER_STATUS],
})
export class SriModule {}
