/**
 * What administering holidays needs from storage, stated without naming a
 * database.
 *
 * WHAT IS DELIBERATELY ABSENT: any «is this date already taken?» query. CF-061
 * is a unique index, and a check-first method would be an invitation to read,
 * decide and lose the race the index exists to close — two administrators
 * loading the year's calendar at the same time is the ordinary case, not the
 * exotic one. The adapter lets PostgreSQL arbitrate and translates the refusal
 * into `HOLIDAY_DUPLICATE`.
 */

/** A holiday as the administration screen lists it (CF-060). */
export interface HolidayView {
  id: string;
  /** Calendar day, `YYYY-MM-DD`. Never an instant; see the schema note. */
  date: string;
  name: string;
  /** `null` = every site. That is the «alcance» of CF-060. */
  siteId: string | null;
}

export interface HolidayInput {
  date: string;
  name: string;
  siteId: string | null;
}

export interface HolidayPatch {
  date?: string;
  name?: string;
  siteId?: string | null;
}

/** What the listing narrows by (CF-060). */
export interface HolidayQuery {
  /** Calendar year. The screen always asks for one; the agenda will too. */
  year: number;
  /**
   * When set, the holidays of THAT site plus the ones that apply to every
   * site — which is what a site actually observes. Absent, the whole calendar
   * of the year travels, which is what the administration screen shows.
   */
  siteId?: string;
}

export interface HolidayRepository {
  list(query: HolidayQuery): Promise<readonly HolidayView[]>;

  /** Throws `HolidayDuplicateError` when the unique index refuses (CF-061). */
  create(input: HolidayInput): Promise<HolidayView>;

  /** `null` when the row is gone; the service owns the refusal. */
  update(id: string, patch: HolidayPatch): Promise<HolidayView | null>;

  /** `false` when the row does not exist. Nothing references a holiday. */
  delete(id: string): Promise<boolean>;
}

export const HOLIDAY_REPOSITORY = Symbol('HolidayRepository');
