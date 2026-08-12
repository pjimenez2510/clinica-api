import { describe, expect, it } from 'vitest';

import {
  WallClockTime,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
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
  slotMinutes: 20,
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

const availability = (input: {
  rules?: readonly ScheduleRule[];
  entries?: readonly AgendaOccupancy[];
  practitioner?: PractitionerAvailability;
  from?: string;
  to?: string;
  siteId?: string;
}) =>
  deriveAvailability({
    practitioner: input.practitioner ?? practitioner(),
    siteId: input.siteId ?? SITE,
    rules: input.rules ?? [rule()],
    entries: input.entries ?? [],
    from: parseClinicalDate(input.from ?? '2026-09-14'),
    to: parseClinicalDate(input.to ?? '2026-09-14'),
  });

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
    const zeroSlot = rule({ id: 'rule-zero', slotMinutes: 0 });
    const inverted = rule({
      id: 'rule-inverted',
      endTime: WallClockTime.parse('07:00'),
    });
    const impossibleWeekday = rule({ id: 'rule-weekday', weekday: 8 });

    const { slots } = availability({
      rules: [zeroSlot, healthy, inverted, impossibleWeekday],
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.ruleId === healthy.id)).toBe(true);
  });

  it('still refuses to derive slots directly from a malformed rule', () => {
    expect(() =>
      slotsOfRuleOn(
        rule({ slotMinutes: 0 }),
        parseClinicalDate('2026-09-14'),
        undefined,
      ),
    ).toThrow(RangeError);
    expect(() =>
      slotsOfRuleOn(
        rule({ endTime: WallClockTime.parse('07:00') }),
        parseClinicalDate('2026-09-14'),
        undefined,
      ),
    ).toThrow(RangeError);
  });
});
