import type { BoardField } from '../../../shared/domain/board-fields';

import type { AgendaEntryStatus, PatientSubjectStatus } from './agenda-entry';
import type { AgendaEntryView } from './agenda.repository';
import type { BoardViewRow } from './board';

/** AG-133. One site's clinical day, as instants already resolved in Guayaquil. */
export interface BoardQuery {
  siteId: string;
  from: Date;
  untilExclusive: Date;
  practitionerId?: string;
  /** Narrowed by the practitioners who practise it (`practitioner_specialty`). */
  specialtyId?: string;
}

/** AG-134. A staff row: the entry as the day listing serves it, plus what the board adds. */
export interface StaffBoardEntry {
  entry: AgendaEntryView;
  practitionerName: string;
  roomName: string | null;
  boardNote: string | null;
  /** AG-176. Who wrote the note last, and when; `null` if nobody ever did. */
  boardNoteStamp: { byName: string; at: Date } | null;
  /** AG-135. The last row of `agenda_status_history`. */
  lastStatusChangeAt: Date | null;
}

/**
 * AG-137. What the waiting-room projection is built from — and NOTHING else is
 * loaded: no identifier, no document, no reason, no note. A value never read
 * cannot leak into the response.
 */
export interface PublicBoardEntry {
  startsAt: Date;
  givenName: string;
  familyName: string;
  practitionerName: string;
  roomName: string | null;
  status: AgendaEntryStatus;
  subjectStatus: PatientSubjectStatus | null;
  subjectStatusAt: Date | null;
  checkedInAt: Date | null;
}

/** AG-138. A role and the optional fields its view carries. */
export interface RoleBoardView {
  roleId: string;
  roleCode: string;
  roleName: string;
  active: boolean;
  fields: BoardField[];
}

export type BoardNoteOutcome =
  | {
      kind: 'UPDATED';
      boardNote: string | null;
      boardNoteStamp: { byName: string; at: Date };
    }
  | { kind: 'NOT_FOUND' }
  | { kind: 'BLOCK' };

export interface BoardRepository {
  /** AG-133, AG-134. Appointments only, released included, by instant. */
  staffBoard(query: BoardQuery): Promise<StaffBoardEntry[]>;
  /** AG-137. Appointments only, live ones only, by instant. */
  publicBoard(
    query: Pick<BoardQuery, 'siteId' | 'from' | 'untilExclusive'>,
  ): Promise<PublicBoardEntry[]>;
  /** AG-138. The stored view rows of these role codes. */
  viewsOf(roleCodes: readonly string[]): Promise<BoardViewRow[]>;
  /** AG-138. Every role, with its view, for the administration screen. */
  listViews(): Promise<RoleBoardView[]>;
  /**
   * AG-138. Replaces a role's view in one transaction and answers what it was,
   * or `null` when the role does not exist.
   */
  replaceView(input: {
    roleId: string;
    fields: readonly BoardField[];
    changedById: string;
    at: Date;
  }): Promise<{ before: BoardField[]; after: BoardField[] } | null>;
  /** AG-176. Writes the note and nothing else of the entry. */
  setBoardNote(input: {
    siteId: string;
    entryId: string;
    boardNote: string | null;
    writtenById: string;
    at: Date;
  }): Promise<BoardNoteOutcome>;
}

export const BOARD_REPOSITORY = Symbol('BoardRepository');
