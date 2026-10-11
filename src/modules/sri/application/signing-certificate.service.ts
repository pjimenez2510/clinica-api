import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ELECTRONIC_VOUCHER_REPOSITORY,
  SIGNING_CERTIFICATE_REPOSITORY,
  type CertificateSummary,
  type ElectronicVoucherRepository,
  type SigningCertificateRepository,
} from '../domain/electronic-voucher.repository';
import {
  CERTIFICATE_CIPHER,
  isAboutToExpire,
  isWithinValidity,
  PKCS12_INSPECTOR,
  type CertificateCipher,
  type Pkcs12Inspector,
} from '../domain/signing';
import {
  SigningCertificateExpiredError,
  SigningCertificateTooLargeError,
} from '../domain/sri.errors';
import { SRI_CLOCK, type SriClock } from '../domain/sri-web-service';

/** SRI-083. A .p12 from an accredited entity is 4–8 KiB. */
export const MAX_CERTIFICATE_BYTES = 64 * 1024;

const CERTIFICATE_RESOURCE_TYPE = 'signing_certificate';

export interface Uploader {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** SRI-032, SRI-063. What the monitor says about the certificate. */
/**
 * SRI-102. The certificate with what the screen warns about: whether its
 * holder's RUC is the establishment's or a site's — `null` when the
 * certificate does not say, or there is no issuer RUC to compare with.
 */
export type CheckedCertificate = CertificateSummary & {
  holderRucMatchesIssuer: boolean | null;
};

export interface CertificateHealth {
  active: CertificateSummary | null;
  aboutToExpire: boolean;
  expired: boolean;
}

/**
 * SRI-022 to SRI-034, SRI-080 to SRI-084. The issuer's certificate: loaded
 * once, encrypted at rest, never served back.
 *
 * ⚠️ THE PASSWORD IS ENCRYPTED TOO, with the same derived key. The unattended
 * signature of ADR-004 needs it at signing time, and keeping it in clear next
 * to an encrypted .p12 would make the encryption decorative.
 */
@Injectable()
export class SigningCertificateService {
  constructor(
    @Inject(SIGNING_CERTIFICATE_REPOSITORY)
    private readonly certificates: SigningCertificateRepository,
    @Inject(PKCS12_INSPECTOR) private readonly inspector: Pkcs12Inspector,
    @Inject(CERTIFICATE_CIPHER) private readonly cipher: CertificateCipher,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(SRI_CLOCK) private readonly clock: SriClock,
    @Inject(ELECTRONIC_VOUCHER_REPOSITORY)
    private readonly vouchers: ElectronicVoucherRepository,
  ) {}

  /** SRI-080 to SRI-084. */
  async upload(
    file: Buffer,
    password: string,
    uploader: Uploader,
  ): Promise<CheckedCertificate> {
    // SRI-083. Before a single byte is parsed.
    if (file.length > MAX_CERTIFICATE_BYTES) {
      throw new SigningCertificateTooLargeError();
    }

    const description = this.inspector.inspect(file, password);
    if (!isWithinValidity(description, this.clock())) {
      throw new SigningCertificateExpiredError();
    }

    const salt = this.cipher.newSalt();
    const summary = await this.certificates.createActive({
      ...description,
      encryptedPkcs12: await this.cipher.seal(file, salt),
      encryptedPassword: await this.cipher.seal(
        Buffer.from(password, 'utf8'),
        salt,
      ),
      kdfSalt: salt,
      uploadedById: uploader.userId,
    });

    await this.audit.record({
      userId: uploader.userId,
      resourceType: CERTIFICATE_RESOURCE_TYPE,
      resourceId: summary.id,
      action: 'CREATE',
      ip: uploader.ip,
      userAgent: uploader.userAgent,
    });

    // SRI-084. What waited for a certificate is released for the sweep,
    // which signs it within the minute: never 200 signatures inside this
    // request, and never two signers racing for the same voucher.
    await this.vouchers.unblockForCertificate();

    // SRI-102. Said, never refused: the accountant decides (D-215 §2).
    const [checked] = await this.checked([summary]);
    return checked!;
  }

  async list(): Promise<CheckedCertificate[]> {
    return this.checked(await this.certificates.list());
  }

  private async checked(
    certificates: CertificateSummary[],
  ): Promise<CheckedCertificate[]> {
    const issuerRucs = new Set(await this.certificates.issuerRucs());
    return certificates.map((certificate) => ({
      ...certificate,
      holderRucMatchesIssuer:
        certificate.holderRuc === null || issuerRucs.size === 0
          ? null
          : issuerRucs.has(certificate.holderRuc),
    }));
  }

  /** SRI-032, SRI-063. */
  async health(): Promise<CertificateHealth> {
    const active = await this.certificates.active();
    if (!active) return { active: null, aboutToExpire: false, expired: false };
    const now = this.clock();
    const summary: CertificateSummary = {
      id: active.id,
      subject: active.subject,
      issuer: active.issuer,
      serialNumber: active.serialNumber,
      notBefore: active.notBefore,
      notAfter: active.notAfter,
      holderRuc: active.holderRuc,
      active: active.active,
      createdAt: active.createdAt,
    };
    return {
      active: summary,
      aboutToExpire: isAboutToExpire(active, now),
      expired: !isWithinValidity(active, now),
    };
  }
}
