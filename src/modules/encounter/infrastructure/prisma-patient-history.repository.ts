import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  chartScope,
  chartScopeIds,
} from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  HistoryAlreadyRefutedError,
  HistoryNotRefutedError,
} from '../domain/encounter.errors';
import type {
  EditHistory,
  HistoryAuthor,
  HistoryVersionView,
  HistoryView,
  NewHistory,
  PatientHistoryKind,
  PatientHistoryRepository,
  ReactivateHistory,
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
  changedAt: true,
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
   * EN-085, EN-219. Refutes a LIVE entry, once, under the row lock: a second
   * refutation is an answer rather than an overwrite, and the trigger refuses
   * it anyway for any writer that did not come through here. The reason is
   * optional; the live entry stays as the version.
   */
  async refute(refutation: RefuteHistory): Promise<HistoryView | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockHistory(
        tx,
        refutation.patientId,
        refutation.historyId,
      );
      if (current === null) return null;
      if (current.refuted_at !== null) throw new HistoryAlreadyRefutedError();

      const row = await tx.patientHistory.update({
        where: { id: current.id },
        data: {
          refutedAt: refutation.now,
          refutedNotes: refutation.notes,
          refutedById: refutation.refutedById,
          // EN-219. A stamped change: the live entry is the version kept.
          changedById: refutation.refutedById,
          changedAt: stampAfter(current.changed_at, refutation.now),
        },
        select: HISTORY_SELECT,
      });
      return toHistoryView(row);
    });
  }

  /**
   * EN-220. Edits what a live entry says, under the row lock, with a new
   * stamp; `record_version_archive` keeps the row it replaces. A personal
   * entry has no relative, so moving to `PERSONAL` clears it; the database
   * still demands one for `FAMILY` (`patient_history_family_names_relative`).
   */
  async edit(edit: EditHistory): Promise<HistoryView | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockHistory(tx, edit.patientId, edit.historyId);
      if (current === null) return null;
      if (current.refuted_at !== null) throw new HistoryAlreadyRefutedError();

      const { changes } = edit;
      const data: Prisma.PatientHistoryUncheckedUpdateInput = {};
      if (changes.kind !== undefined && changes.kind !== current.kind) {
        data.kind = changes.kind;
      }
      if (
        changes.description !== undefined &&
        changes.description !== current.description
      ) {
        data.description = changes.description;
      }
      // Moving to `PERSONAL` clears the relative; one SENT is written as
      // sent, and `patient_history_family_names_relative` judges it.
      const relative =
        changes.relative !== undefined
          ? changes.relative
          : (changes.kind ?? current.kind) === 'PERSONAL'
            ? null
            : current.relative;
      if (relative !== current.relative) data.relative = relative;

      if (Object.keys(data).length === 0) {
        const row = await tx.patientHistory.findUniqueOrThrow({
          where: { id: current.id },
          select: HISTORY_SELECT,
        });
        return toHistoryView(row);
      }

      const row = await tx.patientHistory.update({
        where: { id: current.id },
        data: {
          ...data,
          changedById: edit.editedById,
          changedAt: stampAfter(current.changed_at, edit.now),
        },
        select: HISTORY_SELECT,
      });
      return toHistoryView(row);
    });
  }

  /** EN-219. Back to live; the refutation stays in the version left behind. */
  async reactivate(
    reactivation: ReactivateHistory,
  ): Promise<HistoryView | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockHistory(
        tx,
        reactivation.patientId,
        reactivation.historyId,
      );
      if (current === null) return null;
      if (current.refuted_at === null) throw new HistoryNotRefutedError();

      const row = await tx.patientHistory.update({
        where: { id: current.id },
        data: {
          refutedAt: null,
          refutedNotes: null,
          refutedById: null,
          changedById: reactivation.reactivatedById,
          changedAt: stampAfter(current.changed_at, reactivation.now),
        },
        select: HISTORY_SELECT,
      });
      return toHistoryView(row);
    });
  }

  /**
   * EN-220. The versions the changes replaced, newest first, through the
   * SAME mapping as the live entry.
   */
  async versionsOf(
    chartId: string,
    historyId: string,
  ): Promise<HistoryVersionView[] | null> {
    const visible = await this.prisma.patientHistory.count({
      where: { id: historyId, ...chartScope(chartId) },
    });
    if (visible === 0) return null;

    const versions = await this.prisma.recordVersion.findMany({
      where: { resourceType: 'patient_history', resourceId: historyId },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        data: true,
        changedAt: true,
        changedBy: AUTHOR_SELECT,
      },
    });
    const snapshots = versions.map(
      (version) => version.data as unknown as HistorySnapshot,
    );
    const ids = [
      ...new Set(
        snapshots.flatMap((snapshot) =>
          [snapshot.recorded_by, snapshot.refuted_by].filter(
            (id): id is string => id !== null,
          ),
        ),
      ),
    ];
    const authors = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, firstName: true, lastName: true },
        })
      ).map((user) => [user.id, user]),
    );

    return versions.map((version, index) => ({
      version: version.version,
      replacedBy: authorOf(version.changedBy),
      replacedAt: version.changedAt,
      entry: toHistoryView(historyRowFromSnapshot(snapshots[index]!, authors)),
    }));
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

  /** Answered by `patient_history_patient_id_refuted_at_idx`. */
  async activeFor(chartId: string): Promise<HistoryView[]> {
    const rows = await this.prisma.patientHistory.findMany({
      where: { ...chartScope(chartId), refutedAt: null },
      select: HISTORY_SELECT,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
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
    changedAt: row.changedAt,
  };
}

type AuthorRow = { id: string; firstName: string; lastName: string };

/** The columns the row has inside `record_version.data` (`to_jsonb(OLD)`). */
interface HistorySnapshot {
  id: string;
  patient_id: string;
  kind: PatientHistoryKind;
  description: string;
  relative: string | null;
  recorded_by: string;
  recorded_at: string;
  refuted_at: string | null;
  refuted_notes: string | null;
  refuted_by: string | null;
  changed_at: string | null;
}

/**
 * A version as the row it was. An author id with no account behind it
 * cannot happen (`RESTRICT`), so the fallback only keeps the shape whole.
 */
function historyRowFromSnapshot(
  snapshot: HistorySnapshot,
  authors: Map<string, AuthorRow>,
): HistoryRow {
  const author = (id: string): AuthorRow =>
    authors.get(id) ?? { id, firstName: '', lastName: '' };
  return {
    id: snapshot.id,
    patientId: snapshot.patient_id,
    kind: snapshot.kind,
    description: snapshot.description,
    relative: snapshot.relative,
    recordedAt: new Date(snapshot.recorded_at),
    recordedBy: author(snapshot.recorded_by),
    refutedAt:
      snapshot.refuted_at === null ? null : new Date(snapshot.refuted_at),
    refutedNotes: snapshot.refuted_notes,
    refutedBy:
      snapshot.refuted_by === null ? null : author(snapshot.refuted_by),
    changedAt:
      snapshot.changed_at === null ? null : new Date(snapshot.changed_at),
  };
}

interface LockedHistory {
  id: string;
  kind: PatientHistoryKind;
  description: string;
  relative: string | null;
  refuted_at: Date | null;
  changed_at: Date | null;
}

/** The entry, LOCKED, if it is on this chart or one it absorbed. */
async function lockHistory(
  tx: Prisma.TransactionClient,
  chartId: string,
  historyId: string,
): Promise<LockedHistory | null> {
  const [row] = await tx.$queryRaw<LockedHistory[]>`
    SELECT id, kind::text AS kind, description, relative, refuted_at, changed_at
      FROM patient_history
     WHERE id = ${historyId}::uuid
       AND patient_id IN ${chartScopeIds(chartId)}
       FOR UPDATE`;
  return row ?? null;
}

/** EN-210: a second change in the same millisecond moves past the first. */
function stampAfter(previous: Date | null, now: Date): Date {
  return previous && previous >= now ? new Date(previous.getTime() + 1) : now;
}
