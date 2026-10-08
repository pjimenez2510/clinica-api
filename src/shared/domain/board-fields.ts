/**
 * AG-138. The optional columns of the day board — a closed union.
 *
 * WHICH FIELDS EXIST IS CODE; WHICH ROLE SEES WHICH IS CONFIGURATION
 * (`board_view_field`), the same split as `permission.catalogue.ts`. A new
 * field here forces a decision about who sees it, and the base repeats the
 * list in `board_view_field_known_field` so a hand-written row cannot name a
 * field the code ignores.
 *
 * NOT CONFIGURABLE, and therefore absent: the time of the appointment, the
 * patient, the state and the emergency call. Without them there is no board,
 * and an emergency hidden by a view is what Ley 77 art. 10 does not admit.
 *
 * In `shared/` because two modules read it: `agenda` serves the board, and
 * `auth` ships the starting view of each default role. Kept as plain data —
 * the seed runs it with type stripping.
 */
export const BOARD_FIELDS = [
  'PRACTITIONER',
  'ROOM',
  'TIME_IN_STATE',
  'LATENESS',
  'BOARD_NOTE',
] as const;

export type BoardField = (typeof BOARD_FIELDS)[number];

/** How each field reads in the administration screen. */
export const BOARD_FIELD_LABELS: Record<BoardField, string> = {
  PRACTITIONER: 'Profesional',
  ROOM: 'Consultorio',
  TIME_IN_STATE: 'Tiempo en el estado',
  LATENESS: 'Retraso sobre la hora',
  BOARD_NOTE: 'Nota corta',
};

export function isBoardField(value: string): value is BoardField {
  return (BOARD_FIELDS as readonly string[]).includes(value);
}
