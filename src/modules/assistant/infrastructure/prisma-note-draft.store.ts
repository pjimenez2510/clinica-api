import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  NoteDraftStore,
  StoredNoteDraft,
} from '../application/note-draft.store';
import type { NoteDraftStatus } from '../domain/note-draft';

const IN_FLIGHT: NoteDraftStatus[] = ['QUEUED', 'RUNNING'];

/**
 * AS-086, AS-093 over PostgreSQL. One draft per stretch and one in flight per
 * attention are the table's (`note_draft_once_per_stretch`,
 * `note_draft_one_in_flight`); this adapter turns their refusal into «read
 * again», and moves a draft from state to state only from the one before.
 */
@Injectable()
export class PrismaNoteDraftStore implements NoteDraftStore {
  constructor(private readonly prisma: PrismaService) {}

  async ofStretch(encounterId: string, upToMs: number) {
    const row = await this.prisma.noteDraft.findUnique({
      where: { encounterId_upToMs: { encounterId, upToMs } },
    });
    return row ? toStored(row) : null;
  }

  async latest(encounterId: string) {
    const row = await this.prisma.noteDraft.findFirst({
      where: { encounterId },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toStored(row) : null;
  }

  async latestDone(encounterId: string) {
    const row = await this.prisma.noteDraft.findFirst({
      where: { encounterId, status: 'DONE' },
      orderBy: [{ upToMs: 'desc' }],
    });
    return row ? toStored(row) : null;
  }

  async inFlight(encounterId: string) {
    const row = await this.prisma.noteDraft.findFirst({
      where: { encounterId, status: { in: IN_FLIGHT } },
    });
    return row ? toStored(row) : null;
  }

  async queue(input: {
    encounterId: string;
    upToMs: number;
    requestedBy: string;
    at: Date;
  }) {
    try {
      const row = await this.prisma.noteDraft.create({
        data: {
          encounterId: input.encounterId,
          upToMs: input.upToMs,
          requestedBy: input.requestedBy,
          status: 'QUEUED',
          requestedAt: input.at,
        },
      });
      return toStored(row);
    } catch (error) {
      if (refusedAsTaken(error)) return null;
      throw error;
    }
  }

  async requeue(id: string, requestedBy: string, at: Date) {
    try {
      const { count } = await this.prisma.noteDraft.updateMany({
        where: { id, status: 'FAILED' },
        data: {
          status: 'QUEUED',
          failureCode: null,
          requestedBy,
          requestedAt: at,
          startedAt: null,
          finishedAt: null,
        },
      });
      if (count === 0) return null;
    } catch (error) {
      if (refusedAsTaken(error)) return null;
      throw error;
    }
    return toStored(await this.prisma.noteDraft.findUniqueOrThrow({ where: { id } })); // prettier-ignore
  }

  async start(id: string, at: Date) {
    const { count } = await this.prisma.noteDraft.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: at },
    });
    return count === 1;
  }

  async succeed(id: string, aiRunId: string, at: Date) {
    await this.prisma.noteDraft.updateMany({
      where: { id, status: 'RUNNING' },
      data: { status: 'DONE', aiRunId, finishedAt: at },
    });
  }

  async fail(id: string, code: string, at: Date) {
    await this.prisma.noteDraft.updateMany({
      where: { id, status: { in: IN_FLIGHT } },
      data: { status: 'FAILED', failureCode: code, finishedAt: at },
    });
  }

  async failInFlight(code: string, at: Date) {
    const { count } = await this.prisma.noteDraft.updateMany({
      where: { status: { in: IN_FLIGHT } },
      data: { status: 'FAILED', failureCode: code, finishedAt: at },
    });
    return count;
  }
}

/** The two unique guarantees of the table: another draft got there first. */
function refusedAsTaken(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function toStored(row: Prisma.NoteDraftGetPayload<object>): StoredNoteDraft {
  return {
    id: row.id,
    encounterId: row.encounterId,
    upToMs: row.upToMs,
    // `note_draft_status_known` admits only these.
    status: row.status as NoteDraftStatus,
    failureCode: row.failureCode,
    requestedBy: row.requestedBy,
    aiRunId: row.aiRunId,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
