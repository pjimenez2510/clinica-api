import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { PrivacyNoticeVersionConflictError } from '../domain/privacy.errors';
import type {
  PrivacyNoticeRepository,
  PrivacyNoticeView,
  Requester,
} from '../domain/privacy.repository';

import { isPrivacyNoticeRace } from './privacy-database-errors';
import {
  NOTICE_SELECT,
  staffNames,
  toNoticeView,
  writeTrail,
} from './privacy-reads';

/**
 * PD-005. Two publications from the application are ordered by this
 * transaction-scoped advisory lock, so both go out with consecutive numbers;
 * the unique number and the trigger are the net for a write that skips it.
 */
export const PRIVACY_NOTICE_LOCK = 0x70726976; // 'priv'

@Injectable()
export class PrismaPrivacyNoticeRepository implements PrivacyNoticeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async versions(): Promise<PrivacyNoticeView[]> {
    const rows = await this.prisma.privacyNoticeVersion.findMany({
      orderBy: { version: 'desc' },
      select: NOTICE_SELECT,
    });
    const names = await staffNames(
      this.prisma,
      rows.map((row) => row.publishedBy),
    );
    return rows.map((row) => toNoticeView(row, names));
  }

  async publish(
    body: string,
    requester: Requester,
  ): Promise<PrivacyNoticeView> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PRIVACY_NOTICE_LOCK}::bigint)`;
        const last = await tx.privacyNoticeVersion.findFirst({
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await tx.privacyNoticeVersion.create({
          data: {
            version: (last?.version ?? 0) + 1,
            body,
            publishedBy: requester.userId,
          },
          select: NOTICE_SELECT,
        });
        await writeTrail(
          tx,
          {
            resourceType: 'privacy_notice_version',
            resourceId: created.id,
            action: 'CREATE',
          },
          requester,
        );
        return created;
      });
      return toNoticeView(
        row,
        await staffNames(this.prisma, [row.publishedBy]),
      );
    } catch (error) {
      // PD-005: the base lets one of two simultaneous publications through.
      if (isPrivacyNoticeRace(error)) {
        throw new PrivacyNoticeVersionConflictError();
      }
      throw error;
    }
  }
}
