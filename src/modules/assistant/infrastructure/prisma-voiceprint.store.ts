import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuditAction } from '../../../shared/audit/access-audit.port';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  VOICEPRINT_RESOURCE_TYPE,
  type StoredVoiceprint,
  type Voiceprint,
  type VoiceprintStore,
  type VoiceprintTrail,
} from '../application/voiceprint.port';

/**
 * AS-310 to AS-313. `professional_voiceprint`, one row per person. What the
 * table guarantees —the size of the vector, finite values, nothing versioned—
 * is its own (`20261025002800_professional_voiceprint`). Each change and its
 * trail entry commit together, or neither does (AS-312, review).
 */
@Injectable()
export class PrismaVoiceprintStore implements VoiceprintStore {
  constructor(private readonly prisma: PrismaService) {}

  find(userId: string): Promise<StoredVoiceprint | null> {
    return this.prisma.professionalVoiceprint.findUnique({
      where: { userId },
    });
  }

  /** AS-312. A new reading replaces the vector; the switch stays where it was. */
  save(
    userId: string,
    voiceprint: Voiceprint,
    at: Date,
    trail: VoiceprintTrail,
  ): Promise<StoredVoiceprint> {
    const data = {
      model: voiceprint.model,
      dimension: voiceprint.dimension,
      vector: voiceprint.vector,
      phrases: voiceprint.phrases,
      seconds: voiceprint.seconds,
      consentedAt: at,
      updatedAt: at,
    };
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.professionalVoiceprint.findUnique({
        where: { userId },
        select: { userId: true },
      });
      const saved = await tx.professionalVoiceprint.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
      await record(tx, userId, before ? 'UPDATE' : 'CREATE', trail);
      return saved;
    });
  }

  setAttribution(
    userId: string,
    on: boolean,
    at: Date,
    trail: VoiceprintTrail,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.professionalVoiceprint.updateMany({
        where: { userId },
        data: { attribution: on, updatedAt: at },
      });
      if (count > 0) await record(tx, userId, 'UPDATE', trail);
      return count > 0;
    });
  }

  remove(userId: string, trail: VoiceprintTrail): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.professionalVoiceprint.deleteMany({
        where: { userId },
      });
      if (count > 0) await record(tx, userId, 'DELETE', trail);
      return count > 0;
    });
  }
}

/** The owner acting on their own voiceprint: identifiers only, never the vector. */
function record(
  tx: Prisma.TransactionClient,
  userId: string,
  action: AuditAction,
  trail: VoiceprintTrail,
): Promise<unknown> {
  return tx.accessAudit.create({
    data: {
      userId,
      resourceType: VOICEPRINT_RESOURCE_TYPE,
      resourceId: userId,
      action,
      ip: trail.ip,
      userAgent: trail.userAgent?.slice(0, 512),
    },
  });
}
