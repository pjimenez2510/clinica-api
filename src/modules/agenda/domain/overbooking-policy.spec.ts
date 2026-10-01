import { describe, expect, it } from 'vitest';

import {
  OverbookingLimitReachedError,
  OverbookingNotAllowedError,
  OverbookingNotAuthorisedError,
  OverbookingPractitionerUnavailableError,
  OverbookingReasonRequiredError,
  SelfAuthorisationDeniedError,
} from './agenda.errors';
import {
  SELF_AUTHORISATION_PERMISSION,
  assertOverbookingAdmitted,
  checkOverbookingAuthoriser,
  checkOverbookingCap,
  checkPractitionerIsThere,
  type PresenceEntry,
  requireOverbookingReason,
} from './overbooking-policy';
import type { ScheduleRule } from './slot-availability';
import {
  WallClockTime,
  addDays,
  atWallClock,
  clinicalDateOf,
  isoWeekdayOf,
} from '../../../shared/domain/clinic-time';

/**
 * The rules of the deliberate exception (E4, D-005), with no database and no
 * clock.
 *
 * WHAT IS NOT HERE. Counting how many overbookings a practitioner already has
 * on a clinical date is a query, and WHICH day that is depends on
 * `America/Guayaquil` — both live in
 * `test/integration/agenda-overbooking.spec.ts`, against a real PostgreSQL.
 * What this file owns is the decision taken with the numbers in hand.
 */

const RECEPTIONIST = 'user-recepcion';
const DOCTOR = 'user-medico';
const REQUIRED = 'agenda:overbook';

describe('AG-039 the site switch', () => {
  it('AG-039 refuses an overbooking where the site has it disabled', () => {
    expect(() =>
      assertOverbookingAdmitted({ overbookingEnabled: false }),
    ).toThrow(OverbookingNotAllowedError);
  });

  it('AG-039 admits it where the site has it enabled', () => {
    expect(() =>
      assertOverbookingAdmitted({ overbookingEnabled: true }),
    ).not.toThrow();
  });
});

describe('AG-035 the reason', () => {
  it('AG-035 demands a reason for the overbooking', () => {
    expect(() => requireOverbookingReason(undefined)).toThrow(
      OverbookingReasonRequiredError,
    );
  });

  it('AG-035 refuses a reason made of blanks', () => {
    // `IS NOT NULL` is satisfied by a space, and a space explains nothing. The
    // CHECK in the base says the same with `btrim(...) <> ''`.
    expect(() => requireOverbookingReason('   ')).toThrow(
      OverbookingReasonRequiredError,
    );
  });

  it('AG-035 hands back the reason trimmed, which is what gets stored', () => {
    expect(requireOverbookingReason('  Urgencia dental  ')).toBe(
      'Urgencia dental',
    );
  });
});

describe('AG-101, AG-103 who may authorise', () => {
  it('AG-103 refuses the overbooking when whoever books it authorises it', () => {
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: RECEPTIONIST,
        requesterId: RECEPTIONIST,
        // Holding the authorising permission is NOT enough, and that is the
        // point: the separation of people is the control, not the permission.
        authoriserPermissions: [REQUIRED],
        requiredPermission: REQUIRED,
      }),
    ).toThrow(SelfAuthorisationDeniedError);
  });

  it('AG-103 admits self-authorisation from whoever holds `agenda:overbook:self`', () => {
    // The doctor on call at 21:00 with nobody else signed in (D-005). The
    // record still says who authorised: it is the same person, on purpose.
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: DOCTOR,
        requesterId: DOCTOR,
        authoriserPermissions: [REQUIRED, SELF_AUTHORISATION_PERMISSION],
        requiredPermission: REQUIRED,
      }),
    ).not.toThrow();
  });

  it('AG-101 refuses a self-authorisation whose holder lacks the authorising permission', () => {
    // `agenda:overbook:self` lifts the separation of people; it does not
    // replace the permission the site demands of an authoriser.
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: DOCTOR,
        requesterId: DOCTOR,
        authoriserPermissions: [SELF_AUTHORISATION_PERMISSION],
        requiredPermission: REQUIRED,
      }),
    ).toThrow(OverbookingNotAuthorisedError);
  });

  it('AG-101 refuses an authoriser without the permission the site configures', () => {
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: DOCTOR,
        requesterId: RECEPTIONIST,
        authoriserPermissions: ['agenda:read', 'agenda:write'],
        requiredPermission: REQUIRED,
      }),
    ).toThrow(OverbookingNotAuthorisedError);
  });

  it('AG-101 names the required permission and never the authoriser', () => {
    // The code is the site's configuration — an administrator reads it on the
    // parameters screen. What that person DOES hold is their access profile,
    // and it is nobody's business here.
    try {
      checkOverbookingAuthoriser({
        authorisedById: DOCTOR,
        requesterId: RECEPTIONIST,
        authoriserPermissions: [],
        requiredPermission: REQUIRED,
      });
      expect.unreachable('debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(OverbookingNotAuthorisedError);
      const problem = error as OverbookingNotAuthorisedError;
      expect(problem.params).toEqual({ requiredPermission: REQUIRED });
      expect(JSON.stringify(problem.fieldErrors)).not.toContain(DOCTOR);
    }
  });

  it('AG-101 refuses an authoriser nobody knows, exactly like one without the permission', () => {
    // An identifier that matches nobody resolves to no permissions. Answering
    // «that account does not exist» would make the booking form a way of
    // confirming which accounts do.
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: 'user-fantasma',
        requesterId: RECEPTIONIST,
        authoriserPermissions: [],
        requiredPermission: REQUIRED,
      }),
    ).toThrow(OverbookingNotAuthorisedError);
  });

  it('AG-101 admits the real case: recepción reserva, el médico autoriza', () => {
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: DOCTOR,
        requesterId: RECEPTIONIST,
        authoriserPermissions: [REQUIRED],
        requiredPermission: REQUIRED,
      }),
    ).not.toThrow();
  });

  it('AG-101 obeys the permission the SITE configures, not a hardcoded one', () => {
    // AG-094: which permission authorises is a site parameter. A site that
    // moved it to `agenda:overbook:self` must refuse the holder of
    // `agenda:overbook` — otherwise the parameter is decoration.
    expect(() =>
      checkOverbookingAuthoriser({
        authorisedById: DOCTOR,
        requesterId: RECEPTIONIST,
        authoriserPermissions: [REQUIRED],
        requiredPermission: SELF_AUTHORISATION_PERMISSION,
      }),
    ).toThrow(OverbookingNotAuthorisedError);
  });
});

describe('AG-100 the cap of the day', () => {
  it('AG-100 refuses the overbooking that would exceed the cap of the site', () => {
    expect(() => checkOverbookingCap({ used: 2, cap: 2 })).toThrow(
      OverbookingLimitReachedError,
    );
  });

  it('AG-100 states the cap in force, which is what the refusal is asked to say', () => {
    try {
      checkOverbookingCap({ used: 2, cap: 2 });
      expect.unreachable('debía rechazarse');
    } catch (error) {
      expect((error as OverbookingLimitReachedError).params).toEqual({
        cap: 2,
      });
    }
  });

  it('AG-100 admits the one that still fits', () => {
    expect(() => checkOverbookingCap({ used: 1, cap: 2 })).not.toThrow();
  });

  it('AG-100 refuses every overbooking where the cap is zero', () => {
    // A site that set the cap to 0 has said «ninguno», which is not the same
    // as disabling the switch: the switch answers `OVERBOOKING_NOT_ALLOWED`
    // and this answers «no caben más hoy». Both are refusals; only one of them
    // is about today.
    expect(() => checkOverbookingCap({ used: 0, cap: 0 })).toThrow(
      OverbookingLimitReachedError,
    );
  });
});

describe('AG-151 the practitioner has to be there (D-069)', () => {
  const SITE = 'site-sur';
  const OTHER = 'site-norte';
  // The day and hour derive from the clock: a fixed date would expire.
  const today = clinicalDateOf(new Date());
  const at = (time: string) => atWallClock(today, WallClockTime.parse(time));
  const request = { siteId: SITE, startsAt: at('10:00'), endsAt: at('10:20') };

  const entry = (overrides: Partial<PresenceEntry> = {}): PresenceEntry => ({
    kind: 'APPOINTMENT',
    siteId: OTHER,
    blocksCalendar: true,
    startsAt: at('10:00'),
    endsAt: at('10:20'),
    ...overrides,
  });

  const rule = (overrides: Partial<ScheduleRule> = {}): ScheduleRule => ({
    id: 'rule-1',
    practitionerId: 'p-1',
    siteId: OTHER,
    serviceTypeConceptId: null,
    weekday: isoWeekdayOf(today),
    startTime: WallClockTime.parse('08:00'),
    endTime: WallClockTime.parse('12:00'),
    validFrom: addDays(today, -30),
    validTo: null,
    active: true,
    ...overrides,
  });

  const conflictOf = (entries: PresenceEntry[], rules: ScheduleRule[] = []) => {
    try {
      checkPractitionerIsThere({ ...request, entries, rulesElsewhere: rules });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(OverbookingPractitionerUnavailableError);
      return (error as OverbookingPractitionerUnavailableError).conflict;
    }
  };

  it('AG-151 refuses an overbooking on top of a block of the practitioner, at this or any other site', () => {
    expect(conflictOf([entry({ kind: 'BLOCK', siteId: SITE })])).toBe('BLOCK');
    expect(conflictOf([entry({ kind: 'BLOCK' })])).toBe('BLOCK');
  });

  it('AG-151 refuses an overbooking on top of what occupies their calendar at another site', () => {
    expect(conflictOf([entry()])).toBe('OTHER_SITE_ENTRY');
  });

  it('AG-151 refuses an overbooking on top of their overbooking at another site', () => {
    expect(conflictOf([entry({ blocksCalendar: false })])).toBe(
      'OTHER_SITE_OVERBOOKING',
    );
  });

  it('AG-151 refuses an overbooking inside their schedule in force at another site', () => {
    expect(conflictOf([], [rule()])).toBe('OTHER_SITE_SCHEDULE');
  });

  it('AG-151 still admits an overbooking on top of appointments of the SAME site: that is what it is for', () => {
    expect(
      conflictOf([
        entry({ siteId: SITE }),
        entry({ siteId: SITE, blocksCalendar: false }),
      ]),
    ).toBeNull();
  });

  it('AG-151 ignores what does not touch the interval: contiguous, another weekday, closed or inactive rules', () => {
    expect(
      conflictOf(
        [entry({ startsAt: at('10:20'), endsAt: at('10:40') })],
        [
          rule({ startTime: WallClockTime.parse('10:20') }),
          rule({ weekday: (isoWeekdayOf(today) % 7) + 1 }),
          rule({ validTo: addDays(today, -1) }),
          rule({ active: false }),
          rule({ siteId: SITE }),
        ],
      ),
    ).toBeNull();
  });
});
