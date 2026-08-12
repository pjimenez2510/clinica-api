import { afterEach, describe, expect, it } from 'vitest';

// Tests exercise the branded functions with literals; the alias keeps them terse.

import {
  CLINIC_TIME_ZONE,
  WallClockTime,
  atWallClock,
  clinicalDateOf,
  clinicalDatesBetween,
  clinicalDayBounds,
  isoWeekdayOf,
  parseClinicalDate,
  wallClockOf,
  zoneOffsetMinutes,
} from './clinic-time';

const d = parseClinicalDate;

/**
 * The clinical date is the date in Ecuador, never the date on the host.
 *
 * Several tests move `process.env.TZ` on purpose: Node re-reads it, so this is
 * the cheapest way to prove the result does not depend on how the server, a
 * container or a developer laptop happens to be configured. Same intent as
 * `test/integration/clinical-date-timezone.spec.ts`, one layer down.
 */
describe('clinic time', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  /** 21:00 on 13 September in Guayaquil: an ordinary evening consultation. */
  const EVENING = new Date('2026-09-14T02:00:00Z');

  describe('clinical date', () => {
    it('AG-001 resolves an evening instant to the Ecuadorian date, not the UTC one', () => {
      expect(clinicalDateOf(EVENING)).toBe('2026-09-13');
    });

    it('AG-001 resolves the same clinical date whatever the process time zone', () => {
      const expected = clinicalDateOf(EVENING);

      for (const tz of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Denver']) {
        process.env.TZ = tz;
        expect(clinicalDateOf(EVENING), `with TZ=${tz}`).toBe(expected);
      }
      expect(expected).toBe('2026-09-13');
    });

    it('AG-001 delimits the clinical day with the bounds of Ecuador', () => {
      const bounds = clinicalDayBounds(d('2026-09-13'));

      expect(bounds.startsAt.toISOString()).toBe('2026-09-13T05:00:00.000Z');
      expect(bounds.endsAtExclusive.toISOString()).toBe(
        '2026-09-14T05:00:00.000Z',
      );
    });

    it('AG-001 gives the same day bounds whatever the process time zone', () => {
      process.env.TZ = 'Asia/Tokyo';
      const shifted = clinicalDayBounds(d('2026-09-13'));

      expect(shifted.startsAt.toISOString()).toBe('2026-09-13T05:00:00.000Z');
    });
  });

  describe('zone offset', () => {
    it('AG-001 derives the offset from the zone instead of assuming a fixed one', () => {
      // The guarantee is not "Ecuador is UTC-5" — it is that nothing in the
      // code says so. A zone WITH daylight saving proves the offset is read
      // from the IANA database: same wall clock, two different offsets.
      expect(
        zoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), CLINIC_TIME_ZONE),
      ).toBe(-300);
      expect(
        zoneOffsetMinutes(new Date('2026-01-01T12:00:00Z'), CLINIC_TIME_ZONE),
      ).toBe(-300);

      expect(
        zoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/New_York'),
      ).toBe(-240);
      expect(
        zoneOffsetMinutes(new Date('2026-01-01T12:00:00Z'), 'America/New_York'),
      ).toBe(-300);
    });

    it('AG-002 combines a wall-clock rule with a local date across a daylight-saving change', () => {
      // A rule that says "Mondays at 08:00" must mean 08:00 local on both
      // sides of a transition, which a hard-coded offset cannot do.
      const summer = atWallClock(
        d('2026-07-06'),
        WallClockTime.parse('08:00'),
        'America/New_York',
      );
      const winter = atWallClock(
        d('2026-01-05'),
        WallClockTime.parse('08:00'),
        'America/New_York',
      );

      expect(summer.toISOString()).toBe('2026-07-06T12:00:00.000Z');
      expect(winter.toISOString()).toBe('2026-01-05T13:00:00.000Z');
    });
  });

  describe('wall-clock rules', () => {
    it('AG-002 turns a weekly wall-clock rule into an instant in Ecuador', () => {
      const instant = atWallClock(
        d('2026-09-14'),
        WallClockTime.parse('08:00'),
      );

      expect(instant.toISOString()).toBe('2026-09-14T13:00:00.000Z');
      expect(clinicalDateOf(instant)).toBe('2026-09-14');
    });

    it('AG-002 keeps the wall clock as minutes of the day, not as an instant', () => {
      const time = WallClockTime.parse('08:30:00');

      expect(time.minutesFromMidnight).toBe(510);
      expect(time.toString()).toBe('08:30');
      expect(time.plusMinutes(20).toString()).toBe('08:50');
      expect(time.isBefore(WallClockTime.parse('08:31'))).toBe(true);
      expect(time.isBefore(WallClockTime.parse('08:30'))).toBe(false);
    });

    it('AG-002 reads the wall clock an instant shows in Ecuador', () => {
      // The inverse of `atWallClock`: what a receptionist reads on the clock
      // when that instant strikes. 13:10Z is 08:10 in Guayaquil.
      const instant = new Date('2026-09-14T13:10:00Z');

      expect(wallClockOf(instant).toString()).toBe('08:10');

      process.env.TZ = 'Asia/Tokyo';
      expect(wallClockOf(instant).toString()).toBe('08:10');

      // A zone that does move daylight saving, to prove the offset is read.
      expect(wallClockOf(instant, 'Europe/Madrid').toString()).toBe('15:10');
    });

    it('AG-002 reads a wall clock out of a `time` column without applying any zone', () => {
      // Prisma hands back a `time` column as 1970-01-01T08:00:00Z. Reading it
      // with local getters would shift the rule by the host offset.
      expect(
        WallClockTime.fromTimeColumn(
          new Date('1970-01-01T08:00:00Z'),
        ).toString(),
      ).toBe('08:00');

      process.env.TZ = 'Asia/Tokyo';
      expect(
        WallClockTime.fromTimeColumn(
          new Date('1970-01-01T08:00:00Z'),
        ).toString(),
      ).toBe('08:00');
    });

    it('rejects a wall clock that is not a time of day', () => {
      expect(() => WallClockTime.parse('24:00')).toThrow(RangeError);
      expect(() => WallClockTime.parse('8:00')).toThrow(RangeError);
      expect(() => WallClockTime.parse('08:60')).toThrow(RangeError);
      expect(() => WallClockTime.parse('mediodía')).toThrow(RangeError);
      expect(() => WallClockTime.fromMinutes(-1)).toThrow(RangeError);
      expect(() => WallClockTime.fromMinutes(1441)).toThrow(RangeError);
    });

    it('keeps the seconds a `time(0)` column can carry', () => {
      const time = WallClockTime.parse('08:30:45');

      expect(time.toString()).toBe('08:30:45');
      expect(atWallClock(d('2026-09-14'), time).toISOString()).toBe(
        '2026-09-14T13:30:45.000Z',
      );
    });
  });

  describe('calendar arithmetic', () => {
    it('AG-001 numbers the weekday the way the schedule rule does (1 = Monday)', () => {
      expect(isoWeekdayOf(d('2026-09-14'))).toBe(1); // Monday
      expect(isoWeekdayOf(d('2026-09-13'))).toBe(7); // Sunday
    });

    it('AG-010 enumerates a date range inclusively, month boundary included', () => {
      expect(clinicalDatesBetween(d('2026-09-29'), d('2026-10-02'))).toEqual([
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
      ]);
      expect(clinicalDatesBetween(d('2026-09-29'), d('2026-09-29'))).toEqual([
        '2026-09-29',
      ]);
      expect(clinicalDatesBetween(d('2026-09-29'), d('2026-09-28'))).toEqual(
        [],
      );
    });

    it('rejects a date that is not an ISO calendar date', () => {
      expect(() => parseClinicalDate('13/09/2026')).toThrow(RangeError);
      expect(() => parseClinicalDate('2026-13-01')).toThrow(RangeError);
      expect(() => parseClinicalDate('2026-02-30')).toThrow(RangeError);
      expect(parseClinicalDate('2026-02-28')).toBe('2026-02-28');
    });

    it('refuses a range whose span is unbounded in practice', () => {
      expect(() =>
        clinicalDatesBetween(d('2026-01-01'), d('2030-01-01')),
      ).toThrow(RangeError);
    });
  });
});
