/**
 * Block F of form 002: the violence screening (EN-070 to EN-078, REQ-025).
 *
 * The most sensitive item of the record. What makes it so is not here — it is
 * the door: `record:protected` to read or write it, one route that reads it,
 * one audit row per read, and nothing of it in a listing, an error or a log
 * (EN-072, EN-073, EN-075). This file only says what an answer IS.
 */

/**
 * EN-070. Four values, and the distinction that matters is between the first
 * two: «no se aplicó» — nobody asked — and «sin signos» — somebody asked and
 * found nothing. Both are ANSWERS; no row at all is «not answered yet», and
 * the discharge refuses that (EN-240).
 */
export const SCREENING_RESULTS = [
  'NOT_APPLIED',
  'NO_SIGNS',
  'SUSPECTED',
  'CONFIRMED',
] as const;
export type ScreeningResult = (typeof SCREENING_RESULTS)[number];

/** EN-071. Several can coexist in one case. */
export const VIOLENCE_TYPES = [
  'PHYSICAL',
  'PSYCHOLOGICAL',
  'SEXUAL',
  'NEGLECT',
  'ECONOMIC',
] as const;
export type ViolenceType = (typeof VIOLENCE_TYPES)[number];

/** EN-074. Instructivo del RDACAA, p. 49: 1 daño · 2 enfermedad · 3 incapacidad. */
export const VIOLENCE_INJURIES = ['DAMAGE', 'ILLNESS', 'DISABILITY'] as const;
export type ViolenceInjury = (typeof VIOLENCE_INJURIES)[number];

/** EN-074. 1 sí · 2 no · 3 no sabe / no responde. */
export const AGGRESSOR_IDENTIFIED = ['YES', 'NO', 'UNKNOWN'] as const;
export type AggressorIdentified = (typeof AGGRESSOR_IDENTIFIED)[number];

/** EN-074. 1 amigo · 2 conocido · 3 desconocido · 4 familiar · 5 vecino · 6 no sabe. */
export const AGGRESSOR_RELATIONSHIPS = [
  'FRIEND',
  'ACQUAINTANCE',
  'STRANGER',
  'RELATIVE',
  'NEIGHBOUR',
  'UNKNOWN',
] as const;
export type AggressorRelationship = (typeof AGGRESSOR_RELATIONSHIPS)[number];

/**
 * EN-074. What is copied from the official notification form (Form. 094,
 * D-052 §1), only when the case was notified. The serial is the PHYSICAL
 * form's, so it travels as text.
 */
export interface ScreeningNotification {
  formSerial: string;
  injury: ViolenceInjury;
  aggressorIdentified: AggressorIdentified;
  aggressorRelationship: AggressorRelationship;
}

/** What the professional answers. */
export interface ScreeningAnswer {
  result: ScreeningResult;
  /** EN-071. At least one when positive, none otherwise. */
  types: ViolenceType[];
  /** EN-077. Mandatory when positive, absent otherwise. */
  actionTaken: string | null;
  /** The instrument used, if the clinic uses one (D-188 §2). */
  screeningTool: string | null;
  /** EN-074. Only on a positive screening, and only when notified. */
  notification: ScreeningNotification | null;
}

/** EN-076. The answer with who gave it and when. */
export interface ScreeningRecord extends ScreeningAnswer {
  screenedById: string;
  screenedAt: Date;
  /**
   * EN-074, EN-242. Who recorded the notification and when; `null` when not
   * notified. After the discharge it is recorded apart from the screening.
   */
  notifiedById: string | null;
  notifiedAt: Date | null;
}

/**
 * EN-242 (D-188 §5). With the discharge given, what may change: the
 * notification of a screening with signs, completed or corrected — never
 * removed — and nothing else of the answer the 002 was signed with.
 */
export function admitsAfterDischarge(
  current: ScreeningRecord | null,
  next: ScreeningAnswer,
): boolean {
  if (current === null || next.notification === null) return false;
  if (current.result !== 'SUSPECTED' && current.result !== 'CONFIRMED') {
    return false;
  }
  return (
    next.result === current.result &&
    sameTypes(next.types, current.types) &&
    next.actionTaken === current.actionTaken &&
    next.screeningTool === current.screeningTool
  );
}

/** EN-071. The same set of types, in any order. */
export function sameTypes(
  a: readonly ViolenceType[],
  b: readonly ViolenceType[],
): boolean {
  return [...a].sort().join() === [...b].sort().join();
}
