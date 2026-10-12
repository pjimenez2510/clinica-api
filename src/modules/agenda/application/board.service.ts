import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  type ClinicalDate,
  clinicalDateOf,
  clinicalDayBounds,
} from '../../../shared/domain/clinic-time';
import type { BoardField } from '../../../shared/domain/board-fields';
import {
  AgendaEntryNotFoundError,
  BoardNoteNeedsAPatientError,
  BoardNoteNotTodayError,
  BoardViewRoleNotFoundError,
} from '../domain/agenda.errors';
import {
  AGENDA_REPOSITORY,
  type AgendaEntryView,
  type AgendaRepository,
  type AgendaSite,
  type SiteScopeFilter,
} from '../domain/agenda.repository';
import {
  boardNoteEditable,
  isPresentToday,
  needsInPersonNotice,
  latenessMinutes,
  minutesInState,
  normaliseBoardNote,
  type PublicBoardState,
  publicIdentification,
  publicStateOf,
  resolveBoardFields,
  stateSinceOf,
} from '../domain/board';
import {
  BOARD_REPOSITORY,
  type BoardRepository,
  type RoleBoardView,
} from '../domain/board.repository';

/** Who is looking, for the view (AG-138) and for the trail (AG-139). */
export interface BoardViewer {
  userId: string;
  /** The roles held AT THIS SITE that carry the route's permission. */
  roleCodes: readonly string[];
  ip?: string;
  userAgent?: string;
}

/** AG-134. A staff row; a field the viewer's view lacks travels `null`. */
export interface StaffBoardRow {
  entry: AgendaEntryView;
  practitionerName: string | null;
  roomName: string | null;
  boardNote: string | null;
  boardNoteStamp: { byName: string; at: Date } | null;
  stateSince: Date | null;
  minutesInState: number | null;
  latenessMinutes: number | null;
  /** AG-183. Nobody acknowledged the emergency in two minutes. */
  emergencyNeedsInPersonNotice: boolean;
  /** AG-184. Whether the note of this row can be written now. */
  boardNoteEditable: boolean;
}

export interface StaffBoard {
  fields: BoardField[];
  generatedAt: Date;
  rows: StaffBoardRow[];
}

/** AG-137. A waiting-room row: nothing that identifies the record. */
export interface PublicBoardRow {
  startsAt: Date;
  displayName: string;
  practitionerName: string;
  roomName: string | null;
  state: PublicBoardState;
}

export interface PublicBoard {
  date: ClinicalDate;
  generatedAt: Date;
  rows: PublicBoardRow[];
}

/**
 * The day board, its two projections, its views per role and its note.
 *
 * A SERVICE OF ITS OWN (ADR-008 §2): it shares no method with booking, it is
 * the only reader of the agenda that writes to `access_audit` (AG-139), and
 * it changes for its own reasons — who sees which column (AG-138), what the
 * waiting room may read (D-176). It reads the agenda's port for one thing,
 * the sites in scope.
 */
@Injectable()
export class BoardService {
  constructor(
    @Inject(BOARD_REPOSITORY) private readonly board: BoardRepository,
    @Inject(AGENDA_REPOSITORY) private readonly agenda: AgendaRepository,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * AG-133 to AG-135, AG-138, AG-139. The staff projection of one day.
   *
   * ONE AUDIT ROW PER CONSULTATION, NEVER ONE PER ROW (AG-139, SC-004): it
   * answers «who was looking at the board at eleven» without burying the
   * chart accesses that matter.
   */
  async staffBoard(
    request: {
      siteId: string;
      date: ClinicalDate;
      practitionerId?: string;
      specialtyId?: string;
    },
    viewer: BoardViewer,
  ): Promise<StaffBoard> {
    // Taken ONCE: every row counts against the same instant, and it is the
    // application's clock — the one the walks move — never PostgreSQL's.
    const now = new Date();
    const { startsAt, endsAtExclusive } = clinicalDayBounds(request.date);

    const [entries, views] = await Promise.all([
      this.board.staffBoard({
        siteId: request.siteId,
        from: startsAt,
        untilExclusive: endsAtExclusive,
        practitionerId: request.practitionerId,
        specialtyId: request.specialtyId,
      }),
      this.board.viewsOf(viewer.roleCodes),
    ]);
    const fields = resolveBoardFields(viewer.roleCodes, views);
    const shows = (field: BoardField) => fields.includes(field);

    await this.audit.record({
      userId: viewer.userId,
      resourceType: 'agenda_board_staff',
      resourceId: request.siteId,
      action: 'READ',
      ip: viewer.ip,
      userAgent: viewer.userAgent,
    });

    return {
      fields,
      generatedAt: now,
      rows: entries.map((row) => {
        const subject = {
          ...row.entry,
          lastStatusChangeAt: row.lastStatusChangeAt,
        };
        return {
          entry: row.entry,
          practitionerName: shows('PRACTITIONER') ? row.practitionerName : null,
          roomName: shows('ROOM') ? row.roomName : null,
          boardNote: shows('BOARD_NOTE') ? row.boardNote : null,
          boardNoteStamp: shows('BOARD_NOTE') ? row.boardNoteStamp : null,
          stateSince: shows('TIME_IN_STATE') ? stateSinceOf(subject) : null,
          minutesInState: shows('TIME_IN_STATE')
            ? minutesInState(subject, now)
            : null,
          latenessMinutes: shows('LATENESS')
            ? latenessMinutes(subject, now)
            : null,
          // AG-183: beside the «Emergencia» mark, which no view removes.
          emergencyNeedsInPersonNotice: needsInPersonNotice(row.entry, now),
          boardNoteEditable: boardNoteEditable(row.entry, now),
        };
      }),
    };
  }

  /**
   * AG-136, AG-137, AG-139. The waiting-room projection: TODAY only — the
   * route takes no date — and only who is in the building (D-176.2).
   */
  async publicBoard(siteId: string, viewer: BoardViewer): Promise<PublicBoard> {
    const now = new Date();
    const date = clinicalDateOf(now);
    const { startsAt, endsAtExclusive } = clinicalDayBounds(date);

    const entries = await this.board.publicBoard({
      siteId,
      from: startsAt,
      untilExclusive: endsAtExclusive,
    });

    await this.audit.record({
      userId: viewer.userId,
      resourceType: 'agenda_board_public',
      resourceId: siteId,
      action: 'READ',
      ip: viewer.ip,
      userAgent: viewer.userAgent,
    });

    return {
      date,
      generatedAt: now,
      rows: entries
        .filter((entry) =>
          isPresentToday({ ...entry, lastStatusChangeAt: null }),
        )
        .map((entry) => ({
          startsAt: entry.startsAt,
          displayName: publicIdentification(entry.givenName, entry.familyName),
          practitionerName: entry.practitionerName,
          roomName: entry.roomName,
          state: publicStateOf({ ...entry, lastStatusChangeAt: null }),
        })),
    };
  }

  /** AG-136. The sites the waiting-room screen may show, by name. */
  async publicSites(scope: SiteScopeFilter): Promise<AgendaSite[]> {
    return this.agenda.listSites(scope);
  }

  /**
   * AG-176. Writes the short note and nothing else of the entry.
   *
   * Last write wins, deliberately: it is a sticky note. Its stamp says who
   * wrote it last and when; earlier notes are not kept (minimisation).
   */
  async setBoardNote(
    request: { siteId: string; entryId: string; boardNote: string | null },
    writer: { userId: string; ip?: string; userAgent?: string },
  ): Promise<{
    boardNote: string | null;
    boardNoteStamp: { byName: string; at: Date };
  }> {
    // The application's clock, like every instant the screen shows; and
    // AG-184's «today» is its Guayaquil day, never the session's.
    const at = new Date();
    const { startsAt, endsAtExclusive } = clinicalDayBounds(clinicalDateOf(at));
    const outcome = await this.board.setBoardNote({
      siteId: request.siteId,
      entryId: request.entryId,
      boardNote: normaliseBoardNote(request.boardNote),
      writtenById: writer.userId,
      at,
      today: { from: startsAt, untilExclusive: endsAtExclusive },
      ip: writer.ip,
      userAgent: writer.userAgent,
    });
    if (outcome.kind === 'NOT_FOUND') throw new AgendaEntryNotFoundError();
    if (outcome.kind === 'BLOCK') throw new BoardNoteNeedsAPatientError();
    if (outcome.kind === 'NOT_TODAY') throw new BoardNoteNotTodayError();
    return {
      boardNote: outcome.boardNote,
      boardNoteStamp: outcome.boardNoteStamp,
    };
  }

  /** AG-138. Every role with its view, for the administration screen. */
  async listViews(): Promise<RoleBoardView[]> {
    return this.board.listViews();
  }

  /**
   * AG-138. Replaces a role's view, and leaves the change in the trail.
   *
   * The trail row carries no payload: `access_audit` admits one only for the
   * resource types its `CHECK` declares, and widening that list is a decision
   * about personal data (D-017). What the view is now is readable from the
   * route; who changed it and when is the row.
   */
  async replaceView(
    request: { roleId: string; fields: readonly BoardField[] },
    actor: { userId: string; ip?: string; userAgent?: string },
  ): Promise<RoleBoardView['fields']> {
    const result = await this.board.replaceView({
      roleId: request.roleId,
      fields: request.fields,
      changedById: actor.userId,
      at: new Date(),
    });
    if (result === null) throw new BoardViewRoleNotFoundError();

    await this.audit.record({
      userId: actor.userId,
      resourceType: 'agenda_board_view',
      resourceId: request.roleId,
      action: 'UPDATE',
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return result.after;
  }
}
