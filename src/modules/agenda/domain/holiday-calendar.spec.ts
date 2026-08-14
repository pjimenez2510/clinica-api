import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import {
  type Holiday,
  bookingWarningsFor,
  closedDatesIn,
  closureOn,
  holidayAppliesToSite,
  holidaysOn,
  yearsWithoutCalendar,
} from './holiday-calendar';

const SITE = '018f1b3a-0000-7000-8000-000000000002';
const OTHER_SITE = '018f1b3a-0000-7000-8000-000000000003';

const CHRISTMAS = parseClinicalDate('2026-12-25');

type HolidaySeed = Omit<Partial<Holiday>, 'date'> & { date?: string };

const holiday = ({ date, ...overrides }: HolidaySeed = {}): Holiday => ({
  id: 'holiday-christmas',
  date: parseClinicalDate(date ?? '2026-12-25'),
  name: 'Navidad',
  // `null` is the national scope: every site observes it (AG-091).
  siteId: null,
  workedBySiteIds: [],
  ...overrides,
});

const dates = (...values: string[]) => values.map(parseClinicalDate);

describe('which holidays a site observes', () => {
  it('AG-091 applies a national holiday to every site', () => {
    const national = holiday({ siteId: null });

    expect(holidayAppliesToSite(national, SITE)).toBe(true);
    expect(holidayAppliesToSite(national, OTHER_SITE)).toBe(true);
  });

  it('AG-091 applies a holiday of local scope only to the site it names', () => {
    const local = holiday({ id: 'holiday-cuenca', siteId: OTHER_SITE });

    expect(holidayAppliesToSite(local, OTHER_SITE)).toBe(true);
    expect(holidayAppliesToSite(local, SITE)).toBe(false);
  });

  it('AG-016 leaves a site untouched by another site local holiday', () => {
    const foreign = holiday({
      id: 'holiday-fundacion',
      name: 'Fundación de la ciudad',
      siteId: OTHER_SITE,
    });

    expect(holidaysOn([foreign], CHRISTMAS, SITE)).toEqual([]);
    expect(holidaysOn([foreign], CHRISTMAS, OTHER_SITE)).toEqual([foreign]);
  });

  it('AG-092 does not apply a national holiday to a site that works it', () => {
    // A&E opens on 25 December. The holiday keeps applying everywhere else.
    const national = holiday({ workedBySiteIds: [SITE] });

    expect(holidayAppliesToSite(national, SITE)).toBe(false);
    expect(holidayAppliesToSite(national, OTHER_SITE)).toBe(true);
  });

  it('AG-092 reads the exception the same way on a holiday of local scope', () => {
    // The semantics are uniform for both scopes, which is why the schema puts
    // no CHECK on this: on a local holiday the exception amounts to deleting
    // it, and that row neither lies nor does harm.
    const local = holiday({ siteId: SITE, workedBySiteIds: [SITE] });

    expect(holidayAppliesToSite(local, SITE)).toBe(false);
  });
});

describe('the closure of a date', () => {
  it('AG-015 states the name of the holiday as the reason', () => {
    expect(closureOn([holiday()], CHRISTMAS, SITE)).toEqual({
      date: CHRISTMAS,
      reason: 'Navidad',
    });
  });

  it('AG-015 leaves a date with no applicable holiday open', () => {
    const local = holiday({ siteId: OTHER_SITE });

    expect(closureOn([local], CHRISTMAS, SITE)).toBeNull();
    expect(closureOn([], CHRISTMAS, SITE)).toBeNull();
  });

  it('AG-015 names the local holiday when a national one falls on the same day', () => {
    // Two holidays, one date, one reason to show. The local declaration is the
    // more specific one, so it is the one the site is told about; without a
    // written tie-break the reason would depend on the order the rows arrived
    // in, which can change on its own after a VACUUM (the reasoning of AG-106).
    const national = holiday({ id: 'holiday-national', name: 'Navidad' });
    const local = holiday({
      id: 'holiday-local',
      name: 'Fiestas de la ciudad',
      siteId: SITE,
    });

    expect(closureOn([national, local], CHRISTMAS, SITE)?.reason).toBe(
      'Fiestas de la ciudad',
    );
  });

  it('AG-015 breaks a tie between two holidays of the same scope by name', () => {
    const first = holiday({ id: 'holiday-a', name: 'Navidad' });
    const second = holiday({ id: 'holiday-b', name: 'Aniversario' });

    expect(closureOn([first, second], CHRISTMAS, SITE)?.reason).toBe(
      'Aniversario',
    );
  });

  it('AG-015 returns one closure per closed date of the range, in order', () => {
    const christmas = holiday();
    const boxingDay = holiday({
      id: 'holiday-26',
      name: 'Puente',
      date: '2026-12-26',
    });

    expect(
      closedDatesIn(
        [boxingDay, christmas],
        dates('2026-12-24', '2026-12-25', '2026-12-26'),
        SITE,
      ),
    ).toEqual([
      { date: parseClinicalDate('2026-12-25'), reason: 'Navidad' },
      { date: parseClinicalDate('2026-12-26'), reason: 'Puente' },
    ]);
  });

  it('AG-092 reopens a day the site works, without touching the others', () => {
    const worked = holiday({ workedBySiteIds: [SITE] });

    expect(closedDatesIn([worked], dates('2026-12-25'), SITE)).toEqual([]);
    expect(closedDatesIn([worked], dates('2026-12-25'), OTHER_SITE)).toEqual([
      { date: CHRISTMAS, reason: 'Navidad' },
    ]);
  });
});

describe('booking on a day the site keeps closed', () => {
  it('AG-110 warns about a booking made on a holiday and names the reason', () => {
    const warnings = bookingWarningsFor([holiday()], CHRISTMAS, SITE);

    expect(warnings).toHaveLength(1);
    // The motive travels, or the sentence is «algo pasa ese día» and recepción
    // cannot act on it.
    expect(warnings[0]).toContain('Navidad');
  });

  it('AG-110 stays silent on an ordinary working day', () => {
    const boxingDay = parseClinicalDate('2026-12-26');

    expect(bookingWarningsFor([holiday()], boxingDay, SITE)).toEqual([]);
  });

  it('AG-110 stays silent for a site that works that holiday', () => {
    // AG-092: A&E opens on 25 December, so there is nothing to warn about —
    // and the site next door is still told.
    const worked = holiday({ workedBySiteIds: [SITE] });

    expect(bookingWarningsFor([worked], CHRISTMAS, SITE)).toEqual([]);
    expect(bookingWarningsFor([worked], CHRISTMAS, OTHER_SITE)).toHaveLength(1);
  });

  it('AG-110 stays silent about another site local holiday', () => {
    const foreign = holiday({ siteId: OTHER_SITE, name: 'Fiestas de la ciudad' }); // prettier-ignore

    expect(bookingWarningsFor([foreign], CHRISTMAS, SITE)).toEqual([]);
  });

  it('AG-110 says once that the day is closed, whatever the reason chosen', () => {
    // Two holidays on one date: `closureOn` already decided which reason is
    // shown (local first). Two warnings about one day would be noise the
    // screen teaches people to skip — the reasoning of AU-034's own dedup.
    const national = holiday({ id: 'holiday-national', name: 'Navidad' });
    const local = holiday({
      id: 'holiday-local',
      name: 'Fiestas de la ciudad',
      siteId: SITE,
    });

    const warnings = bookingWarningsFor([national, local], CHRISTMAS, SITE);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Fiestas de la ciudad');
  });
});

describe('the years whose calendar is not loaded', () => {
  it('AG-093 reports a year of the range with no holiday loaded', () => {
    expect(yearsWithoutCalendar(dates('2027-01-05'), [2026])).toEqual([2027]);
  });

  it('AG-093 stays silent about a year whose calendar is loaded', () => {
    expect(yearsWithoutCalendar(dates('2026-12-25'), [2026])).toEqual([]);
  });

  it('AG-093 reports every uncovered year of a range that crosses New Year', () => {
    expect(yearsWithoutCalendar(dates('2026-12-31', '2027-01-01'), [])).toEqual(
      [2026, 2027],
    );
  });

  it('AG-093 reports a year once, however many dates of it were asked for', () => {
    expect(
      yearsWithoutCalendar(dates('2027-01-01', '2027-01-02', '2027-01-03'), []),
    ).toEqual([2027]);
  });
});
