import {
  CLINIC_TIME_ZONE,
  type ClinicalDate,
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  PriorityGroupEvidenceRequiredError,
  PriorityGroupNotRecordableError,
  PriorityGroupPeriodInvalidError,
} from './patient.errors';

/**
 * The priority groups of article 35 of the Constitution, and the order they
 * produce (REQ-024, D-026, D-027).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO CLOCK, NO DATABASE, NO FRAMEWORK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The date is a PARAMETER, never `new Date()` read in here. Every question
 * this file answers is "as of which day?", and a rule that reads the clock is
 * a rule nobody can test without travelling in time. The caller resolves the
 * day with `clinicalDateToday()` below, which asks Ecuador and not the host.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE ENUMERATION IS CODE AND NOT A CATALOGUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ethnicity, nationality and parish are catalogue rows because INEC and the
 * ministry revise them, publish releases and expect the old wording back in a
 * report from three years ago. This list is not that: it is a constitutional
 * article, and — decisively — EVERY ENTRY DRIVES A BRANCH IN THIS FILE. Which
 * groups are derived from the birth date (PA-035), which one expires on its
 * own (PA-036), which are persistent states (PA-037) and which need a second
 * key to be read at all (D-027) are decisions the code has to know. A
 * catalogue row that the code must recognise by its code string to behave
 * correctly is a catalogue in name only, and it moves the enumeration to a
 * place where a typo protects nothing — the same argument
 * `permission.catalogue.ts` makes for permissions.
 *
 * The database repeats the recordable subset as a CHECK, for the same reason
 * the cedula check digit is repeated there: an import or a `psql` INSERT never
 * passes through this file.
 */

/**
 * How the system learns a person belongs to the group.
 *
 * `AGE` groups are NEVER stored (PA-035): storing "adulto mayor" is storing a
 * fact that expires on a birthday nobody remembers to process, and the day
 * after turning 65 the chart would say no.
 */
export type PriorityGroupEvidenceKind = 'AGE' | 'ASSESSMENT' | 'STATE';

/**
 * Which key opens the reason (D-027).
 *
 * `ORDINARY` — the six of the FIRST sentence of article 35. Readable with
 * `patient:priority`, which D-029 gives to `MEDICO` and `ENFERMERIA`.
 *
 * `RESTRICTED` — the four of the SECOND sentence, the one that grants «la
 * misma atención prioritaria» to people at risk, victims of domestic and
 * sexual violence, of child abuse, and of disasters. They count for the ORDER
 * exactly like the others — that is the point of reading the article whole —
 * but «víctima de violencia doméstica» cannot live behind the same key as an
 * age. That is safety of the person, not merely privacy: it is why REQ-025
 * gives violence screening its own table and its own regime inside the
 * encounter.
 */
export type PriorityGroupReadingLevel = 'ORDINARY' | 'RESTRICTED';

export interface PriorityGroupDefinition {
  code: string;
  evidence: PriorityGroupEvidenceKind;
  reading: PriorityGroupReadingLevel;
}

/**
 * The ten. Six from the first sentence, four from the second (D-027, option C).
 *
 * ⚠️ THE ORDER OF THIS ARRAY IS NOT THE ORDER OF ANYTHING. Priority in this
 * system is a level, not a ranking between groups: an older adult does not
 * outrank a pregnant woman, and inventing a ladder here would be inventing
 * clinical policy the article does not state.
 */
export const PRIORITY_GROUP_CATALOGUE = [
  // ── First sentence of article 35 ──────────────────────────────────────────
  { code: 'OLDER_ADULT', evidence: 'AGE', reading: 'ORDINARY' },
  { code: 'CHILD_OR_ADOLESCENT', evidence: 'AGE', reading: 'ORDINARY' },
  /**
   * FHIR models pregnancy as an `Observation` — a dated assessment — and its
   * guidance says explicitly that "is she pregnant?" must NOT be captured as a
   * `Condition`. A boolean column is precisely the one that stays switched on
   * for ever.
   */
  { code: 'PREGNANT', evidence: 'ASSESSMENT', reading: 'ORDINARY' },
  // These three ARE `Condition` in FHIR terms: persistent states with clinical
  // relevance. Closing one must not delete the row (PA-037), or the answer to
  // «¿por qué esta persona tuvo prioridad en marzo?» disappears with it.
  { code: 'DISABILITY', evidence: 'STATE', reading: 'ORDINARY' },
  { code: 'DEPRIVED_OF_LIBERTY', evidence: 'STATE', reading: 'ORDINARY' },
  { code: 'CATASTROPHIC_ILLNESS', evidence: 'STATE', reading: 'ORDINARY' },
  // ── Second sentence of article 35: «la misma atención prioritaria» ────────
  { code: 'AT_RISK', evidence: 'STATE', reading: 'RESTRICTED' },
  { code: 'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM', evidence: 'STATE', reading: 'RESTRICTED' }, // prettier-ignore
  { code: 'CHILD_ABUSE_VICTIM', evidence: 'STATE', reading: 'RESTRICTED' },
  { code: 'DISASTER_VICTIM', evidence: 'STATE', reading: 'RESTRICTED' },
] as const satisfies readonly PriorityGroupDefinition[];

export type PriorityGroup = (typeof PRIORITY_GROUP_CATALOGUE)[number]['code'];

export const PRIORITY_GROUPS: readonly PriorityGroup[] =
  PRIORITY_GROUP_CATALOGUE.map((group) => group.code);

/**
 * The ones that may be written as a row: everything that is not derived from
 * the birth date.
 *
 * DERIVED, never a second hand-kept list. The mark on the entry is the source,
 * and a copy is the file nobody remembers to edit when a group is added —
 * exactly how `user:reset-mfa` reached the development role.
 */
const withEvidence = (
  kinds: readonly PriorityGroupEvidenceKind[],
): readonly PriorityGroup[] =>
  PRIORITY_GROUP_CATALOGUE.filter((group) =>
    kinds.includes(group.evidence),
  ).map((group) => group.code);

export const RECORDABLE_PRIORITY_GROUPS: readonly PriorityGroup[] =
  withEvidence(['ASSESSMENT', 'STATE']);

export const AGE_DERIVED_PRIORITY_GROUPS: readonly PriorityGroup[] =
  withEvidence(['AGE']);

export const RESTRICTED_PRIORITY_GROUPS: readonly PriorityGroup[] =
  PRIORITY_GROUP_CATALOGUE.filter(
    (group) => group.reading === 'RESTRICTED',
  ).map((group) => group.code);

export function isRecordablePriorityGroup(
  group: string,
): group is PriorityGroup {
  return (RECORDABLE_PRIORITY_GROUPS as readonly string[]).includes(group);
}

/** D-027: needs `patient:priority:protected`, and never appears in a listing. */
export function isRestrictedPriorityGroup(group: string): boolean {
  return (RESTRICTED_PRIORITY_GROUPS as readonly string[]).includes(group);
}

/**
 * The group whose period MUST end (PA-036).
 *
 * A pregnancy is registered with an expected date of delivery or an end date,
 * and it stops counting on its own when that date is in the past. Nobody has
 * to close it — which is the whole difference between «vigente» and «alguien
 * lo marcó una vez».
 */
export function priorityGroupRequiresEnd(group: PriorityGroup): boolean {
  return (
    PRIORITY_GROUP_CATALOGUE.find((entry) => entry.code === group)?.evidence ===
    'ASSESSMENT'
  );
}

/**
 * Where the record came from (PA-038).
 *
 * «Lo dijo el paciente» and «consta en el carné del CONADIS» are not the same
 * thing, and without the distinction the system cannot say which of the two
 * whoever decides a turn is looking at.
 */
export type PriorityGroupOrigin = 'SELF_DECLARED' | 'ACCREDITED';
export const PRIORITY_GROUP_ORIGINS: readonly PriorityGroupOrigin[] = [
  'SELF_DECLARED',
  'ACCREDITED',
];

/**
 * Age thresholds, IN ONE PLACE (PA-035).
 *
 * 65 completed years — article 36 of the Constitution. Under 18 — Código de la
 * Niñez y Adolescencia. They live here, and only here, so that correcting one
 * is a single line the day a review finds another in force.
 */
export const OLDER_ADULT_MIN_AGE_YEARS = 65;
export const ADULTHOOD_MIN_AGE_YEARS = 18;

/** Today in Ecuador. The only place this file gets near a clock. */
export function clinicalDateToday(
  now: Date = new Date(),
  timeZone: string = CLINIC_TIME_ZONE,
): ClinicalDate {
  return clinicalDateOf(now, timeZone);
}

/**
 * Completed years between two calendar dates.
 *
 * ON THE CALENDAR, never by dividing elapsed milliseconds: that is off by a
 * day around leap years and around the birthday itself, and "off by a day" on
 * a 64-year-old is a different answer to whether they are a priority patient.
 */
export function ageInYearsOn(
  birthDate: ClinicalDate,
  on: ClinicalDate,
): number {
  const [birthYear, birthMonth, birthDay] = splitDate(birthDate);
  const [year, month, day] = splitDate(on);

  const hadBirthday =
    month > birthMonth || (month === birthMonth && day >= birthDay);

  return Math.max(0, year - birthYear - (hadBirthday ? 0 : 1));
}

/** A period as it is stored: two calendar dates, the end optional. */
export interface PriorityGroupPeriod {
  startsOn: ClinicalDate;
  /** `null` means still open. A pregnancy never has it null (PA-036). */
  endsOn: ClinicalDate | null;
}

/**
 * Whether a recorded period counts on a given day.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESOLVED WHEN READ. NO PROCESS MARKS ROWS AS EXPIRED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is what makes PA-036 true: the pregnancy of somebody who gave birth in
 * March stops ordering the waiting list in April WITHOUT anyone touching the
 * row. A nightly job that flipped a flag would be one missed run away from
 * prioritising the wrong person, and it would also destroy the answer to «¿por
 * qué tuvo prioridad en marzo?», which is the same reason closing a state does
 * not delete its row.
 *
 * BOTH ENDS INCLUSIVE. The last day of the period still counts: "hasta el 15"
 * means the 15th is covered, and PA-036 says a group stops counting while the
 * date is IN THE PAST.
 */
export function isPeriodInForce(
  period: PriorityGroupPeriod,
  on: ClinicalDate,
): boolean {
  if (period.startsOn > on) return false;
  return period.endsOn === null || period.endsOn >= on;
}

/** A recorded row, reduced to what the order depends on. */
export interface RecordedPriorityGroup extends PriorityGroupPeriod {
  group: PriorityGroup;
}

/**
 * The groups the birth date alone puts somebody in, at a completed age.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE IMPLEMENTATION, BECAUSE THERE WERE TWO AND THEY COULD DIVERGE IN SILENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `priorityGroupsInForce` and `priorityLevelOf` each spelled the same two
 * comparisons out. A mutation audit found the second copy uncovered at the
 * boundary — `age >= 65 || age < 18` survived being turned into
 * `age > 65 || age <= 18`, which takes the priority away from somebody on the
 * very day they turn 65 and gives it back a year later. The chart would have
 * said «adulto mayor» while the waiting list said «espere su turno», and
 * nothing would have been red.
 *
 * Two copies of a threshold are two answers to the same question waiting to
 * disagree, so there is one. The numbers themselves stay in the two exported
 * constants: article 36 of the Constitution for 65, the Código de la Niñez y
 * Adolescencia for 18.
 */
function ageDerivedGroupsAt(age: number): PriorityGroup[] {
  const derived: PriorityGroup[] = [];
  if (age >= OLDER_ADULT_MIN_AGE_YEARS) derived.push('OLDER_ADULT');
  if (age < ADULTHOOD_MIN_AGE_YEARS) derived.push('CHILD_OR_ADOLESCENT');
  return derived;
}

/**
 * Every group the patient belongs to on that day: the two derived from the
 * birth date plus the recorded rows still in force.
 *
 * THE RESTRICTED ONES ARE INCLUDED, and that is D-027 option C in one line:
 * they count for the ORDER exactly like the rest. What their reading level
 * changes is who may see the list, never whether the person is prioritised.
 */
export function priorityGroupsInForce(
  patient: { birthDate: ClinicalDate; recorded: readonly RecordedPriorityGroup[] }, // prettier-ignore
  on: ClinicalDate,
): readonly PriorityGroup[] {
  const derived = ageDerivedGroupsAt(ageInYearsOn(patient.birthDate, on));

  const inForce = patient.recorded
    .filter((record) => isPeriodInForce(record, on))
    .map((record) => record.group);

  return [...new Set([...derived, ...inForce])];
}

/**
 * The number the agenda orders by (PA-041, AG-061, AG-062).
 *
 * TWO LEVELS AND NOT TEN. AG-062 says «prioridad 1 para los grupos de atención
 * prioritaria», and article 35 does not rank them against each other. Ordering
 * a queue by which group somebody belongs to would be inventing a clinical
 * hierarchy nobody wrote down, and — worse — a distinct number per group would
 * leak the REASON through the ORDER, which is the one thing PA-042 forbids.
 * `1` and `2` say who goes first and nothing else.
 */
export const PRIORITY_LEVEL = { PRIORITY: 1, STANDARD: 2 } as const;
export type PriorityLevel =
  (typeof PRIORITY_LEVEL)[keyof typeof PRIORITY_LEVEL];

/**
 * ⚠️ IT TAKES PERIODS, NOT GROUPS, AND THAT IS THE POINT.
 *
 * The order depends on WHETHER any assessment is in force, never on WHICH one,
 * so the reason is not a parameter of this function at all. The listing query
 * therefore selects two date columns and no `group_code` — PA-042 stops being
 * a rule somebody has to remember and becomes something the SELECT cannot
 * express. The same reason `agenda` will be able to order the waiting list
 * with only `patient:read`.
 */
export function priorityLevelOf(
  patient: {
    birthDate: ClinicalDate;
    periods: readonly PriorityGroupPeriod[];
  },
  on: ClinicalDate,
): PriorityLevel {
  // THE SAME FUNCTION `priorityGroupsInForce` uses, not a second copy of the
  // two comparisons: the level and the list cannot disagree about who is a
  // priority patient because they read the same answer.
  const derivedFromAge =
    ageDerivedGroupsAt(ageInYearsOn(patient.birthDate, on)).length > 0;

  const prioritised =
    derivedFromAge ||
    patient.periods.some((period) => isPeriodInForce(period, on));

  return prioritised ? PRIORITY_LEVEL.PRIORITY : PRIORITY_LEVEL.STANDARD;
}

/** What a caller hands over to record one. */
export interface NewPriorityGroupRecord {
  group: string;
  startsOn: ClinicalDate;
  endsOn: ClinicalDate | null;
  origin: PriorityGroupOrigin;
  evidenceDocument: string | null;
}

/**
 * A period that ends before it starts is not a period (PA-036).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ON ITS OWN BECAUSE IT IS DEMANDED ON TWO PATHS, AND ONLY ONE HAD IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Recording a group went through `assertRecordablePriorityGroup` and was
 * refused with `PRIORITY_GROUP_PERIOD_INVALID` and its field error. CLOSING
 * one did not go through anything: the date travelled straight to the UPDATE,
 * `patient_priority_group_period_valid` refused it, and the person at the desk
 * got a bare `422 CHECK_FAILED` — a generic code, with no field to put the
 * sentence under and nothing to act on. Found by probing the three constraints
 * of that table that no test violated.
 *
 * The database keeps its CHECK, and that is the point of it: an import or a
 * `psql` never passes through here. What this adds is the same answer on both
 * paths, which is what the SPEC fixed for the code and the screen needs to
 * render.
 *
 * BOTH ENDS INCLUSIVE: a period that starts and ends the same day is a period
 * — a disaster victim seen and discharged the same afternoon — and `>=` is
 * exactly what the CHECK says too.
 */
export function assertPriorityPeriodOrder(
  startsOn: ClinicalDate,
  endsOn: ClinicalDate | null,
): void {
  if (endsOn !== null && endsOn < startsOn) {
    throw new PriorityGroupPeriodInvalidError(
      'endsOn',
      'La fecha de fin no puede ser anterior a la de inicio',
    );
  }
}

/**
 * Checks a record before it is written, and narrows the group.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IN THE DOMAIN AND NOT ONLY IN THE DTO, ON PURPOSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same argument as `CANCELLATION_REASON_REQUIRED` in the agenda: a
 * `DEBERÁ` that only the transport layer enforces stops being enforced the day
 * another use case calls this from inside. The DTO repeats it so the person at
 * the desk is told which box to fix; the database repeats it again so an
 * import cannot get past either.
 */
export function assertRecordablePriorityGroup(
  record: NewPriorityGroupRecord,
): PriorityGroup {
  if (!isRecordablePriorityGroup(record.group)) {
    throw new PriorityGroupNotRecordableError(record.group);
  }

  assertPriorityPeriodOrder(record.startsOn, record.endsOn);

  // PA-036. A pregnancy without an end is the boolean column this design
  // exists to avoid: it would order the waiting list for ever.
  if (priorityGroupRequiresEnd(record.group) && record.endsOn === null) {
    throw new PriorityGroupPeriodInvalidError(
      'endsOn',
      'Indique la fecha probable de parto o la fecha de fin',
    );
  }

  if (
    record.origin === 'ACCREDITED' &&
    (record.evidenceDocument === null || record.evidenceDocument.trim() === '')
  ) {
    throw new PriorityGroupEvidenceRequiredError();
  }

  return record.group;
}

function splitDate(date: ClinicalDate): [number, number, number] {
  return parseClinicalDate(date)
    .split('-')
    .map((part) => Number.parseInt(part, 10)) as [number, number, number];
}
