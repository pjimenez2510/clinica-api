import { describe, expect, it } from 'vitest';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  InvalidBookingChannelError,
  InvalidSlotDurationError,
  OutsideScheduleRuleError,
  RoomNotInSiteError,
  SlotNotAlignedError,
} from '../domain/agenda.errors';
import {
  WallClockTime,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import type {
  AgendaEntryView,
  AgendaRepository,
  AvailabilityContext,
  AvailabilityContextQuery,
  DailyAgendaQuery,
  NewBooking,
  PatientBookingStatus,
  ScheduleContext,
  ScheduleContextQuery,
} from '../domain/agenda.repository';
import type { AgendaOccupancy } from '../domain/slot-availability';
import { AgendaService, type Requester } from './agenda.service';

/**
 * The application layer of the agenda, against doubles of its port.
 *
 * WHAT IS NOT TESTED HERE, and it is the important half: nothing about
 * overlapping appointments. That rule is two `EXCLUDE USING gist` constraints,
 * and a double that returns whatever we programmed cannot prove one exists.
 * It is exercised in `test/integration/agenda-overlap.spec.ts` against a real
 * PostgreSQL. What IS here is what the service decides on its own: the day
 * boundaries in Ecuador, the merged chart, the booking channel and who booked.
 */

const SITE = '00000000-0000-4000-8000-000000000001';
const PRACTITIONER = '00000000-0000-4000-8000-000000000002';
const PATIENT = '00000000-0000-4000-8000-000000000003';
const USER = '00000000-0000-4000-8000-000000000004';
const ROOM = '00000000-0000-4000-8000-000000000005';
const OTHER_SITE = '00000000-0000-4000-8000-000000000006';

const REQUESTER: Requester = { userId: USER };

/** A Monday. The rule below applies to it. */
const DATE = parseClinicalDate('2026-09-14');

const RULE = {
  id: 'rule-1',
  practitionerId: PRACTITIONER,
  siteId: SITE,
  serviceTypeConceptId: null,
  weekday: 1,
  startTime: WallClockTime.parse('08:00'),
  endTime: WallClockTime.parse('12:00'),
  slotMinutes: 20,
  validFrom: parseClinicalDate('2026-01-01'),
  validTo: null,
  active: true,
};

/** 08:00 in Guayaquil on that Monday: the first slot boundary of the rule. */
const EIGHT = new Date('2026-09-14T13:00:00Z');
const EIGHT_TWENTY = new Date('2026-09-14T13:20:00Z');

function anEntry(overrides: Partial<AgendaEntryView> = {}): AgendaEntryView {
  return {
    id: 'entry-1',
    kind: 'APPOINTMENT',
    siteId: SITE,
    practitionerId: PRACTITIONER,
    roomId: null,
    patientId: PATIENT,
    startsAt: EIGHT,
    endsAt: EIGHT_TWENTY,
    status: 'BOOKED',
    blocksCalendar: true,
    releasedAt: null,
    bookingChannel: 'PHONE',
    serviceTypeConceptId: null,
    createdById: USER,
    ...overrides,
  };
}

/** The same appointment, reduced to what availability reads of it. */
function anOccupancy(
  overrides: Partial<AgendaOccupancy> = {},
): AgendaOccupancy {
  return {
    id: 'entry-1',
    practitionerId: PRACTITIONER,
    siteId: SITE,
    startsAt: EIGHT,
    endsAt: EIGHT_TWENTY,
    blocksCalendar: true,
    releasedAt: null,
    ...overrides,
  };
}

interface Recorded {
  daily: DailyAgendaQuery[];
  context: ScheduleContextQuery[];
  availability: AvailabilityContextQuery[];
  rooms: string[];
  booked: NewBooking[];
}

function repositoryDouble(
  overrides: {
    entries?: AgendaEntryView[];
    patient?: PatientBookingStatus | null;
    context?: ScheduleContext;
    availability?: AvailabilityContext;
    roomSiteId?: string | null;
  } = {},
): { repository: AgendaRepository; recorded: Recorded } {
  const recorded: Recorded = {
    daily: [],
    context: [],
    availability: [],
    rooms: [],
    booked: [],
  };

  const repository: AgendaRepository = {
    dailyAgenda: (query) => {
      recorded.daily.push(query);
      return Promise.resolve(overrides.entries ?? []);
    },
    findPatientForBooking: () =>
      Promise.resolve(
        overrides.patient === undefined
          ? { id: PATIENT, mergedIntoMrn: null }
          : overrides.patient,
      ),
    roomSiteOf: (roomId) => {
      recorded.rooms.push(roomId);
      return Promise.resolve(
        overrides.roomSiteId === undefined ? SITE : overrides.roomSiteId,
      );
    },
    scheduleContextFor: (query) => {
      recorded.context.push(query);
      return Promise.resolve(
        overrides.context ?? {
          practitioner: {
            practitionerId: PRACTITIONER,
            schedulable: true,
            siteIds: [SITE],
          },
          rules: [RULE],
        },
      );
    },
    availabilityContextFor: (query) => {
      recorded.availability.push(query);
      return Promise.resolve(
        overrides.availability ?? {
          practitioner: {
            practitionerId: PRACTITIONER,
            schedulable: true,
            siteIds: [SITE],
          },
          rules: [RULE],
          entries: [],
        },
      );
    },
    book: (booking) => {
      recorded.booked.push(booking);
      return Promise.resolve(
        anEntry({
          bookingChannel: booking.bookingChannel,
          createdById: booking.createdById,
        }),
      );
    },
  };

  return { repository, recorded };
}

/** Enough of PinoLogger for the service, without booting NestJS. */
function loggerDouble(): {
  logger: ConstructorParameters<typeof AgendaService>[1];
  lines: unknown[];
} {
  const lines: unknown[] = [];
  const logger = {
    setContext: () => undefined,
    info: (payload: unknown) => lines.push(payload),
    error: (payload: unknown) => lines.push(payload),
  };
  return {
    logger: logger as unknown as ConstructorParameters<typeof AgendaService>[1],
    lines,
  };
}

function serviceWith(overrides: Parameters<typeof repositoryDouble>[0] = {}): {
  service: AgendaService;
  recorded: Recorded;
  lines: unknown[];
} {
  const { repository, recorded } = repositoryDouble(overrides);
  const { logger, lines } = loggerDouble();
  return { service: new AgendaService(repository, logger), recorded, lines };
}

const aBooking = (overrides: Record<string, unknown> = {}) => ({
  siteId: SITE,
  practitionerId: PRACTITIONER,
  patientId: PATIENT,
  startsAt: EIGHT,
  endsAt: EIGHT_TWENTY,
  bookingChannel: 'PHONE',
  ...overrides,
});

describe('the daily agenda', () => {
  it('AG-017 bounds the day in America/Guayaquil, not in the host zone', async () => {
    // 14 September in Ecuador runs from 05:00Z to 05:00Z the next day. Cut in
    // UTC, an appointment at 20:30 local would be filed under the 15th and a
    // receptionist would not find it on the day it happens.
    const { service, recorded } = serviceWith();

    await service.dailyAgenda({ siteId: SITE, date: DATE });

    expect(recorded.daily[0]).toMatchObject({
      siteId: SITE,
      from: new Date('2026-09-14T05:00:00Z'),
      untilExclusive: new Date('2026-09-15T05:00:00Z'),
    });
  });

  it('AG-017 narrows to a practitioner or a room when asked', async () => {
    const { service, recorded } = serviceWith();

    await service.dailyAgenda({
      siteId: SITE,
      date: DATE,
      practitionerId: PRACTITIONER,
      roomId: 'room-1',
    });

    expect(recorded.daily[0]).toMatchObject({
      practitionerId: PRACTITIONER,
      roomId: 'room-1',
    });
  });

  it('AG-018 leaves released entries out unless they are asked for', async () => {
    const { service, recorded } = serviceWith();

    await service.dailyAgenda({ siteId: SITE, date: DATE });
    await service.dailyAgenda({
      siteId: SITE,
      date: DATE,
      includeReleased: true,
    });

    expect(recorded.daily.map((q) => q.includeReleased)).toEqual([false, true]);
  });

  it('AG-072 records no chart access for the rows it lists', async () => {
    // SC-004: listing the agenda writes zero audit rows. The service has no
    // audit port at all, which is the strongest form of that guarantee — there
    // is nothing to forget to leave out.
    const { service } = serviceWith({ entries: [anEntry(), anEntry()] });

    const listed = await service.dailyAgenda({ siteId: SITE, date: DATE });

    expect(listed).toHaveLength(2);
    expect(Object.keys(service)).not.toContain('audit');
  });
});

describe('booking an appointment', () => {
  it('AG-029 records the booking channel and the user who booked', async () => {
    const { service, recorded } = serviceWith();

    const entry = await service.book(
      { ...aBooking(), bookingChannel: 'WALK_IN' },
      REQUESTER,
    );

    expect(recorded.booked[0]).toMatchObject({
      bookingChannel: 'WALK_IN',
      createdById: USER,
    });
    expect(entry.bookingChannel).toBe('WALK_IN');
  });

  it('AG-034 refuses an unknown booking channel before writing anything', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.book({ ...aBooking(), bookingChannel: 'telefono' }, REQUESTER),
    ).rejects.toBeInstanceOf(InvalidBookingChannelError);

    expect(recorded.booked).toEqual([]);
  });

  it('AG-027 refuses to book for a merged patient and says where the chart went', async () => {
    const { service, recorded } = serviceWith({
      patient: { id: PATIENT, mergedIntoMrn: 'HC0000000042' },
    });

    const rejection = await service
      .book(aBooking(), REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(PatientMergedError);
    expect((rejection as PatientMergedError).code).toBe('PATIENT_MERGED');
    expect((rejection as PatientMergedError).params).toMatchObject({
      mrn: 'HC0000000042',
    });
    // NOT a 404 and NOT a write: the chart exists, it just moved.
    expect(recorded.booked).toEqual([]);
  });

  it('AG-028 refuses an interval no schedule rule in force covers', async () => {
    const { service } = serviceWith();

    await expect(
      service.book(
        {
          ...aBooking(),
          // 19:00 in Ecuador: the rule ends at noon.
          startsAt: new Date('2026-09-15T00:00:00Z'),
          endsAt: new Date('2026-09-15T00:20:00Z'),
        },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(OutsideScheduleRuleError);
  });

  it('AG-012 refuses a duration that is not a multiple of the slot', async () => {
    const { service } = serviceWith();

    await expect(
      service.book(
        { ...aBooking(), endsAt: new Date('2026-09-14T13:30:00Z') },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(InvalidSlotDurationError);
  });

  it('AG-104 refuses a start that is not a slot boundary', async () => {
    const { service } = serviceWith();

    await expect(
      service.book(
        {
          ...aBooking(),
          startsAt: new Date('2026-09-14T13:10:00Z'),
          endsAt: new Date('2026-09-14T13:30:00Z'),
        },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(SlotNotAlignedError);
  });

  it('AG-013 refuses a practitioner who is switched off for scheduling', async () => {
    const { service } = serviceWith({
      context: {
        practitioner: {
          practitionerId: PRACTITIONER,
          schedulable: false,
          siteIds: [SITE],
        },
        rules: [RULE],
      },
    });

    await expect(service.book(aBooking(), REQUESTER)).rejects.toBeInstanceOf(
      OutsideScheduleRuleError,
    );
  });

  it('AG-020 asks the schedule about the clinical date of the requested start', async () => {
    // The rules are weekly wall-clock rows, so the date they are read for has
    // to be the Ecuadorian one. Read in UTC, a 20:00 appointment would be
    // matched against Tuesday's rules.
    const { service, recorded } = serviceWith();

    await service.book(aBooking(), REQUESTER);

    expect(recorded.context[0]).toEqual({
      practitionerId: PRACTITIONER,
      siteId: SITE,
      date: DATE,
    });
  });

  it('AG-105 refuses a room that belongs to another site, before writing anything', async () => {
    // Nothing ties `agenda_entry.room_id` to `agenda_entry.site_id`, so
    // without this check a receptionist scoped to one site occupies a
    // consulting room of another — and the entry never shows on that site's
    // agenda, which filters by `site_id`.
    const { service, recorded } = serviceWith({ roomSiteId: OTHER_SITE });

    const rejection = await service
      .book({ ...aBooking(), roomId: ROOM }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(RoomNotInSiteError);
    expect((rejection as RoomNotInSiteError).code).toBe('ROOM_NOT_IN_SITE');
    expect(recorded.booked).toEqual([]);
  });

  it('AG-071 books into a room of the site being booked', async () => {
    const { service, recorded } = serviceWith({ roomSiteId: SITE });

    await service.book({ ...aBooking(), roomId: ROOM }, REQUESTER);

    expect(recorded.rooms).toEqual([ROOM]);
    expect(recorded.booked[0]).toMatchObject({ roomId: ROOM });
  });

  it('AG-071 does not ask about a room when the booking has none', async () => {
    const { service, recorded } = serviceWith();

    await service.book(aBooking(), REQUESTER);

    expect(recorded.rooms).toEqual([]);
  });

  it('AG-074 logs no name, document or reason for the visit', async () => {
    const { service, lines } = serviceWith();

    await service.book(
      { ...aBooking(), reason: 'Control de embarazo' },
      REQUESTER,
    );

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('Control de embarazo');
    expect(logged).not.toContain(PATIENT);
  });
});

/**
 * The availability view, against doubles of the port.
 *
 * WHAT IS BEING VERIFIED HERE is the wiring, not the arithmetic: the grid
 * itself is `deriveAvailability`, already exercised in
 * `domain/slot-availability.spec.ts` without a database. What only this layer
 * can get wrong is which window it asks the port for — and it has to be the
 * Ecuadorian one — and whether it reuses that one derivation instead of
 * growing a second.
 */
describe('the availability view', () => {
  it('AG-010 asks the port for the rules and the occupancy of the whole range', async () => {
    const { service, recorded } = serviceWith();

    await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-16'),
    });

    expect(recorded.availability[0]).toEqual({
      practitionerId: PRACTITIONER,
      siteId: SITE,
      fromDate: '2026-09-14',
      toDate: '2026-09-16',
      // Wednesday the 16th ends at 05:00Z on the 17th in Ecuador.
      from: new Date('2026-09-14T05:00:00Z'),
      untilExclusive: new Date('2026-09-17T05:00:00Z'),
    });
  });

  it('AG-001 bounds the availability range in America/Guayaquil while the host clock is elsewhere', async () => {
    // Node re-reads `process.env.TZ`, so this really moves the host's clock.
    // 12 August 2026 in Tokyo begins nine hours before it begins anywhere, and
    // a range cut with the host's offset would start the day on the 11th in
    // Ecuador and end it fourteen hours early.
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';

    try {
      const { service, recorded } = serviceWith();

      await service.availability({
        siteId: SITE,
        practitionerId: PRACTITIONER,
        from: parseClinicalDate('2026-08-12'),
        to: parseClinicalDate('2026-08-12'),
      });

      expect(recorded.availability[0]).toMatchObject({
        from: new Date('2026-08-12T05:00:00Z'),
        untilExclusive: new Date('2026-08-13T05:00:00Z'),
      });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('AG-003 derives the free slots of the range and writes nothing', async () => {
    const { service, recorded } = serviceWith({
      availability: {
        practitioner: {
          practitionerId: PRACTITIONER,
          schedulable: true,
          siteIds: [SITE],
        },
        rules: [RULE],
        entries: [anOccupancy()],
      },
    });

    const view = await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: DATE,
      to: DATE,
    });

    // 08:00–12:00 in slots of twenty is twelve; the taken one is subtracted.
    expect(view.slots).toHaveLength(11);
    expect(view.slots.map((slot) => slot.startsAt.toISOString())).not.toContain(
      EIGHT.toISOString(),
    );
    // Nothing is stored: a free slot is a derivation, never a row.
    expect(recorded.booked).toEqual([]);
  });

  it('AG-011 keeps listing an entry booked under a rule that is no longer in force', async () => {
    const { service } = serviceWith({
      availability: {
        practitioner: {
          practitionerId: PRACTITIONER,
          schedulable: true,
          siteIds: [SITE],
        },
        // The rule expired the day before the appointment it produced.
        rules: [{ ...RULE, validTo: parseClinicalDate('2026-09-13') }],
        entries: [anOccupancy()],
      },
    });

    const view = await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: DATE,
      to: DATE,
    });

    expect(view.slots).toEqual([]);
    // The patient will still turn up. Hiding the appointment with the rule
    // would remove it from the screen and from nowhere else.
    expect(view.occupied.map((entry) => entry.id)).toEqual(['entry-1']);
  });

  it('AG-013 offers no slot while the practitioner is not schedulable', async () => {
    const { service } = serviceWith({
      availability: {
        practitioner: {
          practitionerId: PRACTITIONER,
          schedulable: false,
          siteIds: [SITE],
        },
        rules: [RULE],
        entries: [anOccupancy()],
      },
    });

    const view = await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: DATE,
      to: DATE,
    });

    expect(view.slots).toEqual([]);
    expect(view.occupied).toHaveLength(1);
  });

  it('AG-014 offers no slot at a site the practitioner is not linked to', async () => {
    const { service } = serviceWith({
      availability: {
        practitioner: {
          practitionerId: PRACTITIONER,
          schedulable: true,
          siteIds: ['00000000-0000-4000-8000-00000000000f'],
        },
        rules: [RULE],
        entries: [],
      },
    });

    const view = await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: DATE,
      to: DATE,
    });

    expect(view.slots).toEqual([]);
  });

  it('offers no slot for a practitioner the register does not know', async () => {
    // `null` is what the port answers for an identifier that matches nobody.
    // Treating it as "schedulable, linked to every site" would offer slots of
    // somebody who does not exist.
    const { service } = serviceWith({
      availability: { practitioner: null, rules: [RULE], entries: [] },
    });

    const view = await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: DATE,
      to: DATE,
    });

    expect(view.slots).toEqual([]);
    expect(view.occupied).toEqual([]);
  });

  it('AG-072 records no chart access while deriving availability', async () => {
    const { service } = serviceWith();

    await service.availability({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      from: DATE,
      to: DATE,
    });

    expect(Object.keys(service)).not.toContain('audit');
  });
});
