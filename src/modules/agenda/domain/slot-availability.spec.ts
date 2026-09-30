import { describe, expect, it } from 'vitest';

import {
  WallClockTime,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import type { Holiday } from './holiday-calendar';
import {
  type AgendaOccupancy,
  type PractitionerAvailability,
  type ScheduleRule,
  deriveAvailability,
  occupiesCalendar,
  slotsOfRuleOn,
} from './slot-availability';

const PRACTITIONER = '018f1b3a-0000-7000-8000-000000000001';
const SITE = '018f1b3a-0000-7000-8000-000000000002';
const OTHER_SITE = '018f1b3a-0000-7000-8000-000000000003';

const practitioner = (
  overrides: Partial<PractitionerAvailability> = {},
): PractitionerAvailability => ({
  practitionerId: PRACTITIONER,
  schedulable: true,
  siteIds: [SITE],
  ...overrides,
});

/**
 * Builders take plain strings and brand them here, at the test boundary, so
 * every test case keeps reading as a literal date instead of a parse call.
 */
type RuleSeed = Omit<Partial<ScheduleRule>, 'validFrom' | 'validTo'> & {
  validFrom?: string;
  validTo?: string | null;
};

const rule = ({
  validFrom,
  validTo,
  ...overrides
}: RuleSeed = {}): ScheduleRule => ({
  id: 'rule-monday',
  practitionerId: PRACTITIONER,
  siteId: SITE,
  serviceTypeConceptId: null,
  // 2026-09-14 is a Monday.
  weekday: 1,
  startTime: WallClockTime.parse('08:00'),
  endTime: WallClockTime.parse('09:00'),
  validFrom: parseClinicalDate(validFrom ?? '2026-01-01'),
  validTo: validTo == null ? null : parseClinicalDate(validTo),
  active: true,
  ...overrides,
});

const occupancy = (
  overrides: Partial<AgendaOccupancy> = {},
): AgendaOccupancy => ({
  id: 'entry-1',
  practitionerId: PRACTITIONER,
  siteId: SITE,
  startsAt: new Date('2026-09-14T13:00:00Z'),
  endsAt: new Date('2026-09-14T13:20:00Z'),
  blocksCalendar: true,
  releasedAt: null,
  ...overrides,
});

const holiday = (overrides: Partial<Holiday> = {}): Holiday => ({
  id: 'holiday-1',
  // 2026-09-14 is the Monday every case here derives slots for.
  date: parseClinicalDate('2026-09-14'),
  name: 'Feriado de prueba',
  siteId: null,
  workedBySiteIds: [],
  ...overrides,
});

/**
 * The two holiday inputs are REQUIRED by `deriveAvailability` and defaulted
 * here, not there. A default of "no holidays loaded" inside the derivation is
 * exactly the assumption AG-093 forbids: every caller has to say what it read,
 * and the year 2026 is declared covered below so the cases that are not about
 * AG-093 do not carry its warning.
 */
const availability = (input: {
  rules?: readonly ScheduleRule[];
  entries?: readonly AgendaOccupancy[];
  practitioner?: PractitionerAvailability;
  holidays?: readonly Holiday[];
  calendarYears?: readonly number[];
  from?: string;
  to?: string;
  siteId?: string;
  slotAtomMinutes?: number;
}) =>
  deriveAvailability({
    practitioner: input.practitioner ?? practitioner(),
    siteId: input.siteId ?? SITE,
    rules: input.rules ?? [rule()],
    entries: input.entries ?? [],
    // D-021: the grid is the SITE's, so it is an input of the derivation and
    // no longer a field of the rule. 20 keeps every case below reading as it
    // did, which is what makes the diff about the move and not about the
    // expectations.
    slotAtomMinutes: input.slotAtomMinutes ?? 20,
    holidays: input.holidays ?? [],
    calendarYears: input.calendarYears ?? [2026],
    from: parseClinicalDate(input.from ?? '2026-09-14'),
    to: parseClinicalDate(input.to ?? '2026-09-14'),
  });

const plusMinutes = (instant: Date, minutes: number): Date =>
  new Date(instant.getTime() + minutes * 60_000);

const startsOf = (slots: readonly { startsAt: Date }[]): string[] =>
  slots.map((slot) => slot.startsAt.toISOString());

describe('slot availability', () => {
  it('AG-003 derives free slots from the rule minus what occupies the calendar', () => {
    const { slots } = availability({
      entries: [occupancy()], // 08:00–08:20 local is taken
    });

    // 08:00, 08:20 and 08:40 local = 13:00, 13:20 and 13:40 UTC.
    expect(startsOf(slots)).toEqual([
      '2026-09-14T13:20:00.000Z',
      '2026-09-14T13:40:00.000Z',
    ]);
    expect(slots.every((slot) => slot.ruleId === 'rule-monday')).toBe(true);
  });

  it('AG-003 treats only unreleased blocking entries as occupying the calendar', () => {
    expect(occupiesCalendar(occupancy())).toBe(true);
    expect(occupiesCalendar(occupancy({ blocksCalendar: false }))).toBe(false);
    expect(
      occupiesCalendar(
        occupancy({ releasedAt: new Date('2026-09-13T10:00:00Z') }),
      ),
    ).toBe(false);

    const { slots } = availability({
      entries: [
        occupancy({ id: 'overbooked', blocksCalendar: false }),
        occupancy({
          id: 'released',
          startsAt: new Date('2026-09-14T13:20:00Z'),
          endsAt: new Date('2026-09-14T13:40:00Z'),
          releasedAt: new Date('2026-09-13T10:00:00Z'),
        }),
      ],
    });

    expect(slots).toHaveLength(3);
  });

  it('AG-003 emits no slot for an interval that is only partially covered by the rule', () => {
    // 08:00–08:50 with 20-minute slots yields two, not two and a half: a slot
    // that runs past the end of the rule is not a slot.
    const { slots } = availability({
      rules: [rule({ endTime: WallClockTime.parse('08:50') })],
    });

    expect(slots).toHaveLength(2);
    expect(slots.at(-1)?.endsAt.toISOString()).toBe('2026-09-14T13:40:00.000Z');
  });

  it('AG-003 drops a free slot that any blocking entry overlaps, even partially', () => {
    const { slots } = availability({
      entries: [
        occupancy({
          startsAt: new Date('2026-09-14T13:10:00Z'),
          endsAt: new Date('2026-09-14T13:30:00Z'),
        }),
      ],
    });

    expect(startsOf(slots)).toEqual(['2026-09-14T13:40:00.000Z']);
  });

  it('AG-003 keeps a slot that merely touches an entry end to end', () => {
    // Intervals are half-open `[start, end)`, like the tstzrange the exclusion
    // constraint uses. Touching is not overlapping, or every agenda would lose
    // a slot after each appointment.
    const { slots } = availability({
      entries: [
        occupancy({
          startsAt: new Date('2026-09-14T12:40:00Z'),
          endsAt: new Date('2026-09-14T13:00:00Z'),
        }),
      ],
    });

    expect(slots).toHaveLength(3);
  });

  it('AG-144 drops a slot the practitioner holds at another site, and lists only this site as occupied', () => {
    // One practitioner, one calendar: the EXCLUDE compares `practitioner_id`
    // and the interval, never the site.
    const result = availability({
      entries: [occupancy({ id: 'elsewhere', siteId: OTHER_SITE })],
    });

    // The first slot is the one taken elsewhere; the other two remain.
    const taken = occupancy().startsAt;
    expect(startsOf(result.slots)).toEqual([
      plusMinutes(taken, 20).toISOString(),
      plusMinutes(taken, 40).toISOString(),
    ]);
    // Not this site's to show (AG-107): the hole, not the reason.
    expect(result.occupied).toEqual([]);
  });

  it('AG-144 applies the predicate of the EXCLUDE to the entry at another site', () => {
    const { slots } = availability({
      entries: [
        occupancy({ siteId: OTHER_SITE, blocksCalendar: false }),
        occupancy({
          siteId: OTHER_SITE,
          startsAt: occupancy().endsAt,
          endsAt: plusMinutes(occupancy().endsAt, 20),
          releasedAt: plusMinutes(occupancy().startsAt, -60),
        }),
      ],
    });

    expect(slots).toHaveLength(3);
  });

  it('AG-144 ignores the entries of another practitioner at another site', () => {
    const { slots } = availability({
      entries: [
        occupancy({
          siteId: OTHER_SITE,
          practitionerId: '018f1b3a-0000-7000-8000-000000000009',
        }),
      ],
    });

    expect(slots).toHaveLength(3);
  });

  it('AG-010 offers slots only on the weekday and validity window of the rule', () => {
    const { slots } = availability({
      rules: [rule({ validFrom: '2026-09-15' })],
      from: '2026-09-14',
      to: '2026-09-21',
    });

    // Monday the 14th falls before `valid_from`; Monday the 21st does not.
    expect(startsOf(slots)).toEqual([
      '2026-09-21T13:00:00.000Z',
      '2026-09-21T13:20:00.000Z',
      '2026-09-21T13:40:00.000Z',
    ]);
  });

  it('AG-010 stops offering slots after valid_to, inclusive of that date', () => {
    const { slots } = availability({
      rules: [rule({ validTo: '2026-09-14' })],
      from: '2026-09-14',
      to: '2026-09-21',
    });

    expect(startsOf(slots).every((iso) => iso.startsWith('2026-09-14'))).toBe(
      true,
    );
    expect(slots).toHaveLength(3);
  });

  it('AG-010 ignores an inactive rule', () => {
    expect(availability({ rules: [rule({ active: false })] }).slots).toEqual(
      [],
    );
  });

  it('AG-010 ignores a rule that belongs to another practitioner or another site', () => {
    expect(
      availability({ rules: [rule({ practitionerId: 'someone-else' })] }).slots,
    ).toEqual([]);
    expect(
      availability({ rules: [rule({ siteId: OTHER_SITE })] }).slots,
    ).toEqual([]);
  });

  it('AG-010 returns the slots of every applicable rule, ordered by instant', () => {
    const { slots } = availability({
      rules: [
        rule({
          id: 'afternoon',
          startTime: WallClockTime.parse('15:00'),
          endTime: WallClockTime.parse('15:40'),
        }),
        rule(),
      ],
    });

    expect(startsOf(slots)).toEqual([
      '2026-09-14T13:00:00.000Z',
      '2026-09-14T13:20:00.000Z',
      '2026-09-14T13:40:00.000Z',
      '2026-09-14T20:00:00.000Z',
      '2026-09-14T20:20:00.000Z',
    ]);
  });

  it('AG-011 still lists an appointment booked under a rule that is no longer in force', () => {
    // The rule expired on the 13th; the appointment on the 14th was booked
    // while it was valid and the clinic must still see it in the agenda.
    const result = availability({
      rules: [rule({ validTo: '2026-09-13' })],
      entries: [occupancy()],
    });

    expect(result.slots).toEqual([]);
    expect(result.occupied.map((entry) => entry.id)).toEqual(['entry-1']);
  });

  it('AG-011 lists the occupying entries of the range ordered by start, whatever the rules', () => {
    const result = availability({
      rules: [],
      entries: [
        occupancy({
          id: 'later',
          startsAt: new Date('2026-09-14T16:00:00Z'),
          endsAt: new Date('2026-09-14T16:20:00Z'),
        }),
        occupancy({ id: 'earlier' }),
        occupancy({
          id: 'out-of-range',
          startsAt: new Date('2026-09-20T16:00:00Z'),
          endsAt: new Date('2026-09-20T16:20:00Z'),
        }),
        occupancy({
          id: 'released',
          releasedAt: new Date('2026-09-13T10:00:00Z'),
        }),
      ],
    });

    expect(result.occupied.map((entry) => entry.id)).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('AG-013 offers no slot at all while the practitioner is not schedulable', () => {
    const result = availability({
      practitioner: practitioner({ schedulable: false }),
      entries: [occupancy()],
    });

    expect(result.slots).toEqual([]);
    // The agenda still shows what was already booked: switching a doctor off
    // must not hide the patients already waiting for them.
    expect(result.occupied).toHaveLength(1);
  });

  it('AG-014 offers no slot at a site the practitioner is not linked to', () => {
    const result = availability({
      practitioner: practitioner({ siteIds: [OTHER_SITE] }),
      rules: [rule()],
    });

    expect(result.slots).toEqual([]);
  });

  it('AG-014 offers slots at a site the practitioner is linked to among several', () => {
    const result = availability({
      practitioner: practitioner({ siteIds: [OTHER_SITE, SITE] }),
    });

    expect(result.slots).toHaveLength(3);
  });

  it('AG-001 derives the slots of a date range with the day bounds of Ecuador', () => {
    // An entry at 20:20 local on Monday is 01:20Z on Tuesday. Delimiting the
    // range in UTC would leave it out and offer a slot that is taken.
    const { slots } = availability({
      rules: [
        rule({
          startTime: WallClockTime.parse('20:00'),
          endTime: WallClockTime.parse('21:00'),
        }),
      ],
      entries: [
        occupancy({
          startsAt: new Date('2026-09-15T01:20:00Z'),
          endsAt: new Date('2026-09-15T01:40:00Z'),
        }),
      ],
    });

    expect(startsOf(slots)).toEqual([
      '2026-09-15T01:00:00.000Z',
      '2026-09-15T01:40:00.000Z',
    ]);
  });

  // Adversarial review of E1, P1-1. The first version of this test asserted
  // the opposite — that one malformed row throws — which meant one bad row in
  // `practitioner_schedule_rule` turned availability AND booking into 500 for
  // every date it covered. The database now rejects such rows (CHECKs in
  // migration 20260812174244); here the concern is older data and seeds: a
  // malformed rule degrades to "offers nothing" while every healthy rule
  // keeps working. `slotsOfRuleOn` itself still throws — reaching it with a
  // malformed rule is a caller bug, and the derivation paths filter first.
  it('skips a malformed rule instead of taking down every healthy one', () => {
    const healthy = rule();
    const inverted = rule({
      id: 'rule-inverted',
      endTime: WallClockTime.parse('07:00'),
    });
    const impossibleWeekday = rule({ id: 'rule-weekday', weekday: 8 });

    const { slots } = availability({
      rules: [healthy, inverted, impossibleWeekday],
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.ruleId === healthy.id)).toBe(true);
  });

  it('still refuses to derive slots directly from a malformed rule', () => {
    expect(() =>
      slotsOfRuleOn(
        rule({ endTime: WallClockTime.parse('07:00') }),
        parseClinicalDate('2026-09-14'),
        20,
        undefined,
      ),
    ).toThrow(RangeError);
  });

  /**
   * D-021. A grid of zero minutes is now a broken SITE, not a broken rule, so
   * it must not degrade to «this rule offers nothing»: that would hide a
   * misconfigured site behind an empty agenda for every practitioner in it.
   * `site_parameter_slot_atom_minutes_range` forbids the value; this is what
   * happens if something gets past it.
   */
  it('AG-003 refuses to derive a grid from a site whose atom is not a real increment', () => {
    expect(() =>
      slotsOfRuleOn(rule(), parseClinicalDate('2026-09-14'), 0, undefined),
    ).toThrow(RangeError);
  });

  /**
   * D-021, the point of the whole change: the same rule dices differently
   * because the SITE says so, and nothing about the rule changed.
   */
  it('AG-003 derives the grid from the atom of the site, not from the rule', () => {
    const { slots } = availability({ slotAtomMinutes: 30 });

    expect(startsOf(slots)).toEqual([
      '2026-09-14T13:00:00.000Z',
      '2026-09-14T13:30:00.000Z',
    ]);
    expect(slots.every((slot) => slot.slotMinutes === 30)).toBe(true);
  });
});

describe('availability on a holiday', () => {
  it('AG-015 offers no slot on a date the site observes as a holiday, and says why', () => {
    const { slots, closedDates } = availability({
      holidays: [holiday({ name: 'Primer Grito de Independencia' })],
    });

    expect(slots).toEqual([]);
    expect(closedDates).toEqual([
      {
        date: parseClinicalDate('2026-09-14'),
        reason: 'Primer Grito de Independencia',
      },
    ]);
  });

  it('AG-015 keeps showing the appointments already booked on a holiday', () => {
    // The same reasoning as AG-011: the day closing does not un-book anybody,
    // and whoever holds that hour will turn up for it. Hiding the entry would
    // erase it from the screen and from nowhere else.
    const booked = occupancy();

    const { slots, occupied } = availability({
      holidays: [holiday()],
      entries: [booked],
    });

    expect(slots).toEqual([]);
    expect(occupied.map((entry) => entry.id)).toEqual([booked.id]);
  });

  it('AG-016 leaves the day open when the holiday belongs to another site', () => {
    const { slots, closedDates } = availability({
      holidays: [holiday({ siteId: OTHER_SITE })],
    });

    expect(slots).toHaveLength(3);
    expect(closedDates).toEqual([]);
  });

  it('AG-092 offers the slots again when the site works the holiday', () => {
    const { slots, closedDates } = availability({
      holidays: [holiday({ workedBySiteIds: [SITE] })],
    });

    expect(slots).toHaveLength(3);
    expect(closedDates).toEqual([]);
  });

  it('AG-015 closes only the holiday of the range and leaves the other dates alone', () => {
    // Monday the 14th and Monday the 21st both derive slots; only the 21st is
    // a holiday.
    const { slots, closedDates } = availability({
      holidays: [holiday({ date: parseClinicalDate('2026-09-21') })],
      from: '2026-09-14',
      to: '2026-09-21',
    });

    expect(slots).toHaveLength(3);
    expect(
      slots.every((slot) =>
        slot.startsAt.toISOString().startsWith('2026-09-14'),
      ),
    ).toBe(true);
    expect(closedDates.map((closed) => closed.date)).toEqual(['2026-09-21']);
  });

  it('AG-015 reports the closure even when the practitioner offers no slot anyway', () => {
    // The day is closed for the SITE, which has nothing to do with who was
    // asked about: answering "no slots and no reason" would let the screen
    // blame the doctor for a holiday.
    const { slots, closedDates } = availability({
      practitioner: practitioner({ schedulable: false }),
      holidays: [holiday()],
    });

    expect(slots).toEqual([]);
    expect(closedDates).toHaveLength(1);
  });

  it('AG-093 offers the slots of a year with no calendar loaded and warns about it', () => {
    const { slots, closedDates, yearsWithoutCalendar } = availability({
      calendarYears: [],
    });

    // The slots are offered: an unloaded calendar is not a reason to shut the
    // agenda down.
    expect(slots).toHaveLength(3);
    expect(closedDates).toEqual([]);
    // And nothing pretends the year has no holidays.
    expect(yearsWithoutCalendar).toEqual([2026]);
  });

  it('AG-093 stays silent about a year whose calendar is loaded', () => {
    const { yearsWithoutCalendar } = availability({
      holidays: [],
      calendarYears: [2026],
    });

    expect(yearsWithoutCalendar).toEqual([]);
  });
});
