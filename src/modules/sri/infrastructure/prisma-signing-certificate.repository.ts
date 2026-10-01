import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CertificateSummary,
  SigningCertificateRepository,
  StoredCertificate,
} from '../domain/electronic-voucher.repository';

const SUMMARY_SELECT = {
  id: true,
  subject: true,
  issuer: true,
  serialNumber: true,
  notBefore: true,
  notAfter: true,
  active: true,
  createdAt: true,
} as const;

/**
 * SRI-022 to SRI-034. The certificate rows. The envelopes are read in exactly
 * one place —`active()`, for signing— and never listed: `list()` cannot
 * return them because its select does not name them.
 */
@Injectable()
export class PrismaSigningCertificateRepository implements SigningCertificateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async active(): Promise<StoredCertificate | null> {
    const row = await this.prisma.signingCertificate.findFirst({
      where: { active: true },
      select: {
        ...SUMMARY_SELECT,
        encryptedPkcs12: true,
        encryptedPassword: true,
        kdfSalt: true,
      },
    });
    if (!row) return null;
    return {
      ...row,
      encryptedPkcs12: Buffer.from(row.encryptedPkcs12),
      encryptedPassword: Buffer.from(row.encryptedPassword),
      kdfSalt: Buffer.from(row.kdfSalt),
    };
  }

  /** SRI-080. The previous one goes inactive in the same transaction. */
  async createActive(
    certificate: Omit<StoredCertificate, 'id' | 'active' | 'createdAt'> & {
      uploadedById: string;
    },
  ): Promise<CertificateSummary> {
    return this.prisma.$transaction(async (tx) => {
      await tx.signingCertificate.updateMany({
        where: { active: true },
        data: { active: false, deactivatedAt: new Date() },
      });
      return tx.signingCertificate.create({
        data: {
          subject: certificate.subject,
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
          notBefore: certificate.notBefore,
          notAfter: certificate.notAfter,
          encryptedPkcs12: new Uint8Array(certificate.encryptedPkcs12),
          encryptedPassword: new Uint8Array(certificate.encryptedPassword),
          kdfSalt: new Uint8Array(certificate.kdfSalt),
          uploadedById: certificate.uploadedById,
        },
        select: SUMMARY_SELECT,
      });
    });
  }

  list(): Promise<CertificateSummary[]> {
    return this.prisma.signingCertificate.findMany({
      orderBy: { createdAt: 'desc' },
      select: SUMMARY_SELECT,
    });
  }

  async recordOpening(certificateId: string, voucherId: string): Promise<void> {
    await this.prisma.signingCertificateOpening.create({
      data: { certificateId, voucherId },
    });
  }
}
