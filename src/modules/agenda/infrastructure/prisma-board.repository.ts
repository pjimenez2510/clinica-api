import { Injectable } from '@nestjs/common';

import {
  BOARD_FIELDS,
  type BoardField,
} from '../../../shared/domain/board-fields';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { BoardViewRow } from '../domain/board';
import type {
  BoardNoteOutcome,
  BoardQuery,
  BoardRepository,
  PublicBoardEntry,
  RoleBoardView,
  StaffBoardEntry,
} from '../domain/board.repository';

import { ENTRY_SELECT, toEntryView } from './prisma-agenda.repository';

/** The fields of a view in the catalogue's order, whatever order the rows came in. */
function inCatalogueOrder(fields: readonly string[]): BoardField[] {
  const stored = new Set(fields);
  return BOARD_FIELDS.filter((field) => stored.has(field));
}

const fullName = (user: { firstName: string; lastName: string }) =>
  `${user.firstName} ${user.lastName}`.trim();

/** AG-133 to AG-138, AG-176. The board's reads and its two writes. */
@Injectable()
export class PrismaBoardRepository implements BoardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * AG-133, AG-134. The day listing's entry, plus the names and the note.
   *
   * THE LAST STATUS CHANGE IS ONE GROUPED READ, not a join per row: the
   * `(agenda_entry_id, changed_at)` index answers `max(changed_at)` for the
   * day's entries in one pass.
   */
  async staffBoard(query: BoardQuery): Promise<StaffBoardEntry[]> {
    const rows = await this.prisma.agendaEntry.findMany({
      where: {
        siteId: query.siteId,
        kind: 'APPOINTMENT',
        startsAt: { lt: query.untilExclusive },
        endsAt: { gt: query.from },
        ...(query.practitionerId
          ? { practitionerId: query.practitionerId }
          : {}),
        ...(query.specialtyId
          ? {
              practitioner: {
                specialties: { some: { specialtyId: query.specialtyId } },
              },
            }
          : {}),
      },
      // AG-133: by the appointment's instant; `id` keeps two at the same
      // minute in a stable order between two polls.
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: {
        ...ENTRY_SELECT,
        boardNote: true,
        boardNoteAt: true,
        boardNoteBy: { select: { firstName: true, lastName: true } },
        practitioner: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
        room: { select: { name: true } },
      },
    });

    const lastChanges = rows.length
      ? await this.prisma.agendaStatusHistory.groupBy({
          by: ['agendaEntryId'],
          where: { agendaEntryId: { in: rows.map((row) => row.id) } },
          _max: { changedAt: true },
        })
      : [];
    const lastChangeOf = new Map(
      lastChanges.map((change) => [
        change.agendaEntryId,
        change._max.changedAt,
      ]),
    );

    return rows.map((row) => ({
      entry: toEntryView(row),
      practitionerName: fullName(row.practitioner.user),
      roomName: row.room?.name ?? null,
      boardNote: row.boardNote,
      // The pair is both-or-neither in the base (`agenda_entry_board_note_stamped`).
      boardNoteStamp:
        row.boardNoteBy && row.boardNoteAt
          ? { byName: fullName(row.boardNoteBy), at: row.boardNoteAt }
          : null,
      lastStatusChangeAt: lastChangeOf.get(row.id) ?? null,
    }));
  }

  /**
   * AG-137. ONLY what the projection is made of is selected — no identifier,
   * no document, no reason, no note — so none of it can reach the response.
   * The presence filter starts here (arrived and not finished) and the domain
   * finishes it with the patient's axis.
   */
  async publicBoard(
    query: Pick<BoardQuery, 'siteId' | 'from' | 'untilExclusive'>,
  ): Promise<PublicBoardEntry[]> {
    const rows = await this.prisma.agendaEntry.findMany({
      where: {
        siteId: query.siteId,
        kind: 'APPOINTMENT',
        releasedAt: null,
        status: { in: ['CHECKED_IN', 'IN_PROGRESS'] },
        startsAt: { lt: query.untilExclusive },
        endsAt: { gt: query.from },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: {
        startsAt: true,
        status: true,
        subjectStatus: true,
        subjectStatusAt: true,
        checkedInAt: true,
        patient: { select: { givenName: true, familyName: true } },
        practitioner: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
        room: { select: { name: true } },
      },
    });

    return rows.flatMap((row) =>
      row.patient
        ? [
            {
              startsAt: row.startsAt,
              givenName: row.patient.givenName,
              familyName: row.patient.familyName,
              practitionerName: fullName(row.practitioner.user),
              roomName: row.room?.name ?? null,
              status: row.status,
              subjectStatus: row.subjectStatus,
              subjectStatusAt: row.subjectStatusAt,
              checkedInAt: row.checkedInAt,
            },
          ]
        : [],
    );
  }

  /** AG-138. Only active roles count: a deactivated role grants nothing. */
  async viewsOf(roleCodes: readonly string[]): Promise<BoardViewRow[]> {
    if (roleCodes.length === 0) return [];
    const rows = await this.prisma.boardViewField.findMany({
      where: { role: { code: { in: [...roleCodes] }, active: true } },
      select: { field: true, role: { select: { code: true } } },
    });
    return rows.map((row) => ({ roleCode: row.role.code, field: row.field }));
  }

  async listViews(): Promise<RoleBoardView[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
        boardViewFields: { select: { field: true } },
      },
    });
    return roles.map((role) => ({
      roleId: role.id,
      roleCode: role.code,
      roleName: role.name,
      active: role.active,
      fields: inCatalogueOrder(role.boardViewFields.map((row) => row.field)),
    }));
  }

  /**
   * AG-138. Delete and insert in one transaction: a reader between the two
   * statements would otherwise see a role with no view at all.
   */
  async replaceView(input: {
    roleId: string;
    fields: readonly BoardField[];
    changedById: string;
    at: Date;
  }): Promise<{ before: BoardField[]; after: BoardField[] } | null> {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: input.roleId },
        select: { boardViewFields: { select: { field: true } } },
      });
      if (!role) return null;

      const before = inCatalogueOrder(
        role.boardViewFields.map((row) => row.field),
      );
      const after = inCatalogueOrder(input.fields);

      await tx.boardViewField.deleteMany({ where: { roleId: input.roleId } });
      await tx.boardViewField.createMany({
        data: after.map((field) => ({
          roleId: input.roleId,
          field,
          createdAt: input.at,
          createdById: input.changedById,
        })),
      });
      return { before, after };
    });
  }

  /**
   * AG-176. A conditional UPDATE touching the note and its stamp only: the site and the kind
   * are in the predicate, so a note cannot land on another site's entry nor
   * on a block, and nothing else of the row is in the statement. Only when it
   * matches nothing is the row read, to tell «not here» from «a block».
   */
  async setBoardNote(input: {
    siteId: string;
    entryId: string;
    boardNote: string | null;
    writtenById: string;
    at: Date;
  }): Promise<BoardNoteOutcome> {
    const updated = await this.prisma.agendaEntry.updateMany({
      where: { id: input.entryId, siteId: input.siteId, kind: 'APPOINTMENT' },
      data: {
        boardNote: input.boardNote,
        boardNoteById: input.writtenById,
        boardNoteAt: input.at,
      },
    });
    if (updated.count === 1) {
      const writer = await this.prisma.user.findUniqueOrThrow({
        where: { id: input.writtenById },
        select: { firstName: true, lastName: true },
      });
      return {
        kind: 'UPDATED',
        boardNote: input.boardNote,
        boardNoteStamp: { byName: fullName(writer), at: input.at },
      };
    }

    const existing = await this.prisma.agendaEntry.findFirst({
      where: { id: input.entryId, siteId: input.siteId },
      select: { kind: true },
    });
    return existing ? { kind: 'BLOCK' } : { kind: 'NOT_FOUND' };
  }
}
