import { describe, expect, it } from 'vitest';

import {
  InvalidBookingChannelError,
  InvalidSlotDurationError,
  OutsideScheduleRuleError,
  RoomNotInSiteError,
  SlotNotAlignedError,
} from './agenda.errors';
import {
  WallClockTime,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  BOOKING_CHANNELS,
  type BookingRequest,
  checkBookingChannel,
  checkBookingFitsSchedule,
  checkRoomBelongsToSite,
} from './booking-policy';
import type { ScheduleRule } from './slot-availability';

const PRACTITIONER = '018f1b3a-0000-7000-8000-000000000001';
const SITE = '018f1b3a-0000-7000-8000-000000000002';

/** Builders brand plain string dates at the test boundary. */
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
  weekday: 1, // 2026-09-14 is a Monday
  startTime: WallClockTime.parse('08:00'),
  endTime: WallClockTime.parse('09:00'),
  slotMinutes: 20,
  validFrom: parseClinicalDate(validFrom ?? '2026-01-01'),
  validTo: validTo == null ? null : parseClinicalDate(validTo),
  active: true,
  ...overrides,
});

/** 08:00–08:20 local on Monday 14 September 2026. */
const request = (overrides: Partial<BookingRequest> = {}): BookingRequest => ({
  practitionerId: PRACTITIONER,
  siteId: SITE,
  startsAt: new Date('2026-09-14T13:00:00Z'),
  endsAt: new Date('2026-09-14T13:20:00Z'),
  ...overrides,
});

describe('booking policy', () => {
  describe('booking channel', () => {
    it('AG-034 accepts only PHONE, WALK_IN, WEB and REFERRAL', () => {
      expect([...BOOKING_CHANNELS]).toEqual([
        'PHONE',
        'WALK_IN',
        'WEB',
        'REFERRAL',
      ]);
      for (const channel of BOOKING_CHANNELS) {
        expect(checkBookingChannel(channel)).toBe(channel);
      }
    });

    it('AG-034 rejects a channel that is not one of the four with INVALID_BOOKING_CHANNEL', () => {
      // `booking_channel` is free text in the database today, so this is the
      // only thing standing between AG-080 and a metric split across
      // spelling variants.
      for (const input of ['telefono', 'Phone', 'phone', '', 'WALKIN']) {
        const failure = (() => {
          try {
            checkBookingChannel(input);
            return null;
          } catch (error) {
            return error;
          }
        })();

        expect(failure, `accepted "${input}"`).toBeInstanceOf(
          InvalidBookingChannelError,
        );
      }
    });

    it('AG-034 rejects a missing channel rather than defaulting to one', () => {
      expect(() => checkBookingChannel(null)).toThrow(
        InvalidBookingChannelError,
      );
      expect(() => checkBookingChannel(undefined)).toThrow(
        InvalidBookingChannelError,
      );
    });
  });

  describe('fit against the schedule rules', () => {
    it('AG-028 accepts an interval that a rule in force covers, and names that rule', () => {
      const applicable = checkBookingFitsSchedule({
        request: request(),
        rules: [rule()],
      });

      expect(applicable?.id).toBe('rule-monday');
    });

    it('AG-028 rejects an interval outside every rule in force with OUTSIDE_SCHEDULE_RULE', () => {
      const afternoon = request({
        startsAt: new Date('2026-09-14T20:00:00Z'), // 15:00 local
        endsAt: new Date('2026-09-14T20:20:00Z'),
      });

      expect(() =>
        checkBookingFitsSchedule({ request: afternoon, rules: [rule()] }),
      ).toThrow(OutsideScheduleRuleError);
    });

    // Adversarial review of E1, P1-1: a malformed rule covering the interval
    // used to reach `slotsOfRuleOn` and blow up as RangeError — a 500 for
    // every booking the broken row covered. It must degrade to the same
    // answer as "no rule covers this": a 422 the receptionist can read.
    it('treats a malformed covering rule as no rule at all, never as a crash', () => {
      const malformed = rule({ id: 'rule-broken', slotMinutes: 0 });

      expect(() =>
        checkBookingFitsSchedule({ request: request(), rules: [malformed] }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('lets a healthy rule govern even when a malformed sibling also covers', () => {
      const malformed = rule({ id: 'rule-broken', slotMinutes: 0 });
      const applicable = checkBookingFitsSchedule({
        request: request(),
        rules: [malformed, rule()],
      });

      expect(applicable?.id).toBe('rule-monday');
    });

    it('AG-028 rejects an interval that starts inside a rule and ends after it', () => {
      const overrunning = request({
        startsAt: new Date('2026-09-14T13:40:00Z'), // 08:40 local
        endsAt: new Date('2026-09-14T14:20:00Z'), // 09:20 local, past the rule
      });

      expect(() =>
        checkBookingFitsSchedule({ request: overrunning, rules: [rule()] }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('AG-028 rejects an interval covered only by an inactive or expired rule', () => {
      expect(() =>
        checkBookingFitsSchedule({
          request: request(),
          rules: [rule({ active: false })],
        }),
      ).toThrow(OutsideScheduleRuleError);

      expect(() =>
        checkBookingFitsSchedule({
          request: request(),
          rules: [rule({ validTo: '2026-09-13' })],
        }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('AG-028 resolves the applicable weekday in Ecuador, not in UTC', () => {
      // 20:00 local Monday is Tuesday 01:00Z. Judged in UTC the Monday rule
      // would not apply and a perfectly ordinary evening booking is refused.
      const evening = request({
        startsAt: new Date('2026-09-15T01:00:00Z'),
        endsAt: new Date('2026-09-15T01:20:00Z'),
      });

      const applicable = checkBookingFitsSchedule({
        request: evening,
        rules: [
          rule({
            startTime: WallClockTime.parse('20:00'),
            endTime: WallClockTime.parse('21:00'),
          }),
        ],
      });

      expect(applicable?.id).toBe('rule-monday');
    });

    it('AG-028 lets a declared overbooking through when no rule covers the interval', () => {
      // The parameter exists so the rule has a documented way out. NOTHING in
      // this delivery sets it: authorising an overbooking is E4 and blocked on
      // schema (AG-035), so today every caller passes it as false.
      const afternoon = request({
        startsAt: new Date('2026-09-14T20:00:00Z'),
        endsAt: new Date('2026-09-14T20:20:00Z'),
      });

      expect(
        checkBookingFitsSchedule({
          request: afternoon,
          rules: [rule()],
          overbookingDeclared: true,
        }),
      ).toBeNull();
    });

    it('AG-012 rejects a duration that is not a multiple of the slot length', () => {
      const thirtyMinutes = request({
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      try {
        checkBookingFitsSchedule({
          request: thirtyMinutes,
          rules: [rule()],
        });
        expect.unreachable('should have rejected the duration');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidSlotDurationError);
        const failure = error as InvalidSlotDurationError;
        // "indicating the admitted duration": the client must be able to tell
        // the user what to change, not just that something was wrong.
        expect(failure.params).toMatchObject({
          slotMinutes: 20,
          requestedMinutes: 30,
        });
        expect(failure.fieldErrors?.[0]?.field).toBe('endsAt');
      }
    });

    it('AG-012 accepts a duration spanning several whole slots of the rule', () => {
      const forty = request({ endsAt: new Date('2026-09-14T13:40:00Z') });

      expect(
        checkBookingFitsSchedule({ request: forty, rules: [rule()] })?.id,
      ).toBe('rule-monday');
    });

    it('AG-012 measures the multiple against the slot length of the applicable rule', () => {
      // 30 minutes is invalid under a 20-minute rule and valid under a
      // 15-minute one. The rule decides, not a constant.
      const thirty = request({ endsAt: new Date('2026-09-14T13:30:00Z') });

      expect(
        checkBookingFitsSchedule({
          request: thirty,
          rules: [rule({ slotMinutes: 15 })],
        })?.id,
      ).toBe('rule-monday');
    });

    it('AG-012 rejects an interval that does not last a positive number of minutes', () => {
      expect(() =>
        checkBookingFitsSchedule({
          request: request({ endsAt: new Date('2026-09-14T13:00:00Z') }),
          rules: [rule()],
        }),
      ).toThrow(InvalidSlotDurationError);
    });

    it('AG-104 accepts a booking that starts on a slot boundary of the rule', () => {
      // 08:20 local: the second slot of a 08:00–09:00 rule of 20 minutes.
      const second = request({
        startsAt: new Date('2026-09-14T13:20:00Z'),
        endsAt: new Date('2026-09-14T13:40:00Z'),
      });

      expect(
        checkBookingFitsSchedule({ request: second, rules: [rule()] })?.id,
      ).toBe('rule-monday');
    });

    it('AG-104 rejects a booking that does not start on a slot boundary', () => {
      // The case D-007 names: 08:10–08:30 lasts exactly one slot, so AG-012 is
      // satisfied, and it still leaves two ten-minute holes nobody can book.
      const offGrid = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      try {
        checkBookingFitsSchedule({ request: offGrid, rules: [rule()] });
        expect.unreachable('should have rejected the start');
      } catch (error) {
        expect(error).toBeInstanceOf(SlotNotAlignedError);
        const failure = error as SlotNotAlignedError;
        expect(failure.code).toBe('SLOT_NOT_ALIGNED');
        // "indicating the nearest admitted starts": the one before and the one
        // after, as instants the client can send straight back.
        expect(failure.params).toEqual({
          requestedStart: '2026-09-14T13:10:00.000Z',
          previousStart: '2026-09-14T13:00:00.000Z',
          nextStart: '2026-09-14T13:20:00.000Z',
        });
        expect(failure.fieldErrors?.[0]?.field).toBe('startsAt');
        // Local wall clock in the sentence the user reads, not the UTC instant.
        expect(failure.fieldErrors?.[0]?.message).toContain('08:00');
        expect(failure.fieldErrors?.[0]?.message).toContain('08:20');
      }
    });

    it('AG-104 lets a declared overbooking start off the grid', () => {
      const offGrid = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      expect(
        checkBookingFitsSchedule({
          request: offGrid,
          rules: [rule()],
          overbookingDeclared: true,
        })?.id,
      ).toBe('rule-monday');
    });

    it('AG-104 keeps requiring a whole slot duration even under a declared overbooking', () => {
      // AG-012 has no overbooking exception: the escape hatch of D-007 is for
      // the grid, not for a duration the schedule cannot represent.
      const tenMinutes = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:20:00Z'),
      });

      expect(() =>
        checkBookingFitsSchedule({
          request: tenMinutes,
          rules: [rule()],
          overbookingDeclared: true,
        }),
      ).toThrow(InvalidSlotDurationError);
    });

    it('AG-104 admits only the starts the rule grid yields, remainder excluded', () => {
      // 08:00–08:50 with 20-minute slots yields 08:00 and 08:20 and leaves ten
      // minutes unbookable. 08:30 is inside the rule and lasts one whole slot,
      // and it is still not a start the schedule offers.
      const shortRule = rule({ endTime: WallClockTime.parse('08:50') });

      const third = request({
        startsAt: new Date('2026-09-14T13:30:00Z'), // 08:30 local
        endsAt: new Date('2026-09-14T13:50:00Z'), // 08:50 local
      });

      try {
        checkBookingFitsSchedule({ request: third, rules: [shortRule] });
        expect.unreachable('should have rejected the start');
      } catch (error) {
        expect(error).toBeInstanceOf(SlotNotAlignedError);
        // No slot starts after 08:20 under this rule, so there is no next one
        // to suggest and none is invented.
        expect((error as SlotNotAlignedError).params).toEqual({
          requestedStart: '2026-09-14T13:30:00.000Z',
          previousStart: '2026-09-14T13:20:00.000Z',
        });
      }

      // The two starts the grid does yield are accepted.
      for (const start of ['13:00', '13:20']) {
        const aligned = request({
          startsAt: new Date(`2026-09-14T${start}:00Z`),
          endsAt: new Date(
            new Date(`2026-09-14T${start}:00Z`).getTime() + 20 * 60_000,
          ),
        });

        expect(
          checkBookingFitsSchedule({ request: aligned, rules: [shortRule] })
            ?.id,
        ).toBe('rule-monday');
      }
    });

    it('AG-104 accepts the start of the last slot of the rule', () => {
      // 08:40–09:00 under a 08:00–09:00 rule: the boundary that an off-by-one
      // in the grid would refuse.
      const last = request({
        startsAt: new Date('2026-09-14T13:40:00Z'),
        endsAt: new Date('2026-09-14T14:00:00Z'),
      });

      expect(
        checkBookingFitsSchedule({ request: last, rules: [rule()] })?.id,
      ).toBe('rule-monday');
    });

    it('AG-013 refuses a booking for a practitioner who is not schedulable', () => {
      expect(() =>
        checkBookingFitsSchedule({
          request: request(),
          rules: [rule()],
          practitioner: {
            practitionerId: PRACTITIONER,
            schedulable: false,
            siteIds: [SITE],
          },
        }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('AG-013 refuses a non-schedulable practitioner even when overbooking is declared', () => {
      // "NO DEBERÁ admitir citas nuevas para él" has no exception. The
      // overbooking escape hatch is for the schedule grid, not for a
      // practitioner who is switched off.
      expect(() =>
        checkBookingFitsSchedule({
          request: request(),
          rules: [rule()],
          overbookingDeclared: true,
          practitioner: {
            practitionerId: PRACTITIONER,
            schedulable: false,
            siteIds: [SITE],
          },
        }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('AG-014 refuses a booking at a site the practitioner is not linked to', () => {
      expect(() =>
        checkBookingFitsSchedule({
          request: request(),
          rules: [rule()],
          practitioner: {
            practitionerId: PRACTITIONER,
            schedulable: true,
            siteIds: ['018f1b3a-0000-7000-8000-000000000009'],
          },
        }),
      ).toThrow(OutsideScheduleRuleError);
    });
  });

  /**
   * Two rules in force covering the same hours is a state the database does
   * not forbid today, and the answer must not depend on which row PostgreSQL
   * happened to return first: the same booking would be accepted before a
   * `VACUUM` and refused after it.
   */
  describe('which rule applies when two of them cover the interval', () => {
    /** Same Monday, same hours, different slot lengths. */
    const twentyMinuteRule = rule({
      id: '018f1b3a-0000-7000-8000-0000000000aa',
      slotMinutes: 20,
      validFrom: '2026-01-01',
    });
    const thirtyMinuteRule = rule({
      id: '018f1b3a-0000-7000-8000-0000000000bb',
      slotMinutes: 30,
      validFrom: '2026-06-01',
    });

    it('AG-106 applies the rule most recently in force, whatever order the rules arrive in', () => {
      const halfHour = request({ endsAt: new Date('2026-09-14T13:30:00Z') });

      for (const rules of [
        [twentyMinuteRule, thirtyMinuteRule],
        [thirtyMinuteRule, twentyMinuteRule],
      ]) {
        expect(
          checkBookingFitsSchedule({ request: halfHour, rules })?.id,
          `order ${rules.map((r) => r.slotMinutes).join(',')}`,
        ).toBe(thirtyMinuteRule.id);
      }
    });

    it('AG-012 refuses under the newer rule what the older one would have admitted', () => {
      // The other half of the tie-break: the 20-minute rule is the newer one
      // here, so a 30-minute booking is rejected — and it is rejected in both
      // input orders, which is the point.
      const newerTwenty = {
        ...twentyMinuteRule,
        validFrom: parseClinicalDate('2026-07-01'),
      };
      const halfHour = request({ endsAt: new Date('2026-09-14T13:30:00Z') });

      for (const rules of [
        [newerTwenty, thirtyMinuteRule],
        [thirtyMinuteRule, newerTwenty],
      ]) {
        try {
          checkBookingFitsSchedule({ request: halfHour, rules });
          expect.unreachable('should have rejected the duration');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidSlotDurationError);
          expect((error as InvalidSlotDurationError).params).toMatchObject({
            slotMinutes: 20,
          });
        }
      }
    });

    it('AG-106 breaks a tie on identical validity by the rule declared last', () => {
      // `uuidv7()` is time-ordered, so the greater identifier is the row
      // created later: two rules that came into force the same day are still
      // resolved by "the latest thing the clinic declared wins".
      const sameDayThirty = {
        ...thirtyMinuteRule,
        validFrom: parseClinicalDate('2026-01-01'),
      };
      const halfHour = request({ endsAt: new Date('2026-09-14T13:30:00Z') });

      for (const rules of [
        [sameDayThirty, twentyMinuteRule],
        [twentyMinuteRule, sameDayThirty],
      ]) {
        expect(
          checkBookingFitsSchedule({ request: halfHour, rules })?.id,
          // `…bb` was created after `…aa`.
        ).toBe(sameDayThirty.id);
      }
    });
  });

  /**
   * AG-071 through the body of the request. The room is a physical resource of
   * ONE site, and nothing in the schema ties `agenda_entry.room_id` to
   * `agenda_entry.site_id`.
   */
  describe('the room belongs to the site being booked', () => {
    it('AG-105 rejects a room that belongs to another site', () => {
      const other = '018f1b3a-0000-7000-8000-00000000000c';

      try {
        checkRoomBelongsToSite(other, SITE);
        expect.unreachable('should have rejected the room');
      } catch (error) {
        expect(error).toBeInstanceOf(RoomNotInSiteError);
        const failure = error as RoomNotInSiteError;
        expect(failure.code).toBe('ROOM_NOT_IN_SITE');
        expect(failure.fieldErrors?.[0]?.field).toBe('roomId');
        // Neither identifier travels: the caller does not need to learn which
        // site a room it may not use belongs to.
        expect(JSON.stringify(failure.fieldErrors)).not.toContain(other);
        expect(failure.params).toEqual({});
      }
    });

    it('AG-071 accepts a room of the same site', () => {
      expect(() => checkRoomBelongsToSite(SITE, SITE)).not.toThrow();
    });

    it('AG-071 leaves a room that does not exist to the foreign key', () => {
      // Answering "not in this site" for an unknown identifier would turn the
      // endpoint into an oracle for guessing room ids, and the insert refuses
      // it anyway.
      expect(() => checkRoomBelongsToSite(null, SITE)).not.toThrow();
    });
  });
});
