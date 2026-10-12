import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  ListeningStore,
  StoredListening,
  TranscriptLine,
} from '../application/listening.store';
import type { RecognizedSegment } from '../application/speech-recognizer.port';
import type { ListeningState, PauseReason } from '../domain/listening';
import { transcriptPurgeCutoffs } from '../domain/transcript-retention';

/**
 * AS-049, AS-052, AS-056, AS-057. The listening and its transcript in
 * PostgreSQL. What the tables guarantee — one segment per start, nothing
 * rewritten, no binary column — is theirs (`20261025001100_listening`).
 */
@Injectable()
export class PrismaListeningStore implements ListeningStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(encounterId: string): Promise<StoredListening | null> {
    const row = await this.prisma.listeningSession.findUnique({
      where: { encounterId },
    });
    if (!row) return null;
    return {
      encounterId: row.encounterId,
      state: row.state as ListeningState,
      offsetMs: row.offsetMs,
      reason: row.reason as PauseReason | null,
      device: row.device,
      startedBy: row.startedBy,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
    };
  }

  async save(listening: StoredListening): Promise<void> {
    const { encounterId, ...rest } = listening;
    await this.prisma.listeningSession.upsert({
      where: { encounterId },
      create: listening,
      update: rest,
    });
  }

  async advance(
    encounterId: string,
    offsetMs: number,
    at: Date,
  ): Promise<void> {
    await this.prisma.listeningSession.updateMany({
      where: { encounterId, state: 'LISTENING', offsetMs: { lt: offsetMs } },
      data: { offsetMs, updatedAt: at },
    });
  }

  /** AS-052. A start already kept is left as it was: never twice. */
  async append(
    encounterId: string,
    segments: readonly RecognizedSegment[],
    at: Date,
  ): Promise<void> {
    if (segments.length === 0) return;
    await this.prisma.transcriptSegment.createMany({
      data: segments.map((segment) => ({
        encounterId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        createdAt: at,
      })),
      skipDuplicates: true,
    });
  }

  transcript(encounterId: string): Promise<TranscriptLine[]> {
    return this.prisma.transcriptSegment.findMany({
      where: { encounterId },
      orderBy: { startMs: 'asc' },
      select: { startMs: true, endMs: true, text: true },
    });
  }

  /**
   * AS-057 (D-239 §3, D-247 §2 and §8). 45 days after the first signature of
   * the attention's note; and, signed or not, 90 days after the segment was
   * kept. A note signed without discharge leaves the attention open and the
   * listening may go on: those later segments count from the same first
   * signature (D-247 §8, recommendation awaiting the author).
   */
  purge(now: Date): Promise<number> {
    const { retention, maximum } = transcriptPurgeCutoffs(now);
    return this.prisma.$executeRaw`
      DELETE FROM "transcript_segment" AS s
      WHERE s."created_at" <= ${maximum}
         OR (SELECT MIN(n."signed_at") FROM "clinical_note" AS n
              WHERE n."encounter_id" = s."encounter_id") <= ${retention}`;
  }
}
