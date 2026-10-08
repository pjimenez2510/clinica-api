import {
  BOARD_FIELDS,
  type BoardField,
  isBoardField,
} from '../../../shared/domain/board-fields';

import type { AgendaEntryStatus, PatientSubjectStatus } from './agenda-entry';

/**
 * AG-133 to AG-138. What the day board derives from a row, PURE: the instant
 * of "now" comes in as a parameter, because the domain owns no clock.
 */

/** The part of an entry the board's arithmetic reads. */
export interface BoardSubject {
  status: AgendaEntryStatus;
  subjectStatus: PatientSubjectStatus | null;
  subjectStatusAt: Date | null;
  /**
   * The last row of `agenda_status_history` for the entry. `null` only for a
   * row that never had one, which the triggers make impossible for anything
   * booked through the system — but the type does not pretend.
   */
  lastStatusChangeAt: Date | null;
  startsAt: Date;
  checkedInAt: Date | null;
}

/**
 * AG-135. When the row entered the state it is in.
 *
 * The PATIENT's axis when there is one — it is the finer one and the one that
 * moves during the visit — and the APPOINTMENT's otherwise (AG-127: before the
 * arrival there is no patient state).
 */
export function stateSinceOf(row: BoardSubject): Date | null {
  if (row.subjectStatus !== null && row.subjectStatusAt !== null) {
    return row.subjectStatusAt;
  }
  return row.lastStatusChangeAt;
}

const MINUTE = 60_000;

/**
 * AG-135. Whole minutes in the current state, against the APPLICATION's clock
 * handed in by the caller — never PostgreSQL's `now()`, which the walks do not
 * move. Clamped at zero: a clock a few seconds behind reads «0», not «-1».
 */
export function minutesInState(row: BoardSubject, now: Date): number | null {
  const since = stateSinceOf(row);
  if (since === null) return null;
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / MINUTE));
}

/** Statuses after which nobody is coming any more. */
const NOT_COMING: ReadonlySet<AgendaEntryStatus> = new Set([
  'CANCELLED',
  'NO_SHOW',
  'ENTERED_IN_ERROR',
  'FULFILLED',
  'LEFT_WITHOUT_BEING_SEEN',
]);

/**
 * AG-134, AG-118. How late, in whole minutes, or `null` when there is no
 * lateness to show.
 *
 * A SUBTRACTION AND NOT A STATE (D-A-009). Before the arrival it is how far the
 * hour has passed — what tells reception somebody's turn went by. After it, it
 * is how late the arrival was, which stops moving. An early arrival, a closed
 * row that never arrived, or an hour still ahead: nothing.
 */
export function latenessMinutes(row: BoardSubject, now: Date): number | null {
  const reference =
    row.checkedInAt ?? (NOT_COMING.has(row.status) ? null : now);
  if (reference === null) return null;
  const minutes = Math.floor(
    (reference.getTime() - row.startsAt.getTime()) / MINUTE,
  );
  return minutes > 0 ? minutes : null;
}

/** A grant as the principal resolves it: a role, at a site or everywhere. */
export interface BoardGrant {
  roleCode: string;
  siteId: string | null;
  permissions: readonly string[];
}

/**
 * AG-138. The roles that shape THIS site's board: held here or everywhere,
 * and carrying the route's permission. A role granted only at another site
 * does not change what this site's board shows.
 */
export function rolesShapingBoard(
  grants: readonly BoardGrant[],
  siteId: string,
  permission: string,
): string[] {
  return [
    ...new Set(
      grants
        .filter(
          (grant) =>
            (grant.siteId === null || grant.siteId === siteId) &&
            grant.permissions.includes(permission),
        )
        .map((grant) => grant.roleCode),
    ),
  ];
}

/** A role's stored view row, as the repository reads it. */
export interface BoardViewRow {
  roleCode: string;
  field: string;
}

/**
 * AG-138. The optional fields this caller sees: the UNION of the views of the
 * roles they hold at the site, in the catalogue's order.
 *
 * CLOSED BY DEFAULT — a role without rows contributes nothing — and a value the
 * code does not know is dropped rather than served: the `CHECK` in the base
 * already refuses it, and this is the second fence, not the first.
 */
export function resolveBoardFields(
  roleCodes: readonly string[],
  views: readonly BoardViewRow[],
): BoardField[] {
  const held = new Set(roleCodes);
  const granted = new Set(
    views
      .filter((view) => held.has(view.roleCode))
      .map((view) => view.field)
      .filter(isBoardField),
  );
  return BOARD_FIELDS.filter((field) => granted.has(field));
}

/**
 * AG-137, D-176.1. The first given name and the initial of the first surname
 * — «María A.» — which is enough to call somebody and no more.
 *
 * The first WORD of each, because the register keeps both given names and
 * both surnames in one column each («María José», «Andrade López»).
 */
export function publicIdentification(
  givenName: string,
  familyName: string,
): string {
  const first = givenName.trim().split(/\s+/)[0] ?? '';
  const name = first.charAt(0).toLocaleUpperCase('es-EC') + first.slice(1);
  const initial = familyName.trim().charAt(0).toLocaleUpperCase('es-EC');
  return [name, initial === '' ? '' : `${initial}.`].filter(Boolean).join(' ');
}

/**
 * AG-137, D-176.2. Whether the person is in the building today: arrived, and
 * neither gone nor out on an errand. Only these appear on the waiting-room
 * screen — a list of who is booked would tell the room who is coming, and when.
 */
export function isPresentToday(row: BoardSubject): boolean {
  if (row.status !== 'CHECKED_IN' && row.status !== 'IN_PROGRESS') {
    return false;
  }
  return row.subjectStatus !== 'ON_LEAVE' && row.subjectStatus !== 'DEPARTED';
}

/** AG-137. The coarse state the waiting room reads. */
export type PublicBoardState = 'WAITING' | 'IN_PREPARATION' | 'IN_CARE';

export function publicStateOf(row: BoardSubject): PublicBoardState {
  if (row.subjectStatus === 'IN_PREPARATION') return 'IN_PREPARATION';
  if (row.status === 'IN_PROGRESS' || row.subjectStatus === 'RECEIVING_CARE') {
    return 'IN_CARE';
  }
  return 'WAITING';
}

/** AG-176. The longest note the column holds (`varchar(120)`). */
export const BOARD_NOTE_MAX = 120;

/**
 * AG-176. A note as it is stored: trimmed, and EMPTY MEANS NONE — a blank
 * note is how somebody clears it, and a row of spaces on the board reads as a
 * note that says nothing.
 */
export function normaliseBoardNote(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
