import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  StoredVoiceprint,
  Voiceprint,
  VoiceprintStore,
} from '../application/voiceprint.port';

/**
 * AS-310 to AS-313. `professional_voiceprint`, one row per person. What the
 * table guarantees —the size of the vector, finite values, nothing versioned—
 * is its own (`20261025002800_professional_voiceprint`).
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
    return this.prisma.professionalVoiceprint.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  async setAttribution(
    userId: string,
    on: boolean,
    at: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.professionalVoiceprint.updateMany({
      where: { userId },
      data: { attribution: on, updatedAt: at },
    });
    return count > 0;
  }

  async remove(userId: string): Promise<boolean> {
    const { count } = await this.prisma.professionalVoiceprint.deleteMany({
      where: { userId },
    });
    return count > 0;
  }
}
