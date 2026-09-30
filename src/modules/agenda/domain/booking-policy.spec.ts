import { describe, expect, it } from 'vitest';

import {
  BookingInThePastError,
  BookingTooFarError,
  BookingTooSoonError,
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
  type BookingWindowCheck,
  DEFAULT_BOOKING_PARAMETERS,
  type SiteBookingParameters,
  checkBookingChannel,
  checkBookingFitsSchedule,
  checkBookingWindow,
  checkRoomBelongsToSite,
  resolveBookingParameters,
  ruleGoverningStart,
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

/**
 * D-021: the grid is the SITE's, so it is an argument of the check and no
 * longer a field of the rule. 20 minutes is what every case below used to read
 * off `rule.slotMinutes`, which is what keeps the diff about the move rather
 * than about the expectations.
 */
type ScheduleCheck = Omit<
  Parameters<typeof checkBookingFitsSchedule>[0],
  'slotAtomMinutes'
> & { slotAtomMinutes?: number };

const fitsSchedule = (check: ScheduleCheck) =>
  checkBookingFitsSchedule({ slotAtomMinutes: 20, ...check });

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
      const applicable = fitsSchedule({
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
        fitsSchedule({ request: afternoon, rules: [rule()] }),
      ).toThrow(OutsideScheduleRuleError);
    });

    // Adversarial review of E1, P1-1: a malformed rule covering the interval
    // used to reach `slotsOfRuleOn` and blow up as RangeError — a 500 for
    // every booking the broken row covered. It must degrade to the same
    // answer as "no rule covers this": a 422 the receptionist can read.
    // Since D-021 «malformada» means the hours are inverted; the slot length
    // is the site's and a broken one is a broken site, which throws.
    it('treats a malformed covering rule as no rule at all, never as a crash', () => {
      const malformed = rule({
        id: 'rule-broken',
        endTime: WallClockTime.parse('07:00'),
      });

      expect(() =>
        fitsSchedule({ request: request(), rules: [malformed] }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('lets a healthy rule govern even when a malformed sibling also covers', () => {
      const malformed = rule({
        id: 'rule-broken',
        endTime: WallClockTime.parse('07:00'),
      });
      const applicable = fitsSchedule({
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
        fitsSchedule({ request: overrunning, rules: [rule()] }),
      ).toThrow(OutsideScheduleRuleError);
    });

    it('AG-028 rejects an interval covered only by an inactive or expired rule', () => {
      expect(() =>
        fitsSchedule({
          request: request(),
          rules: [rule({ active: false })],
        }),
      ).toThrow(OutsideScheduleRuleError);

      expect(() =>
        fitsSchedule({
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

      const applicable = fitsSchedule({
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
        fitsSchedule({
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
        fitsSchedule({
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

      expect(fitsSchedule({ request: forty, rules: [rule()] })?.id).toBe(
        'rule-monday',
      );
    });

    it('AG-012 measures the multiple against the slot atom of the site', () => {
      // 30 minutes is invalid on a 20-minute grid and valid on a 15-minute
      // one. D-021: the SITE decides, not the rule and not a constant.
      const thirty = request({ endsAt: new Date('2026-09-14T13:30:00Z') });

      expect(
        fitsSchedule({
          request: thirty,
          rules: [rule()],
          slotAtomMinutes: 15,
        })?.id,
      ).toBe('rule-monday');
    });

    it('AG-012 rejects an interval that does not last a positive number of minutes', () => {
      expect(() =>
        fitsSchedule({
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

      expect(fitsSchedule({ request: second, rules: [rule()] })?.id).toBe(
        'rule-monday',
      );
    });

    it('AG-104 rejects a booking that does not start on a slot boundary', () => {
      // The case D-007 names: 08:10–08:30 lasts exactly one slot, so AG-012 is
      // satisfied, and it still leaves two ten-minute holes nobody can book.
      const offGrid = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      try {
        fitsSchedule({ request: offGrid, rules: [rule()] });
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
        fitsSchedule({
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
        fitsSchedule({
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
        fitsSchedule({ request: third, rules: [shortRule] });
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

        expect(fitsSchedule({ request: aligned, rules: [shortRule] })?.id).toBe(
          'rule-monday',
        );
      }
    });

    it('AG-104 accepts the start of the last slot of the rule', () => {
      // 08:40–09:00 under a 08:00–09:00 rule: the boundary that an off-by-one
      // in the grid would refuse.
      const last = request({
        startsAt: new Date('2026-09-14T13:40:00Z'),
        endsAt: new Date('2026-09-14T14:00:00Z'),
      });

      expect(fitsSchedule({ request: last, rules: [rule()] })?.id).toBe(
        'rule-monday',
      );
    });

    it('AG-013 refuses a booking for a practitioner who is not schedulable', () => {
      expect(() =>
        fitsSchedule({
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
        fitsSchedule({
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
        fitsSchedule({
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
    /**
     * Same Monday, both covering 08:00–08:30, DIFFERENT OPENING HOURS.
     *
     * The distinguishing feature used to be the slot length, which D-021 took
     * away — the grid is the site's now. What is left is where each rule's
     * grid BEGINS (AG-104): a rule that opens at 08:00 puts a boundary at
     * 08:20, a rule that opens at 08:10 puts one at 08:10 and none at 08:20.
     * So the tie-break still decides whether a booking is accepted, which is
     * exactly why it has to be written down instead of left to whichever row
     * PostgreSQL returns first.
     */
    const opensAtEight = rule({
      id: '018f1b3a-0000-7000-8000-0000000000aa',
      startTime: WallClockTime.parse('08:00'),
      validFrom: '2026-01-01',
    });
    const opensAtTenPast = rule({
      id: '018f1b3a-0000-7000-8000-0000000000bb',
      startTime: WallClockTime.parse('08:10'),
      validFrom: '2026-06-01',
    });

    it('AG-106 applies the rule most recently in force, whatever order the rules arrive in', () => {
      // 08:10–08:30: on the newer rule's grid and off the older one's.
      const tenPast = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      for (const rules of [
        [opensAtEight, opensAtTenPast],
        [opensAtTenPast, opensAtEight],
      ]) {
        expect(
          fitsSchedule({ request: tenPast, rules })?.id,
          `order ${rules.map((r) => r.id).join(',')}`,
        ).toBe(opensAtTenPast.id);
      }
    });

    it('AG-104 refuses under the newer rule what the older one would have admitted', () => {
      // The other half of the tie-break: the 08:10 rule is now the OLDER one,
      // so 08:10 is off the grid that governs — in both input orders.
      const newerAtEight = {
        ...opensAtEight,
        validFrom: parseClinicalDate('2026-07-01'),
      };
      const tenPast = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      for (const rules of [
        [newerAtEight, opensAtTenPast],
        [opensAtTenPast, newerAtEight],
      ]) {
        expect(
          () => fitsSchedule({ request: tenPast, rules }),
          `order ${rules.map((r) => r.id).join(',')}`,
        ).toThrow(SlotNotAlignedError);
      }
    });

    it('AG-106 breaks a tie on identical validity by the rule declared last', () => {
      // `uuidv7()` is time-ordered, so the greater identifier is the row
      // created later: two rules that came into force the same day are still
      // resolved by "the latest thing the clinic declared wins".
      const sameDayTenPast = {
        ...opensAtTenPast,
        validFrom: parseClinicalDate('2026-01-01'),
      };
      const tenPast = request({
        startsAt: new Date('2026-09-14T13:10:00Z'),
        endsAt: new Date('2026-09-14T13:30:00Z'),
      });

      for (const rules of [
        [sameDayTenPast, opensAtEight],
        [opensAtEight, sameDayTenPast],
      ]) {
        expect(
          fitsSchedule({ request: tenPast, rules })?.id,
          // `…bb` was created after `…aa`.
        ).toBe(sameDayTenPast.id);
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

  /**
   * SP-023's third rung, asked WITHOUT an end: which rule is open at the
   * instant recepción clicked. The duration is what is being worked out, so
   * the interval `checkBookingFitsSchedule` needs does not exist yet.
   */
  describe('the schedule rule that governs a start', () => {
    const eight = new Date('2026-09-14T13:00:00Z');

    it('SP-023 devuelve la regla abierta a esa hora', () => {
      // D-021: what the third rung is worth no longer comes from the rule —
      // the site's atom does that — so what this answers is only WHETHER a
      // rule is open, which is what «hay tercer peldaño» means now.
      const governing = ruleGoverningStart([rule()], {
        practitionerId: PRACTITIONER,
        siteId: SITE,
        startsAt: eight,
      });

      expect(governing?.id).toBe('rule-monday');
    });

    it('SP-023 no devuelve ninguna regla cuando la hora cae fuera del horario', () => {
      // 07:00 local: the rule opens at 08:00, so there is no third rung and
      // the caller must say so instead of inventing a duration.
      expect(
        ruleGoverningStart([rule()], {
          practitionerId: PRACTITIONER,
          siteId: SITE,
          startsAt: new Date('2026-09-14T12:00:00Z'),
        }),
      ).toBeNull();
    });

    it('SP-023 trata la hora de cierre como fuera: el intervalo es [abre, cierra)', () => {
      // 09:00 local is when the rule ends. A slot starting exactly there would
      // run past the schedule, which is what `slotsOfRuleOn` already refuses.
      expect(
        ruleGoverningStart([rule()], {
          practitionerId: PRACTITIONER,
          siteId: SITE,
          startsAt: new Date('2026-09-14T14:00:00Z'),
        }),
      ).toBeNull();
    });

    it('AG-106 con dos reglas abiertas a la vez gana la que entró en vigor más tarde', () => {
      const old = rule({ id: 'rule-old', validFrom: '2026-01-01' });
      const fresh = rule({ id: 'rule-new', validFrom: '2026-06-01' });

      // Handed in BOTH orders: the criterion is the domain's, never the order
      // PostgreSQL happened to return the rows in.
      for (const rules of [
        [old, fresh],
        [fresh, old],
      ]) {
        expect(
          ruleGoverningStart(rules, {
            practitionerId: PRACTITIONER,
            siteId: SITE,
            startsAt: eight,
          })?.id,
        ).toBe('rule-new');
      }
    });

    it('SP-023 ignora la regla de otro profesional o de otra sede', () => {
      const foreign = '018f1b3a-0000-7000-8000-00000000000f';

      expect(
        ruleGoverningStart([rule({ practitionerId: foreign })], {
          practitionerId: PRACTITIONER,
          siteId: SITE,
          startsAt: eight,
        }),
      ).toBeNull();
      expect(
        ruleGoverningStart([rule({ siteId: foreign })], {
          practitionerId: PRACTITIONER,
          siteId: SITE,
          startsAt: eight,
        }),
      ).toBeNull();
    });

    it('SP-023 ignora una regla mal formada en lugar de romper la propuesta', () => {
      // Same treatment as availability and booking: an inverted band degrades
      // to "no rule", never to a 500 on a screen recepción is using.
      expect(
        ruleGoverningStart([rule({ endTime: WallClockTime.parse('07:00') })], {
          practitionerId: PRACTITIONER,
          siteId: SITE,
          startsAt: eight,
        }),
      ).toBeNull();
    });
  });
});

/**
 * The booking window of the site (E7): AG-031 to AG-033 and AG-095.
 *
 * THE CLOCK IS A PARAMETER, which is the whole reason these rules are here and
 * not in the service: `now` is injected, so "an appointment two minutes from
 * now" is a value in a test instead of a `setTimeout`, and the assertions do
 * not rot at midnight.
 *
 * Every instant below is written in UTC and read in Ecuador (UTC-5): 13:00Z is
 * 08:00 in Guayaquil.
 */
describe('the booking window of the site', () => {
  /** Monday 14 September 2026, 08:00 in Guayaquil. */
  const NOW = new Date('2026-09-14T13:00:00Z');

  const parameters = (
    overrides: Partial<SiteBookingParameters> = {},
  ): SiteBookingParameters => ({ ...DEFAULT_BOOKING_PARAMETERS, ...overrides });

  const windowOf = (
    overrides: Partial<BookingWindowCheck> = {},
  ): BookingWindowCheck => ({
    startsAt: new Date('2026-09-14T14:00:00Z'), // an hour from NOW
    now: NOW,
    channel: 'PHONE',
    parameters: parameters(),
    ...overrides,
  });

  describe('AG-031 · booking in the past', () => {
    it('AG-031 rejects a start before the current instant when the site does not admit it', () => {
      try {
        checkBookingWindow(
          windowOf({ startsAt: new Date('2026-09-14T12:59:59Z') }),
        );
        expect.unreachable('should have rejected the past start');
      } catch (error) {
        expect(error).toBeInstanceOf(BookingInThePastError);
        const failure = error as BookingInThePastError;
        expect(failure.code).toBe('BOOKING_IN_THE_PAST');
        expect(failure.fieldErrors?.[0]?.field).toBe('startsAt');
      }
    });

    it('AG-031 admits a past start at a site that allows recording after the fact', () => {
      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-14T11:00:00Z'),
            parameters: parameters({ allowPastBooking: true }),
          }),
        ),
      ).not.toThrow();
    });

    it('AG-031 admits a start exactly at the current instant', () => {
      // The boundary is "before now", not "not after now": the appointment of
      // the patient standing at the counter is the case D-001 set the minimum
      // lead to zero for.
      expect(() =>
        checkBookingWindow(windowOf({ startsAt: NOW })),
      ).not.toThrow();
    });
  });

  describe('AG-032 · the minimum lead', () => {
    it('AG-032 rejects a start closer than the minimum lead, naming the first admissible instant', () => {
      try {
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-14T13:20:00Z'), // 20 minutes away
            parameters: parameters({ minLeadMinutes: 60 }),
          }),
        );
        expect.unreachable('should have rejected the booking as too soon');
      } catch (error) {
        expect(error).toBeInstanceOf(BookingTooSoonError);
        const failure = error as BookingTooSoonError;
        expect(failure.code).toBe('BOOKING_TOO_SOON');
        // The requirement's second half: the refusal says WHEN it becomes
        // possible, not merely that it is not.
        expect(failure.params).toEqual({
          earliestStart: '2026-09-14T14:00:00.000Z',
          minLeadMinutes: 60,
        });
        // And it says it in the Ecuadorian wall clock a receptionist reads,
        // never in the UTC instant that travels in `params`.
        expect(failure.fieldErrors?.[0]?.message).toContain('09:00');
        expect(failure.fieldErrors?.[0]?.message).toContain('14/09/2026');
      }
    });

    it('AG-032 admits a start exactly at the first admissible instant', () => {
      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-14T14:00:00Z'),
            parameters: parameters({ minLeadMinutes: 60 }),
          }),
        ),
      ).not.toThrow();
    });

    it('AG-032 does not apply the minimum lead to a WALK_IN booking', () => {
      // Not a convenience: the patient is already at the counter. A minimum
      // lead applied to the window forces reception to declare another
      // channel, and then AG-080 measures smoke.
      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-14T13:01:00Z'),
            channel: 'WALK_IN',
            parameters: parameters({ minLeadMinutes: 600 }),
          }),
        ),
      ).not.toThrow();
    });

    it('AG-032 still applies the minimum lead to the other three channels', () => {
      for (const channel of ['PHONE', 'WEB', 'REFERRAL'] as const) {
        expect(() =>
          checkBookingWindow(
            windowOf({
              startsAt: new Date('2026-09-14T13:01:00Z'),
              channel,
              parameters: parameters({ minLeadMinutes: 600 }),
            }),
          ),
        ).toThrow(BookingTooSoonError);
      }
    });

    it('AG-032 leaves the minimum lead out of a past start the site allowed', () => {
      // A site that turned AG-031 on is recording something that already
      // happened; a "minimum lead" over a past instant would refuse every
      // such record and make the switch useless.
      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-14T11:00:00Z'),
            parameters: parameters({
              allowPastBooking: true,
              minLeadMinutes: 60,
            }),
          }),
        ),
      ).not.toThrow();
    });
  });

  describe('AG-033 · the maximum lead', () => {
    it('AG-033 rejects a start beyond the maximum lead, naming the last admissible date', () => {
      try {
        checkBookingWindow(
          windowOf({
            // 181 days after 14 September 2026 is 14 March 2027.
            startsAt: new Date('2027-03-14T13:00:00Z'),
          }),
        );
        expect.unreachable('should have rejected the booking as too far');
      } catch (error) {
        expect(error).toBeInstanceOf(BookingTooFarError);
        const failure = error as BookingTooFarError;
        expect(failure.code).toBe('BOOKING_TOO_FAR');
        expect(failure.params).toEqual({
          latestDate: '2027-03-13',
          maxLeadDays: 180,
        });
        expect(failure.fieldErrors?.[0]?.field).toBe('startsAt');
        expect(failure.fieldErrors?.[0]?.message).toContain('13/03/2027');
      }
    });

    it('AG-033 admits the whole of the last admissible date', () => {
      // The boundary is a DATE and not an instant, which is what the
      // requirement asks the message to state: any hour of 13 March 2027 is
      // admitted, and 21:00 in Ecuador is 02:00Z of the following day.
      expect(() =>
        checkBookingWindow(
          windowOf({ startsAt: new Date('2027-03-14T02:00:00Z') }),
        ),
      ).not.toThrow();
    });

    it('AG-033 counts the last admissible date in Ecuador and never in UTC', () => {
      // AG-001. With `maxLeadDays` of 1 the last admissible date is 15
      // September; an appointment at 21:00 that day is 02:00Z of the 16th, and
      // a limit computed on the UTC date would refuse it — the same
      // arithmetic that misclassifies a neonate's age.
      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-16T02:00:00Z'),
            parameters: parameters({ maxLeadDays: 1 }),
          }),
        ),
      ).not.toThrow();

      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2026-09-17T02:00:00Z'),
            parameters: parameters({ maxLeadDays: 1 }),
          }),
        ),
      ).toThrow(BookingTooFarError);
    });

    it('AG-033 applies the maximum lead to a WALK_IN booking too', () => {
      // AG-032 grants the counter an exception; AG-033 grants none, and
      // inventing one would be deciding policy nobody wrote down.
      expect(() =>
        checkBookingWindow(
          windowOf({
            startsAt: new Date('2027-03-14T13:00:00Z'),
            channel: 'WALK_IN',
          }),
        ),
      ).toThrow(BookingTooFarError);
    });
  });

  describe('AG-095 · what the agenda operates with when the site says nothing', () => {
    it('AG-095 falls back to the code defaults when the site has no parameters at all', () => {
      expect(resolveBookingParameters(null)).toEqual({
        minLeadMinutes: 0,
        maxLeadDays: 180,
        allowPastBooking: false,
        slotAtomMinutes: 10,
        // E4, D-005: el sobrecupo NACE habilitado, con el tope de D-001 y el
        // permiso que MEDICO y ADMIN traen de fábrica.
        overbookingEnabled: true,
        overbookingCap: 2,
        overbookingPermission: 'agenda:overbook',
        // AG-142: los quince minutos que escribió la migración, resueltos por
        // la misma cadena y no quemados en el código.
        lateArrivalGraceMinutes: 15,
      });
    });

    it('AG-095 keeps every parameter the site does define and completes the rest', () => {
      // Per FIELD and not per row: the requirement is about "un parámetro" not
      // being defined, and a row that answers three of four values must not
      // drag the fourth to a default it never asked for.
      expect(resolveBookingParameters({ minLeadMinutes: 30 })).toEqual({
        minLeadMinutes: 30,
        maxLeadDays: 180,
        allowPastBooking: false,
        slotAtomMinutes: 10,
        overbookingEnabled: true,
        overbookingCap: 2,
        overbookingPermission: 'agenda:overbook',
        lateArrivalGraceMinutes: 15,
      });
    });

    it('AG-095 keeps a site value of zero instead of reading it as absent', () => {
      /**
       * `0` and `false` are legitimate stored values and the falsy trap is the
       * bug this test exists for: `||` instead of `??` replaces a decision the
       * site made with a default it never asked for.
       *
       * `maxLeadDays: 0` IS THE VALUE THAT MAKES THE TEST DISCRIMINATE, and it
       * is the only one available. A falsy stored value only tells the two
       * operators apart when its default is truthy, and `maxLeadDays` is the
       * one parameter whose default is not itself falsy: `0 || 0` is `0` and
       * `false || false` is `false`, so a row of zeroes and falses passes
       * under either operator and proves nothing. Zero days of maximum lead is
       * outside the range `configuration` would ever store — which is beside
       * the point: this function's whole job is to hand back what it was
       * given, and the day a default or a range moves, `||` would start
       * quietly overriding a stored value with no test to notice.
       */
      const resolved = resolveBookingParameters({
        minLeadMinutes: 0,
        maxLeadDays: 0,
        allowPastBooking: false,
        // AG-039: `false` guardado es una decisión de la sede, y el defecto de
        // este parámetro es `true` — así que aquí el operador SÍ discrimina.
        overbookingEnabled: false,
        overbookingCap: 0,
        // AG-142: cero es un valor legítimo —`site_parameter_grace_is_not_
        // negative` lo admite— y es como una sede desactiva la política sin
        // migración. Con `||` volvería a 15, que es justo el fallo.
        lateArrivalGraceMinutes: 0,
      });
      expect(resolved).toEqual({
        minLeadMinutes: 0,
        maxLeadDays: 0,
        allowPastBooking: false,
        slotAtomMinutes: 10,
        overbookingEnabled: false,
        overbookingCap: 0,
        overbookingPermission: 'agenda:overbook',
        lateArrivalGraceMinutes: 0,
      });
    });

    it('AG-094 defaults to the conservative switch: no booking in the past', () => {
      // The migration's argument: that a site opens the past is its decision;
      // that it ships open would be ours.
      expect(DEFAULT_BOOKING_PARAMETERS.allowPastBooking).toBe(false);
    });

    it('AG-095 falls back to the ten-minute atom of D-021 when the site declares none', () => {
      // 10 is the only value of the standard band that 10, 20 and 30 — the
      // durations already configured — are all multiples of, so nothing the
      // clinic had became unbookable when the grid moved to the site.
      expect(DEFAULT_BOOKING_PARAMETERS.slotAtomMinutes).toBe(10);
      expect(resolveBookingParameters({}).slotAtomMinutes).toBe(10);
      expect(
        resolveBookingParameters({ slotAtomMinutes: 15 }).slotAtomMinutes,
      ).toBe(15);
    });
  });
});
