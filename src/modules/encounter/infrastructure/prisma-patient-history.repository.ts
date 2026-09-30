import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { HistoryAlreadyRefutedError } from '../domain/encounter.errors';
import type {
  HistoryAuthor,
  HistoryView,
  NewHistory,
  PatientHistoryRepository,
  RefuteHistory,
} from '../domain/patient-history.repository';

const AUTHOR_SELECT = { select: { id: true, firstName: true, lastName: true } };

const HISTORY_SELECT = {
  id: true,
  patientId: true,
  kind: true,
  description: true,
  relative: true,
  recordedAt: true,
  recordedBy: AUTHOR_SELECT,
  refutedAt: true,
  refutedNotes: true,
  refutedBy: AUTHOR_SELECT,
} satisfies Prisma.PatientHistorySelect;

type HistoryRow = Prisma.PatientHistoryGetPayload<{
  select: typeof HISTORY_SELECT;
}>;

/**
 * EN-085 over PostgreSQL. The guarantees are the database's —
 * `trg_patient_history_append_only`, `patient_history_family_names_relative`,
 * `patient_history_refutation_is_whole`—; this adapter only asks.
 */
@Injectable()
export class PrismaPatientHistoryRepository implements PatientHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: NewHistory): Promise<HistoryView> {
    const row = await this.prisma.patientHistory.create({
      data: {
        patientId: entry.patientId,
        kind: entry.kind,
        description: entry.description,
        relative: entry.relative,
        recordedById: entry.recordedById,
        // `recorded_at` is the column default: the history is said out loud
        // and typed in the same breath, like an allergy.
      },
      select: HISTORY_SELECT,
    });
    return toHistoryView(row);
  }

  /**
   * EN-085. Refutes a LIVE entry, once. The `refutedAt: null` in the `where`
   * is what makes a second refutation an answer rather than an overwrite;
   * the trigger refuses it anyway for any writer that did not come through
   * here.
   */
  async refute(refutation: RefuteHistory): Promise<HistoryView | null> {
    return this.prisma.$transaction(async (tx) => {
      const scoped = {
        id: refutation.historyId,
        ...chartScope(refutation.patientId),
      };
      const { count } = await tx.patientHistory.updateMany({
        where: { ...scoped, refutedAt: null },
        data: {
          refutedAt: refutation.now,
          refutedNotes: refutation.notes,
          refutedById: refutation.refutedById,
        },
      });

      if (count === 0) {
        const existing = await tx.patientHistory.findFirst({
          where: scoped,
          select: { id: true },
        });
        if (existing === null) return null;
        throw new HistoryAlreadyRefutedError();
      }

      const row = await tx.patientHistory.findFirstOrThrow({
        where: scoped,
        select: HISTORY_SELECT,
      });
      return toHistoryView(row);
    });
  }

  async listFor(chartId: string): Promise<HistoryView[]> {
    const rows = await this.prisma.patientHistory.findMany({
      where: { ...chartScope(chartId) },
      select: HISTORY_SELECT,
      orderBy: [
        { refutedAt: { sort: 'asc', nulls: 'first' } },
        { recordedAt: 'desc' },
        { id: 'desc' },
      ],
    });
    return rows.map(toHistoryView);
  }
}

function authorOf(user: {
  id: string;
  firstName: string;
  lastName: string;
}): HistoryAuthor {
  return { id: user.id, name: `${user.firstName} ${user.lastName}` };
}

function toHistoryView(row: HistoryRow): HistoryView {
  return {
    id: row.id,
    patientId: row.patientId,
    kind: row.kind,
    description: row.description,
    relative: row.relative,
    recordedAt: row.recordedAt,
    recordedBy: authorOf(row.recordedBy),
    refutedAt: row.refutedAt,
    refutedNotes: row.refutedNotes,
    refutedBy: row.refutedBy === null ? null : authorOf(row.refutedBy),
  };
}
