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
  /**
   * AG-092. The sites that WORK this holiday anyway: A&E opens on the 25th of
   * December without the holiday ceasing to apply to the rest.
   *
   * It travels with the listing because otherwise nothing on the screen says
   * a national holiday has an exception, and the only way to find out would be
   * to ask each site's availability day by day. Empty is the ordinary case.
   */
  workedBySiteIds: readonly string[];
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

/**
 * Both sides of one write (AG-097, CF-066, D-017).
 *
 * WHY A MUTATION ANSWERS WITH THE PREVIOUS ROW INSTEAD OF THE SERVICE READING
 * IT FIRST. A read issued before the write is stale the instant it returns:
 * two administrators editing the same holiday would each log a previous value
 * the other had already replaced, and the trail would describe a history that
 * never happened. The only honest pairing is inside the transaction that
 * writes — and a transaction cannot span two calls through this port, so the
 * port asks for the pair rather than pretending the race is not there.
 */
export interface HolidayChange {
  before: HolidayView;
  after: HolidayView;
}

export interface HolidayRepository {
  list(query: HolidayQuery): Promise<readonly HolidayView[]>;

  /**
   * Throws `HolidayDuplicateError` when the unique index refuses (CF-061).
   *
   * No pair here: nothing was replaced, so there is no previous value.
   */
  create(input: HolidayInput): Promise<HolidayView>;

  /**
   * `null` when the row is gone; the service owns the refusal.
   *
   * Both sides come from ONE transaction; see `HolidayChange`.
   */
  update(id: string, patch: HolidayPatch): Promise<HolidayChange | null>;

  /**
   * The row that disappeared, or `null` when there was none. Nothing
   * references a holiday, so it is deleted and not disabled — which makes the
   * returned row the only trace left of it, and the trail's `before`.
   */
  delete(id: string): Promise<HolidayView | null>;

  /**
   * AG-092. This site works that holiday. `null` when the holiday is gone.
   *
   * IDEMPOTENT, because the pair is the primary key: saying it twice does not
   * mean anything different from saying it once, and answering 409 to the
   * administrator who clicked twice would be inventing a conflict out of an
   * agreement.
   *
   * A SITE THAT DOES NOT EXIST IS NOT THIS PORT'S TO REFUSE. The foreign key
   * arbitrates it and the adapter lets the refusal travel, which is why there
   * is no «does this site exist?» question here: this module does not own the
   * site (ADR-011) and a read-then-write would lose the race anyway.
   */
  markWorkedBy(
    holidayId: string,
    siteId: string,
  ): Promise<HolidayChange | null>;

  /**
   * AG-092. This site stops working that holiday. `null` when the holiday is
   * gone.
   *
   * Idempotent too: removing an exception that is not there already leaves the
   * state the caller asked for.
   */
  unmarkWorkedBy(
    holidayId: string,
    siteId: string,
  ): Promise<HolidayChange | null>;
}

export const HOLIDAY_REPOSITORY = Symbol('HolidayRepository');
