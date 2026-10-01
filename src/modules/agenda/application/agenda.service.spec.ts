import { describe, expect, it } from 'vitest';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import { ServiceTypeNotFoundError } from '../../../shared/domain/errors/master-data.errors';
import {
  BookingTooSoonError,
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
  AuthoriserPermissionsQuery,
  BlockingAppointment,
  BlockingAppointmentsQuery,
  NewBlock,
  NoShowCountRow,
  NoShowCountsQuery,
  OverbookingCountQuery,
  PatientSubjectStatus,
  AvailabilityContext,
  AvailabilityContextQuery,
  DailyAgendaQuery,
  DurationSourcesQuery,
  HolidayQuery,
  NewBooking,
  PatientBookingStatus,
  RescheduledBooking,
  ScheduleContext,
  ScheduleContextQuery,
  StatusChange,
  StoredDurationSources,
  StoredSiteParameters,
  SubjectStatusCommand,
  SubjectStatusRead,
  TransitionCommand,
  TransitionRead,
} from '../domain/agenda.repository';
import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  BlockOverlapsAppointmentsError,
  CancellationReasonRequiredError,
  EmergencyAssessmentRequiredError,
  EnteredInErrorReasonRequiredError,
  InvalidAgendaTransitionError,
  NoShowBeforeStartError,
  SubjectStatusNotDerivableError,
  OverbookingLimitReachedError,
  OverbookingNotAllowedError,
  OverbookingNotAuthorisedError,
  OverbookingReasonRequiredError,
  SelfAuthorisationDeniedError,
} from '../domain/agenda.errors';
import type { Holiday } from '../domain/holiday-calendar';
import type {
  AgendaOccupancy,
  ScheduleRule,
} from '../domain/slot-availability';
import type { PresenceEntry } from '../domain/overbooking-policy';
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
const SERVICE_TYPE = '00000000-0000-4000-8000-000000000007';
/** AG-101, AG-103: quien AUTORIZA el sobrecupo, que nunca es `USER`. */
const DOCTOR_USER = '00000000-0000-4000-8000-000000000008';
/** AG-115: the practitioner an appointment can be MOVED TO. */
const OTHER_PRACTITIONER = '00000000-0000-4000-8000-000000000009';
/** AG-115: the type of attention it can be moved to, distinct from the stored one. */
const OTHER_SERVICE_TYPE = '00000000-0000-4000-8000-00000000000a';

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
    patientName: 'Guamán, María',
    startsAt: EIGHT,
    endsAt: EIGHT_TWENTY,
    status: 'BOOKED',
    blocksCalendar: true,
    // AG-035, AG-036: an ordinary appointment carries no exception, and
    // `agenda_entry_overbooking_coherence` guarantees the pairing.
    overbookingReason: null,
    overbookingAuthorisedById: null,
    releasedAt: null,
    // AG-041, AG-118, AG-121, AG-128: an appointment nobody has arrived for
    // has no arrival instant, no patient-axis state and no emergency call.
    checkedInAt: null,
    subjectStatus: null,
    subjectStatusAt: null,
    emergencyAssessedAt: null,
    emergencyFlaggedAt: null,
    bookingChannel: 'PHONE',
    serviceTypeId: null,
    createdById: USER,
    // AG-051: an appointment booked directly and never moved.
    rescheduledFromId: null,
    rescheduledToId: null,
    attention: null,
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
  /** AG-080, AG-081: the scope and the window the metric asked storage for. */
  noShowQueries: NoShowCountsQuery[];
  context: ScheduleContextQuery[];
  availability: AvailabilityContextQuery[];
  rooms: string[];
  /**
   * AG-110: what the booking path asked the calendar, and HOW MANY BOOKINGS
   * had been written by then.
   *
   * The counter is the requirement's «sobre lo que se guardó»: without it the
   * assertion passes just as well when the calendar is read before the insert,
   * because the query is the same either way. Zero means the warning describes
   * an appointment that does not exist yet.
   */
  holidayQueries: (HolidayQuery & { bookedSoFar: number })[];
  /** SP-023: which practitioner·type the proposal asked storage about. */
  durationSources: DurationSourcesQuery[];
  booked: NewBooking[];
  /** AG-037: the blocks written, and AG-038 what was asked before writing. */
  blocked: NewBlock[];
  blockingQueries: BlockingAppointmentsQuery[];
  /** AG-100, AG-101: the two questions an overbooking asks storage. */
  overbookingCounts: OverbookingCountQuery[];
  authoriserQueries: AuthoriserPermissionsQuery[];
  transitions: { command: TransitionCommand; change: StatusChange }[];
  /**
   * AG-122 to AG-127: the derived movements of the PATIENT axis, and the
   * state the policy decided for each documented fact.
   */
  subjectStatusChanges: {
    command: SubjectStatusCommand;
    to: PatientSubjectStatus;
  }[];
  /**
   * AG-052: what the ONE atomic port call was told, and nothing about the
   * order of two calls — because there must not be two. `transitions` and
   * `booked` staying empty during a reschedule is the assertion.
   */
  reschedules: {
    command: TransitionCommand;
    booking: RescheduledBooking;
    change: StatusChange;
  }[];
}

/** The row `transition` hands the service's policy, as the adapter would. */
function aTransitionRead(
  overrides: Partial<TransitionRead> = {},
): TransitionRead {
  return {
    id: 'entry-1',
    kind: 'APPOINTMENT',
    status: 'BOOKED',
    startsAt: EIGHT,
    releasedAt: null,
    hasEncounter: false,
    encounterHasClinicalAct: false,
    encounterInProgress: false,
    ...overrides,
  };
}

/** The row `recordSubjectStatus` hands the policy, as the adapter would. */
function aSubjectStatusRead(
  overrides: Partial<SubjectStatusRead> = {},
): SubjectStatusRead {
  return {
    id: 'entry-1',
    kind: 'APPOINTMENT',
    status: 'CHECKED_IN',
    // AG-127: the check-in effect wrote it, which is what makes the axis
    // movable at all.
    subjectStatus: 'ARRIVED',
    ...overrides,
  };
}

function repositoryDouble(
  overrides: {
    entries?: AgendaEntryView[];
    patient?: PatientBookingStatus | null;
    context?: ScheduleContext;
    /**
     * PARTIAL, so a case that is not about holidays says nothing about them
     * and still gets a context that states what was read of the catalogue —
     * which `AvailabilityContext` requires and AG-093 is the reason for.
     */
    availability?: Partial<AvailabilityContext>;
    roomSiteId?: string | null;
    transitionRead?: TransitionRead;
    /** AG-125, AG-127: the row the patient-axis policy judges. */
    subjectStatusRead?: SubjectStatusRead;
    /** AG-050: the entry a reschedule reads before it decides, or `null`. */
    entry?: AgendaEntryView | null;
    /** AG-094, AG-095: what the site has stored, `null` when it has no row. */
    siteParameters?: StoredSiteParameters | null;
    /** AG-110: the rows of `holiday` the booked date could be closed by. */
    holidays?: Holiday[];
    /**
     * SP-023: what storage knows about the duration, or `null` for a service
     * type that does not exist. `undefined` means nothing was programmed and
     * the double answers as an empty catalogue would.
     */
    durationSources?: StoredDurationSources | null;
    /** AG-101: what the NAMED AUTHORISER holds at the site. */
    authoriserPermissions?: readonly string[];
    /** AG-100: how many overbookings that practitioner already has that day. */
    overbookingCount?: number;
    /** AG-038: the appointments standing inside the interval to be blocked. */
    blockingAppointments?: readonly BlockingAppointment[];
    /** AG-151: where the practitioner is during the interval. */
    presence?: { entries: PresenceEntry[]; rulesElsewhere: ScheduleRule[] };
    /** AG-080: the counted cube the metric reduces. */
    noShowCounts?: readonly NoShowCountRow[];
  } = {},
): { repository: AgendaRepository; recorded: Recorded } {
  const recorded: Recorded = {
    daily: [],
    noShowQueries: [],
    context: [],
    availability: [],
    rooms: [],
    holidayQueries: [],
    durationSources: [],
    booked: [],
    blocked: [],
    blockingQueries: [],
    overbookingCounts: [],
    authoriserQueries: [],
    transitions: [],
    subjectStatusChanges: [],
    reschedules: [],
  };

  const repository: AgendaRepository = {
    // Reference lists are pass-through reads with no policy in the service;
    // their behaviour is proven against the real database in integration.
    listSites: () => Promise.resolve([]),
    listSchedulablePractitioners: () => Promise.resolve([]),
    listServiceTypes: () => Promise.resolve([]),
    noShowCounts: (query) => {
      recorded.noShowQueries.push(query);
      return Promise.resolve(overrides.noShowCounts ?? []);
    },
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
    /**
     * AG-094. The default OPENS THE PAST on purpose, and it is not laziness.
     *
     * Every case in this file pins Monday 14 September 2026 so the weekly rule
     * that applies is deterministic, and a pinned date becomes a date in the
     * past the moment the calendar passes it — at which point AG-031 would
     * refuse forty bookings that are about the channel, the merged chart or
     * the log line. The window rule has tests of its own, pure ones with the
     * clock injected (`booking-policy.spec.ts`) and end-to-end ones against a
     * real database (`agenda-parameters.spec.ts`), so nothing is lost by
     * taking it out of the way here.
     */
    siteParametersFor: () =>
      Promise.resolve(
        overrides.siteParameters === undefined
          ? {
              minLeadMinutes: 0,
              maxLeadDays: 180,
              allowPastBooking: true,
              // D-021: the grid is the site's now. Twenty minutes is what
              // every case here used to read off the rule.
              slotAtomMinutes: 20,
              // E4, D-005: the overbooking is on out of the box, with the cap
              // of D-001 and the permission MEDICO and ADMIN carry.
              overbookingEnabled: true,
              overbookingCap: 2,
              overbookingPermission: 'agenda:overbook',
            }
          : overrides.siteParameters,
      ),
    /**
     * THE DEFAULT ANSWERS ABOUT WHOEVER WAS ASKED, which is what the real
     * adapter does and what AG-115 needs: a double hard-wired to `PRACTITIONER`
     * would refuse every move to another doctor with `OUTSIDE_SCHEDULE_RULE`
     * and hide whether the service asked about the right person at all.
     */
    scheduleContextFor: (query) => {
      recorded.context.push(query);
      return Promise.resolve(
        overrides.context ?? {
          practitioner: {
            practitionerId: query.practitionerId,
            schedulable: true,
            siteIds: [SITE],
          },
          rules: [{ ...RULE, practitionerId: query.practitionerId }],
        },
      );
    },
    durationSourcesFor: (query) => {
      recorded.durationSources.push(query);
      return Promise.resolve(overrides.durationSources ?? null);
    },
    availabilityContextFor: (query) => {
      recorded.availability.push(query);
      return Promise.resolve({
        practitioner: {
          practitionerId: PRACTITIONER,
          schedulable: true,
          siteIds: [SITE],
        },
        rules: [RULE],
        entries: [],
        // AG-015, AG-093. The default is "no holiday, and the year IS loaded":
        // an empty `calendarYears` would make every case that ignores holidays
        // carry the warning of a catalogue nobody filled in.
        holidays: [],
        calendarYears: [2026],
        ...overrides.availability,
      });
    },
    /**
     * AG-110. Recorded as well as answered: WHEN it was asked is half the
     * requirement, and `recorded.booked` being empty at that moment is what
     * proves the warning describes a row that already exists.
     */
    holidaysFor: (query) => {
      recorded.holidayQueries.push({
        ...query,
        bookedSoFar: recorded.booked.length,
      });
      return Promise.resolve(overrides.holidays ?? []);
    },
    book: (booking) => {
      recorded.booked.push(booking);
      return Promise.resolve(
        anEntry({
          bookingChannel: booking.bookingChannel,
          createdById: booking.createdById,
          serviceTypeId: booking.serviceTypeId ?? null,
        }),
      );
    },
    blockAgenda: (block) => {
      recorded.blocked.push(block);
      return Promise.resolve(
        anEntry({
          id: 'block-1',
          kind: 'BLOCK',
          status: 'BLOCKED',
          patientId: null,
          patientName: null,
          bookingChannel: null,
          startsAt: block.startsAt,
          endsAt: block.endsAt,
          createdById: block.createdById,
        }),
      );
    },
    presenceOf: () =>
      Promise.resolve(
        overrides.presence ?? { entries: [], rulesElsewhere: [] },
      ),
    overbookingCount: (query) => {
      recorded.overbookingCounts.push(query);
      return Promise.resolve(overrides.overbookingCount ?? 0);
    },
    authoriserPermissions: (query) => {
      recorded.authoriserQueries.push(query);
      // The default is «this person may authorise»: the cases that are about
      // the reason, the switch or the cap would otherwise all die on AG-101.
      return Promise.resolve(
        overrides.authoriserPermissions ?? ['agenda:overbook'],
      );
    },
    blockingAppointments: (query) => {
      recorded.blockingQueries.push(query);
      return Promise.resolve(overrides.blockingAppointments ?? []);
    },
    // Like the real adapter: reads (here, the programmed row), hands it to
    // the policy, records what the policy decided, answers the updated row.
    // A policy that throws leaves nothing recorded, which is the assertion
    // half these tests make.
    transition: (command, decide) => {
      const read = overrides.transitionRead ?? aTransitionRead();
      const change = decide(read);
      recorded.transitions.push({ command, change });
      return Promise.resolve(
        anEntry({
          // The hour the entry was PROMISED, so AG-118's subtraction has the
          // same two operands the real row would give it.
          startsAt: read.startsAt,
          status: change.to,
          releasedAt: change.effects.releasedAt ?? null,
          // AG-118: the arrival instant the effects stamped, so the service
          // has something to subtract from `startsAt`.
          checkedInAt: change.effects.checkedInAt ?? null,
          subjectStatus: change.effects.subjectStatus ?? null,
          subjectStatusAt: change.effects.subjectStatusAt ?? null,
        }),
      );
    },
    /**
     * AG-122 to AG-127. Like the real adapter: reads, hands the row to the
     * policy, records the state it derived. A policy that throws records
     * nothing, which is what the AG-125 and AG-127 cases assert.
     */
    recordSubjectStatus: (command, decide) => {
      const to = decide(overrides.subjectStatusRead ?? aSubjectStatusRead());
      recorded.subjectStatusChanges.push({ command, to });
      return Promise.resolve(
        anEntry({ subjectStatus: to, subjectStatusAt: command.at }),
      );
    },
    findEntry: (query) =>
      Promise.resolve(
        overrides.entry === undefined
          ? anEntry({ id: query.entryId, siteId: query.siteId })
          : overrides.entry,
      ),
    /**
     * AG-050 to AG-052. The double answers the pair the real adapter answers
     * — original annulled and released, new one pointing back at it — so a
     * caller that expected one entry would not compile.
     */
    reschedule: (command, booking, decide) => {
      const change = decide(overrides.transitionRead ?? aTransitionRead());
      recorded.reschedules.push({ command, booking, change });
      return Promise.resolve({
        original: anEntry({
          id: command.entryId,
          status: change.to,
          releasedAt: change.effects.releasedAt ?? null,
          rescheduledToId: 'entry-2',
        }),
        created: anEntry({
          id: 'entry-2',
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          bookingChannel: booking.bookingChannel,
          createdById: command.changedById,
          rescheduledFromId: command.entryId,
        }),
      });
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

    const { entry } = await service.book(
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

  it('AG-094 judges the booking window with the parameters it read from the site', async () => {
    // The value has to come from the SITE and not from a constant in the
    // service: this one is ten hours, which no default in the code states.
    const { service, recorded } = serviceWith({
      siteParameters: {
        minLeadMinutes: 600,
        maxLeadDays: 180,
        allowPastBooking: false,
      },
    });

    // Relative to the real clock on purpose: the requirement is about the
    // distance to "now", and a pinned instant would stop being close to it.
    const soon = new Date(Date.now() + 5 * 60_000);

    const rejection = await service
      .book({ ...aBooking(), startsAt: soon, endsAt: soon }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BookingTooSoonError);
    expect(recorded.booked).toEqual([]);
  });

  it('AG-095 books on the code defaults when the site has no parameters stored', async () => {
    // With no row the minimum lead is zero, so the window lets this through
    // and the booking is refused further down for a reason that has nothing to
    // do with the window — which is what proves the fallback ran at all.
    const { service } = serviceWith({ siteParameters: null });
    const soon = new Date(Date.now() + 5 * 60_000);

    const rejection = await service
      .book({ ...aBooking(), startsAt: soon, endsAt: soon }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).not.toBeInstanceOf(BookingTooSoonError);
    expect(rejection).toBeInstanceOf(OutsideScheduleRuleError);
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

  /**
   * AG-110. A closed day warns; it never refuses.
   *
   * The date under test is the Monday every case in this file books on, so
   * what changes between them is the catalogue and nothing else.
   */
  const christmasOn = (overrides: Partial<Holiday> = {}): Holiday => ({
    id: 'holiday-1',
    date: DATE,
    name: 'Navidad',
    // `null` is the national scope: every site observes it (AG-091).
    siteId: null,
    workedBySiteIds: [],
    ...overrides,
  });

  it('AG-110 accepts a booking on a closed day and warns with the reason', async () => {
    const { service, recorded } = serviceWith({ holidays: [christmasOn()] });

    const { entry, warnings } = await service.book(aBooking(), REQUESTER);

    // The appointment EXISTS: no refusal, no 4xx, nothing undone.
    expect(recorded.booked).toHaveLength(1);
    expect(entry.id).toBe('entry-1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Navidad');
  });

  it('AG-110 says nothing about a day the calendar does not close', async () => {
    const { service } = serviceWith();

    const { warnings } = await service.book(aBooking(), REQUESTER);

    expect(warnings).toEqual([]);
  });

  it('AG-110 says nothing when the site works that holiday', async () => {
    // AG-092. The exception belongs to the site being booked, and the domain
    // is the one that reads it — the service never resolves the scope.
    const { service } = serviceWith({
      holidays: [christmasOn({ workedBySiteIds: [SITE] })],
    });

    const { warnings } = await service.book(aBooking(), REQUESTER);

    expect(warnings).toEqual([]);
  });

  it('AG-110 asks the calendar about the entry that was stored, after storing it', async () => {
    const { service, recorded } = serviceWith({ holidays: [christmasOn()] });

    await service.book(aBooking(), REQUESTER);

    // The site and the Ecuadorian date of the STORED instant (AG-001) — and
    // `bookedSoFar: 1`, which is the half that matters: read before the
    // insert, the query would look identical and mean the opposite.
    expect(recorded.holidayQueries).toEqual([
      { siteId: SITE, date: DATE, bookedSoFar: 1 },
    ]);
  });

  it('AG-110 does not warn about a booking that was refused', async () => {
    // Nothing was stored, so there is nothing to warn about — and the
    // calendar is not even read: a sentence about an appointment nobody has
    // is worse than silence.
    const { service, recorded } = serviceWith({ holidays: [christmasOn()] });

    await expect(
      service.book({ ...aBooking(), bookingChannel: 'telefono' }, REQUESTER),
    ).rejects.toBeInstanceOf(InvalidBookingChannelError);

    expect(recorded.holidayQueries).toEqual([]);
  });

  it('SP-028 deja el tipo de atención registrado en la cita', async () => {
    const { service, recorded } = serviceWith();

    const { entry } = await service.book(
      { ...aBooking(), serviceTypeId: SERVICE_TYPE },
      REQUESTER,
    );

    expect(recorded.booked[0]?.serviceTypeId).toBe(SERVICE_TYPE);
    expect(entry.serviceTypeId).toBe(SERVICE_TYPE);
  });

  it('SP-028 reserva sin tipo cuando recepción no eligió ninguno', async () => {
    // Not every booking has one: a block, a walk-in squeezed in at the
    // counter. Storing an invented type would report a lie in the statistics.
    const { service, recorded } = serviceWith();

    await service.book(aBooking(), REQUESTER);

    expect(recorded.booked[0]?.serviceTypeId).toBeUndefined();
  });
});

/**
 * SP-028, SP-023. The proposal recepción sees when it picks a specialty and a
 * type, resolved through the hierarchy of D-010.
 *
 * THE ORDER OF THE RUNGS IS TESTED PURELY in
 * `shared/domain/duration-resolution.spec.ts`, which is where the `??` chain
 * lives. What these cases add is the half only the service can wire: WHICH
 * rows feed each rung, that the third one is the rule the agenda resolved, and
 * that a type nobody has is refused rather than silently falling through.
 */
describe('proposing the duration of an appointment', () => {
  const aProposal = (overrides: Record<string, unknown> = {}) => ({
    siteId: SITE,
    practitionerId: PRACTITIONER,
    startsAt: EIGHT,
    ...overrides,
  });

  it('SP-023 la excepción del médico gana a la duración base del tipo', async () => {
    const { service } = serviceWith({
      durationSources: { exceptionMinutes: 40, serviceTypeMinutes: 30 },
    });

    const proposal = await service.proposeDuration(
      aProposal({ serviceTypeId: SERVICE_TYPE }),
    );

    expect(proposal.minutes).toBe(40);
  });

  it('SP-023 sin excepción rige la duración base del especialidad·tipo', async () => {
    const { service } = serviceWith({
      durationSources: { exceptionMinutes: null, serviceTypeMinutes: 30 },
    });

    const proposal = await service.proposeDuration(
      aProposal({ serviceTypeId: SERVICE_TYPE }),
    );

    expect(proposal.minutes).toBe(30);
  });

  it('SP-023 sin tipo elegido rige el turno de la sede', async () => {
    // D-021 moved the third rung from the rule to the site. 20 minutes is
    // what the booking screen books today: the rung is the case, not the
    // omission.
    const { service, recorded } = serviceWith();

    const proposal = await service.proposeDuration(aProposal());

    expect(proposal).toEqual({ minutes: 20 });
    // Storage is not even asked: there is no type to ask about.
    expect(recorded.durationSources).toEqual([]);
  });

  it('SP-023 pregunta por el par profesional·tipo, no por el tipo a secas', async () => {
    // The exception of SP-022 belongs to ONE practitioner: asking without one
    // would hand another doctor's minutes to this booking.
    const { service, recorded } = serviceWith({
      durationSources: { exceptionMinutes: 45, serviceTypeMinutes: 30 },
    });

    await service.proposeDuration(aProposal({ serviceTypeId: SERVICE_TYPE }));

    expect(recorded.durationSources).toEqual([
      { practitionerId: PRACTITIONER, serviceTypeId: SERVICE_TYPE },
    ]);
  });

  it('SP-028 no devuelve ya la rejilla: D-021 hizo imposible el desencaje', async () => {
    // The field carried the grid so the screen could warn «no encaja en los
    // turnos de N min» before the click, back when a base duration of 30 over
    // a 20-minute grid was a configuration the clinic could reach. It cannot
    // be saved any more, so the warning can never fire — and a warning that
    // never fires teaches people to skip the ones that do.
    const { service } = serviceWith({
      durationSources: { exceptionMinutes: null, serviceTypeMinutes: 60 },
    });

    const proposal = await service.proposeDuration(
      aProposal({ serviceTypeId: SERVICE_TYPE }),
    );

    expect(proposal).toEqual({ minutes: 60 });
  });

  it('SP-023 sin regla abierta a esa hora y sin tipo no propone ninguna duración', async () => {
    // 07:00 local, an hour before the rule opens. `null` and not a made-up
    // number: the booking is refused by AG-028 anyway, and a proposal here
    // would be a number nobody can act on.
    const { service } = serviceWith();

    const proposal = await service.proposeDuration(
      aProposal({ startsAt: new Date('2026-09-14T12:00:00Z') }),
    );

    expect(proposal).toEqual({ minutes: null });
  });

  it('SERVICE_TYPE_NOT_FOUND cuando el tipo elegido no existe', async () => {
    // Falling through to the rule's minutes would propose a length for a type
    // nobody has, and recepción would book it without ever being told.
    const { service } = serviceWith({ durationSources: null });

    await expect(
      service.proposeDuration(aProposal({ serviceTypeId: SERVICE_TYPE })),
    ).rejects.toBeInstanceOf(ServiceTypeNotFoundError);
  });
});

/**
 * The status transitions, against the double of the port.
 *
 * WHAT IS NOT TESTED HERE: the atomicity, the conditional update and the
 * history row. Those are the adapter's transaction, and a double that does
 * whatever we programmed cannot prove a transaction exists — they are
 * exercised in `test/integration/agenda-transitions.spec.ts` against a real
 * PostgreSQL. What IS here is the policy the service builds: the table, the
 * no-show clock, the encounter veto, and which effects each target stamps.
 */
describe('transitioning an appointment', () => {
  /**
   * Started long ago: the no-show clock rule cannot interfere.
   *
   * `CONFIRMED` AND NO LONGER `CHECKED_IN`, since AG-116 took
   * `CHECKED_IN → NO_SHOW` out of the table: marking «no vino» on somebody
   * standing in the waiting room is the lie that requirement exists to stop.
   * Its own case is below.
   */
  const STARTED = aTransitionRead({
    status: 'CONFIRMED',
    startsAt: new Date('2026-01-05T13:00:00Z'),
  });

  /** AG-116: arrived, and the patient axis says so (AG-127). */
  const IN_THE_WAITING_ROOM = aTransitionRead({
    status: 'CHECKED_IN',
    startsAt: new Date('2026-01-05T13:00:00Z'),
  });

  const aTransition = (overrides: Record<string, unknown> = {}) => ({
    siteId: SITE,
    entryId: 'entry-1',
    to: 'CONFIRMED' as const,
    ...overrides,
  });

  it('AG-041 stamps the arrival instant when the patient checks in', async () => {
    const { service, recorded } = serviceWith();

    const outcome = await service.transition(
      // AG-128: the article-10 call travels with every arrival, and `false`
      // is the ordinary answer.
      { ...aTransition(), to: 'CHECKED_IN', emergency: false },
      REQUESTER,
    );

    expect(recorded.transitions[0]?.command).toEqual({
      siteId: SITE,
      entryId: 'entry-1',
      changedById: USER,
    });
    const change = recorded.transitions[0]?.change;
    expect(change?.to).toBe('CHECKED_IN');
    expect(change?.effects.checkedInAt).toBeInstanceOf(Date);
    // Arriving occupies the slot MORE, not less: nothing is released.
    expect(change?.effects.releasedAt).toBeUndefined();
    expect(outcome.entry.status).toBe('CHECKED_IN');
  });

  it('AG-042 marks the no-show and releases the slot in one decision', async () => {
    const { service, recorded } = serviceWith({ transitionRead: STARTED });

    await service.transition({ ...aTransition(), to: 'NO_SHOW' }, REQUESTER);

    const change = recorded.transitions[0]?.change;
    expect(change?.effects.noShowAt).toBeInstanceOf(Date);
    expect(change?.effects.releasedAt).toBeInstanceOf(Date);
    // One instant for both stamps: the history must be reconstructible.
    expect(change?.effects.releasedAt).toEqual(change?.effects.noShowAt);
  });

  it('AG-043 refuses a no-show before the appointment starts and writes nothing', async () => {
    const { service, recorded } = serviceWith({
      transitionRead: aTransitionRead({
        startsAt: new Date('2100-01-01T13:00:00Z'),
      }),
    });

    await expect(
      service.transition({ ...aTransition(), to: 'NO_SHOW' }, REQUESTER),
    ).rejects.toBeInstanceOf(NoShowBeforeStartError);

    expect(recorded.transitions).toEqual([]);
  });

  it('AG-044 sends the reason to the cancellation note and to the history', async () => {
    const { service, recorded } = serviceWith();

    await service.transition(
      { ...aTransition(), to: 'CANCELLED', reason: 'Paciente reagenda' },
      REQUESTER,
    );

    const change = recorded.transitions[0]?.change;
    expect(change?.cancellationNote).toBe('Paciente reagenda');
    expect(change?.historyNote).toBe('Paciente reagenda');
    expect(change?.effects.cancelledAt).toBeInstanceOf(Date);
    expect(change?.effects.releasedAt).toBeInstanceOf(Date);
  });

  it('AG-044 refuses a cancellation without a reason even for internal callers', async () => {
    // The DTO already blocks this over HTTP; this pins the rule INSIDE the
    // service, where E3's reschedule will call from (adversarial review P2-3).
    const { service, recorded } = serviceWith();

    await expect(
      service.transition({ ...aTransition(), to: 'CANCELLED' }, REQUESTER),
    ).rejects.toBeInstanceOf(CancellationReasonRequiredError);
    await expect(
      service.transition(
        { ...aTransition(), to: 'CANCELLED', reason: '   ' },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(CancellationReasonRequiredError);
    expect(recorded.transitions).toHaveLength(0);
  });

  it('AG-044 keeps the cancellation note for annulments alone', async () => {
    const { service, recorded } = serviceWith();

    await service.transition(
      { ...aTransition(), to: 'CONFIRMED', reason: 'Confirmó por teléfono' },
      REQUESTER,
    );

    const change = recorded.transitions[0]?.change;
    // The history keeps the caller's words (AG-004); the entry's
    // `cancellation_note` means "why it was annulled" and nothing else.
    expect(change?.cancellationNote).toBeUndefined();
    expect(change?.historyNote).toBe('Confirmó por teléfono');
  });

  it('AG-045 refuses to cancel an appointment that already has an encounter', async () => {
    const { service, recorded } = serviceWith({
      transitionRead: aTransitionRead({ hasEncounter: true }),
    });

    await expect(
      service.transition(
        { ...aTransition(), to: 'CANCELLED', reason: 'x' },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(AgendaEntryHasEncounterError);

    expect(recorded.transitions).toEqual([]);
  });

  it('AG-045 refuses a no-show on an appointment that already has an encounter', async () => {
    const { service } = serviceWith({
      transitionRead: aTransitionRead({
        hasEncounter: true,
        startsAt: new Date('2026-01-05T13:00:00Z'),
      }),
    });

    await expect(
      service.transition({ ...aTransition(), to: 'NO_SHOW' }, REQUESTER),
    ).rejects.toBeInstanceOf(AgendaEntryHasEncounterError);
  });

  it('AG-045 still lets an encountered appointment move forward', async () => {
    // The veto is on denying the attention, not on the appointment moving:
    // confirming or fulfilling contradicts nothing the record says.
    const { service, recorded } = serviceWith({
      transitionRead: aTransitionRead({ hasEncounter: true }),
    });

    await service.transition(aTransition(), REQUESTER);

    expect(recorded.transitions[0]?.change.to).toBe('CONFIRMED');
  });

  it('AG-040 refuses a pair outside the table with the current state', async () => {
    const { service, recorded } = serviceWith({
      transitionRead: aTransitionRead({ status: 'FULFILLED' }),
    });

    const rejection = await service
      .transition({ ...aTransition(), to: 'CANCELLED', reason: 'x' }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(InvalidAgendaTransitionError);
    expect((rejection as InvalidAgendaTransitionError).params).toEqual({
      from: 'FULFILLED',
      to: 'CANCELLED',
    });
    expect(recorded.transitions).toEqual([]);
  });

  it('AG-046 refuses appointment transitions on a BLOCK', async () => {
    const { service } = serviceWith({
      transitionRead: aTransitionRead({ kind: 'BLOCK', status: 'BLOCKED' }),
    });

    await expect(
      service.transition(
        { ...aTransition(), to: 'CHECKED_IN', emergency: false },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(InvalidAgendaTransitionError);
  });

  it('AG-074 logs the change without patient, practitioner or reason', async () => {
    const { service, lines } = serviceWith();

    await service.transition(
      { ...aTransition(), to: 'CANCELLED', reason: 'Motivo con dato de salud' },
      REQUESTER,
    );

    const logged = JSON.stringify(lines);
    expect(logged).toContain('AGENDA_STATUS_CHANGED');
    expect(logged).toContain('CANCELLED');
    expect(logged).not.toContain('Motivo con dato de salud');
    expect(logged).not.toContain(PATIENT);
    expect(logged).not.toContain(PRACTITIONER);
  });

  /* ─── E8: los dos desenlaces nuevos ─────────────────────────────────── */

  it('AG-116 releases the slot and takes the patient off the board when they leave without being seen', async () => {
    const { service, recorded } = serviceWith({
      transitionRead: IN_THE_WAITING_ROOM,
    });

    await service.transition(
      { ...aTransition(), to: 'LEFT_WITHOUT_BEING_SEEN' },
      REQUESTER,
    );

    const change = recorded.transitions[0]?.change;
    // The hour is empty in fact, so it goes back — the reasoning of AG-042.
    expect(change?.effects.releasedAt).toBeInstanceOf(Date);
    // AG-127: whoever left never passes the cashier, so nothing of AG-125
    // would ever fire for them. Without this they stay on the board forever.
    expect(change?.effects.subjectStatus).toBe('DEPARTED');
    expect(change?.effects.subjectStatusAt).toEqual(change?.effects.releasedAt);
    // NOT an absence: nothing of the no-show path is stamped.
    expect(change?.effects.noShowAt).toBeUndefined();
    expect(change?.effects.cancelledAt).toBeUndefined();
  });

  it('AG-116 admits leaving without being seen with NO reason at all', async () => {
    // OPTIONAL ON PURPOSE, the opposite of AG-044: whoever walked out does not
    // always say why — that is precisely the case — and a mandatory box nobody
    // can fill truthfully gets filled with anything. Who marked it and when is
    // the history row (AG-004).
    const { service, recorded } = serviceWith({
      transitionRead: IN_THE_WAITING_ROOM,
    });

    await service.transition(
      { ...aTransition(), to: 'LEFT_WITHOUT_BEING_SEEN' },
      REQUESTER,
    );

    expect(recorded.transitions).toHaveLength(1);
    expect(recorded.transitions[0]?.change.historyNote).toBeUndefined();
  });

  it('AG-116 refuses LEFT_WITHOUT_BEING_SEEN from any state other than CHECKED_IN', async () => {
    // «Se fue sin ser atendido» presupposes arriving. Reachable from BOOKED it
    // would be a second synonym for NO_SHOW, and which one got used would
    // depend on who was typing.
    for (const status of ['BOOKED', 'CONFIRMED', 'IN_PROGRESS'] as const) {
      const { service, recorded } = serviceWith({
        transitionRead: aTransitionRead({ status }),
      });

      await expect(
        service.transition(
          { ...aTransition(), to: 'LEFT_WITHOUT_BEING_SEEN' },
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(InvalidAgendaTransitionError);
      expect(recorded.transitions).toEqual([]);
    }
  });

  it('AG-116 no longer admits NO_SHOW on somebody who checked in', async () => {
    // THE REMOVAL IS THE REQUIREMENT: marking «no vino» on a person standing
    // in the waiting room writes a false fact into an append-only history and
    // poisons the numerator of AG-080.
    const { service, recorded } = serviceWith({
      transitionRead: IN_THE_WAITING_ROOM,
    });

    const rejection = await service
      .transition({ ...aTransition(), to: 'NO_SHOW' }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(InvalidAgendaTransitionError);
    expect((rejection as InvalidAgendaTransitionError).params).toEqual({
      from: 'CHECKED_IN',
      to: 'NO_SHOW',
    });
    expect(recorded.transitions).toEqual([]);
  });

  it('AG-117 requires a reason to retract an entry, even for internal callers', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.transition({ ...aTransition(), to: 'ENTERED_IN_ERROR' }, REQUESTER), // prettier-ignore
    ).rejects.toBeInstanceOf(EnteredInErrorReasonRequiredError);
    await expect(
      service.transition(
        { ...aTransition(), to: 'ENTERED_IN_ERROR', reason: '   ' },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(EnteredInErrorReasonRequiredError);
    expect(recorded.transitions).toHaveLength(0);
  });

  it('AG-117 releases the slot and keeps the reason out of the cancellation note', async () => {
    const { service, recorded } = serviceWith();

    await service.transition(
      { ...aTransition(), to: 'ENTERED_IN_ERROR', reason: 'Cédula equivocada' },
      REQUESTER,
    );

    const change = recorded.transitions[0]?.change;
    expect(change?.effects.releasedAt).toBeInstanceOf(Date);
    // NOT `cancellation_note`: one column for both acts would make it
    // unprovable from the row which of the two happened, which is exactly what
    // this status came to separate.
    expect(change?.cancellationNote).toBeUndefined();
    expect(change?.effects.cancelledAt).toBeUndefined();
    // The trail is the append-only history row (AG-004, AG-005).
    expect(change?.historyNote).toBe('Cédula equivocada');
  });

  it('AG-117 refuses ENTERED_IN_ERROR once the appointment reached CHECKED_IN', async () => {
    // Once the patient is there the appointment stopped being only a record:
    // there is a person in the room. It is the boundary AG-045 draws with the
    // encounter — what already touched somebody is not erased.
    for (const status of ['CHECKED_IN', 'IN_PROGRESS', 'FULFILLED'] as const) {
      const { service, recorded } = serviceWith({
        transitionRead: aTransitionRead({ status }),
      });

      await expect(
        service.transition(
          { ...aTransition(), to: 'ENTERED_IN_ERROR', reason: 'Error' },
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(InvalidAgendaTransitionError);
      expect(recorded.transitions).toEqual([]);
    }
  });

  /* ─── E8: la llegada ────────────────────────────────────────────────── */

  it('AG-118 answers the arrival delay computed from the row, with its sign', async () => {
    const { service } = serviceWith({ transitionRead: STARTED });

    const outcome = await service.transition(
      { ...aTransition(), to: 'CHECKED_IN', emergency: false },
      REQUESTER,
    );

    // Promised on 5 January 2026 and arrived just now: the delay is a large
    // POSITIVE number, and — the point — it is a number and not a status.
    // `CHECKED_IN` stays true at the same time, which is exactly why a
    // `LATE_ARRIVAL` state would put the machine in two places at once.
    expect(outcome.arrivalDelayMinutes).toBeGreaterThan(0);
    expect(outcome.entry.status).toBe('CHECKED_IN');
  });

  it('AG-118 keeps the sign when the patient arrives EARLY', async () => {
    // Truncating at zero would turn «llegó veinte minutos antes» into «llegó
    // a la hora», which is a different and false statement — and it is useful
    // at the counter and in the median of AG-141.
    const { service } = serviceWith({
      transitionRead: aTransitionRead({
        startsAt: new Date('2100-01-01T13:00:00Z'),
      }),
    });

    const outcome = await service.transition(
      { ...aTransition(), to: 'CHECKED_IN', emergency: false },
      REQUESTER,
    );

    expect(outcome.arrivalDelayMinutes).toBeLessThan(0);
  });

  it('AG-119 warns about a late arrival and records it anyway', async () => {
    const { service } = serviceWith({
      transitionRead: STARTED,
      // AG-142: the site's threshold, through the chain of AG-095.
      siteParameters: { lateArrivalGraceMinutes: 15 },
    });

    const outcome = await service.transition(
      { ...aTransition(), to: 'CHECKED_IN', emergency: false },
      REQUESTER,
    );

    // WARNED, NOT REFUSED: the arrival is the moment Ley 77 art. 10 obliges
    // the emergency call to be made, so a check-in that can be rejected is a
    // check-in that some day does not happen.
    expect(outcome.entry.status).toBe('CHECKED_IN');
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain('15');
  });

  it('AG-119 says nothing when the arrival is inside the site threshold', async () => {
    const { service } = serviceWith({
      transitionRead: STARTED,
      // A threshold nothing can exceed: the warning is about the number, not
      // about the transition having happened.
      siteParameters: { lateArrivalGraceMinutes: 10_000_000 },
    });

    const outcome = await service.transition(
      { ...aTransition(), to: 'CHECKED_IN', emergency: false },
      REQUESTER,
    );

    expect(outcome.warnings).toEqual([]);
  });

  it('AG-119 warns on no transition other than the arrival', async () => {
    const { service } = serviceWith();

    const outcome = await service.transition(aTransition(), REQUESTER);

    expect(outcome.warnings).toEqual([]);
  });

  /* ─── E8: la calificación del art. 10 ───────────────────────────────── */

  it('AG-128 refuses an arrival with no emergency assessment, and writes nothing', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.transition({ ...aTransition(), to: 'CHECKED_IN' }, REQUESTER),
    ).rejects.toBeInstanceOf(EmergencyAssessmentRequiredError);

    expect(recorded.transitions).toEqual([]);
  });

  it('AG-128 records the assessment itself on a NEGATIVE call, and no flag', async () => {
    // THE HALF THE LAW ACTUALLY NEEDS. With only the flag, NULL cannot tell
    // «se calificó y no era una emergencia» from «nadie calificó nada», and it
    // is the second that art. 13 turns into a prison sentence.
    const { service, recorded } = serviceWith();

    await service.transition(
      { ...aTransition(), to: 'CHECKED_IN', emergency: false },
      REQUESTER,
    );

    const effects = recorded.transitions[0]?.change.effects;
    expect(effects?.emergencyAssessedAt).toBeInstanceOf(Date);
    expect(effects?.emergencyAssessedById).toBe(USER);
    expect(effects?.emergencyFlaggedAt).toBeUndefined();
    expect(effects?.emergencyFlaggedById).toBeUndefined();
  });

  it('AG-128 records the assessment AND the flag on an affirmative call', async () => {
    const { service, recorded } = serviceWith();

    await service.transition(
      {
        ...aTransition(),
        to: 'CHECKED_IN',
        emergency: true,
        emergencyNote: 'Dolor torácico',
      },
      REQUESTER,
    );

    const effects = recorded.transitions[0]?.change.effects;
    // `agenda_entry_emergency_flag_follows_assessment` refuses a flag with no
    // assessment behind it: the outcome presupposes the act.
    expect(effects?.emergencyAssessedAt).toBeInstanceOf(Date);
    expect(effects?.emergencyFlaggedAt).toEqual(effects?.emergencyAssessedAt);
    expect(effects?.emergencyFlaggedById).toBe(USER);
    expect(effects?.emergencyNote).toBe('Dolor torácico');
  });

  it('AG-128 asks for the call on the arrival and on no other transition', async () => {
    const { service, recorded } = serviceWith();

    await service.transition(aTransition(), REQUESTER);

    const effects = recorded.transitions[0]?.change.effects;
    expect(effects?.emergencyAssessedAt).toBeUndefined();
  });

  it('AG-130 demands no permission beyond the one that registers the arrival', async () => {
    // THE THIRD «no» IS WHAT MAKES ART. 10 ENFORCEABLE: a permission of its
    // own would mean receptionists who cannot make the call, and then the
    // article goes unmet on the days that person is at the counter. The
    // service asks storage for nothing about the caller's grants.
    const { service, recorded } = serviceWith();

    await service.transition(
      { ...aTransition(), to: 'CHECKED_IN', emergency: true },
      REQUESTER,
    );

    expect(recorded.authoriserQueries).toEqual([]);
  });

  it('AG-131 registers the arrival with coverage skipped and its reason, and demands no payment', async () => {
    // Ley 77 art. 9 forbids demanding a cheque, a card or any document of
    // payment as a condition of being received and stabilised. The reason is
    // what tells a datum that is MISSING from one the clinic decided not to
    // demand.
    const { service, recorded } = serviceWith();

    const outcome = await service.transition(
      {
        ...aTransition(),
        to: 'CHECKED_IN',
        emergency: false,
        coverageCheckSkippedReason: 'Paciente sin documentos, se estabiliza',
      },
      REQUESTER,
    );

    expect(outcome.entry.status).toBe('CHECKED_IN');
    expect(
      recorded.transitions[0]?.change.effects.coverageCheckSkippedReason,
    ).toBe('Paciente sin documentos, se estabiliza');
  });

  it('AG-131 does not condition IN_PROGRESS on any payment having been registered', async () => {
    const { service, recorded } = serviceWith({
      transitionRead: IN_THE_WAITING_ROOM,
    });

    await service.transition(
      { ...aTransition(), to: 'IN_PROGRESS' },
      REQUESTER,
    );

    expect(recorded.transitions[0]?.change.to).toBe('IN_PROGRESS');
  });
});

/**
 * AG-121 to AG-127. The PATIENT axis, which no route may type.
 *
 * WHAT THIS FILE CAN PROVE and what it cannot. The rules — not before the
 * arrival, not after the departure, never on a block, and the fact-to-state
 * mapping — are decided here against the double. That NO ROUTE EXISTS is
 * proved in `test/integration/agenda-subject-status.spec.ts`, which walks the
 * routes NestJS actually registered (AG-070's machine), because the absence of
 * something cannot be asserted against a double of it.
 */
describe('deriving the patient subject status', () => {
  const aSubjectStatus = (overrides: Record<string, unknown> = {}) => ({
    siteId: SITE,
    entryId: 'entry-1',
    fact: 'CLINICAL_NOTE_OPENED' as const,
    ...overrides,
  });

  it('AG-122 derives each state from the documented fact that produces it', async () => {
    const expected = [
      ['VITALS_STARTED', 'IN_PREPARATION'],
      ['VITALS_RECORDED', 'READY'],
      ['CLINICAL_NOTE_OPENED', 'RECEIVING_CARE'],
      ['TEMPORARY_LEAVE_RECORDED', 'ON_LEAVE'],
      ['ACCOUNT_CLOSED', 'DEPARTED'],
    ] as const;

    for (const [fact, status] of expected) {
      const { service, recorded } = serviceWith();

      const entry = await service.recordSubjectStatus(
        aSubjectStatus({ fact }),
        REQUESTER,
      );

      expect(recorded.subjectStatusChanges[0]?.to).toBe(status);
      expect(recorded.subjectStatusChanges[0]?.command.fact).toBe(fact);
      expect(entry.subjectStatus).toBe(status);
    }
  });

  it('AG-124 puts the patient ON_LEAVE without closing anything', async () => {
    // The real case is the outside laboratory and the imaging place across the
    // street: the patient goes and comes back, and their attention stays open.
    const { service, recorded } = serviceWith();

    await service.recordSubjectStatus(
      aSubjectStatus({ fact: 'TEMPORARY_LEAVE_RECORDED' }),
      REQUESTER,
    );

    expect(recorded.subjectStatusChanges[0]?.to).toBe('ON_LEAVE');
    // The APPOINTMENT axis is untouched: the two are not derived from each
    // other (AG-121), and this port writes only the patient's.
    expect(recorded.transitions).toEqual([]);
  });

  it('AG-125 admits no further movement once the patient departed', async () => {
    const { service, recorded } = serviceWith({
      subjectStatusRead: aSubjectStatusRead({ subjectStatus: 'DEPARTED' }),
    });

    await expect(
      service.recordSubjectStatus(aSubjectStatus(), REQUESTER),
    ).rejects.toBeInstanceOf(SubjectStatusNotDerivableError);
    expect(recorded.subjectStatusChanges).toEqual([]);
  });

  it('AG-127 refuses a subject status before the appointment reached CHECKED_IN', async () => {
    // The patient axis only exists INSIDE an arrival. A BOOKED appointment has
    // nobody anywhere, and putting somebody on the board who has not come is
    // the class of lie AG-122 exists to prevent.
    const { service, recorded } = serviceWith({
      subjectStatusRead: aSubjectStatusRead({
        status: 'BOOKED',
        subjectStatus: null,
      }),
    });

    await expect(
      service.recordSubjectStatus(aSubjectStatus(), REQUESTER),
    ).rejects.toBeInstanceOf(SubjectStatusNotDerivableError);
    expect(recorded.subjectStatusChanges).toEqual([]);
  });

  it('AG-021 refuses a subject status on a block', async () => {
    // A theatre is not in pre-consultation. The database refuses it too
    // (`agenda_entry_subject_status_needs_a_patient`); this refuses it with a
    // sentence instead of a constraint name.
    const { service } = serviceWith({
      subjectStatusRead: aSubjectStatusRead({
        kind: 'BLOCK',
        status: 'BLOCKED',
        subjectStatus: null,
      }),
    });

    await expect(
      service.recordSubjectStatus(aSubjectStatus(), REQUESTER),
    ).rejects.toBeInstanceOf(SubjectStatusNotDerivableError);
  });

  it('AG-074 logs the fact and the derived state, never the patient', async () => {
    const { service, lines } = serviceWith();

    await service.recordSubjectStatus(aSubjectStatus(), REQUESTER);

    const logged = JSON.stringify(lines);
    expect(logged).toContain('AGENDA_SUBJECT_STATUS_CHANGED');
    expect(logged).toContain('RECEIVING_CARE');
    expect(logged).not.toContain(PATIENT);
  });
});

/**
 * Rescheduling, at the layer that decides HOW it is done.
 *
 * WHAT ONLY THIS FILE CAN PROVE, and it is the whole reason AG-052 is
 * satisfiable at all: that the service does NOT compose the operation out of
 * an annulment followed by a booking. Whether the transaction really rolls
 * back is PostgreSQL's answer and lives in
 * `test/integration/agenda-reschedule.spec.ts`; whether there is a single
 * atomic call for it to roll back is decided here, and a double is exactly the
 * right instrument for it.
 */
const aReschedule = (overrides: Record<string, unknown> = {}) => ({
  siteId: SITE,
  entryId: 'entry-1',
  startsAt: new Date('2026-09-14T14:00:00Z'),
  endsAt: new Date('2026-09-14T14:20:00Z'),
  bookingChannel: 'PHONE',
  reason: 'Paciente pide otra hora',
  ...overrides,
});

describe('rescheduling an appointment', () => {
  it('AG-052 moves the appointment through ONE atomic port call, never an annulment plus a booking', async () => {
    const { service, recorded } = serviceWith();

    await service.reschedule(aReschedule(), REQUESTER);

    // The assertion that matters is the pair of empties: composing the
    // operation out of these two is what leaves a patient with no appointment
    // the first time the destination slot is taken.
    expect(recorded.transitions).toEqual([]);
    expect(recorded.booked).toEqual([]);
    expect(recorded.reschedules).toHaveLength(1);
    expect(recorded.reschedules[0]?.command).toEqual({
      siteId: SITE,
      entryId: 'entry-1',
      changedById: USER,
    });
  });

  it('AG-050 hands the port the new interval and a decision that only releases the old row', async () => {
    const { service, recorded } = serviceWith();

    const moved = await service.reschedule(aReschedule(), REQUESTER);

    const [only] = recorded.reschedules;
    expect(only?.booking).toEqual({
      startsAt: new Date('2026-09-14T14:00:00Z'),
      endsAt: new Date('2026-09-14T14:20:00Z'),
      bookingChannel: 'PHONE',
      // AG-115: asked for by nobody here, so they are the stored row's.
      practitionerId: PRACTITIONER,
      serviceTypeId: null,
    });
    // What the ORIGINAL row is told to become: annulled and released, with no
    // key that could carry an interval (AG-050's «no mover la fila existente»).
    expect(only?.change.to).toBe('CANCELLED');
    expect(Object.keys(only?.change.effects ?? {}).sort()).toEqual([
      'cancelledAt',
      'releasedAt',
    ]);
    expect(moved.original.releasedAt).toBeInstanceOf(Date);
  });

  it('AG-051 answers with both entries naming each other', async () => {
    const { service } = serviceWith();

    const moved = await service.reschedule(aReschedule(), REQUESTER);

    expect(moved.original.rescheduledToId).toBe(moved.created.id);
    expect(moved.created.rescheduledFromId).toBe(moved.original.id);
  });

  it('AG-115 hands the port the practitioner and the type the request asked for', async () => {
    const { service, recorded } = serviceWith({
      entry: anEntry({ serviceTypeId: SERVICE_TYPE }),
    });

    await service.reschedule(
      aReschedule({
        practitionerId: OTHER_PRACTITIONER,
        serviceTypeId: OTHER_SERVICE_TYPE,
      }),
      REQUESTER,
    );

    // The two fields of a row that is being BORN, so choosing them is not a
    // mutation of the appointment that already exists (AG-050).
    expect(recorded.reschedules[0]?.booking).toMatchObject({
      practitionerId: OTHER_PRACTITIONER,
      serviceTypeId: OTHER_SERVICE_TYPE,
    });
  });

  it('AG-115 keeps the practitioner and the type of the original when the request names neither', async () => {
    const { service, recorded } = serviceWith({
      entry: anEntry({ serviceTypeId: SERVICE_TYPE }),
    });

    await service.reschedule(aReschedule(), REQUESTER);

    // The behaviour that existed before AG-115 and that AG-115 must not break:
    // both fields are optional, and absent means «the one it already had».
    expect(recorded.reschedules[0]?.booking).toMatchObject({
      practitionerId: PRACTITIONER,
      serviceTypeId: SERVICE_TYPE,
    });
  });

  it('AG-115 judges the new interval against the schedule of the NEW practitioner', async () => {
    const { service, recorded } = serviceWith();

    await service.reschedule(
      aReschedule({ practitionerId: OTHER_PRACTITIONER }),
      REQUESTER,
    );

    // «Las mismas comprobaciones que una reserva» is worth nothing if they are
    // run against the doctor being LEFT: the grid, the bookable flag and the
    // site link (AG-028, AG-013) all belong to the one who will attend.
    expect(recorded.context.at(-1)?.practitionerId).toBe(OTHER_PRACTITIONER);
  });

  it('AG-044 refuses a reschedule with no reason before it reads anything', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.reschedule(aReschedule({ reason: '  ' }), REQUESTER),
    ).rejects.toBeInstanceOf(CancellationReasonRequiredError);
    expect(recorded.reschedules).toEqual([]);
    // Not even the schedule was read: a refusal that costs a round trip is a
    // worse refusal.
    expect(recorded.context).toEqual([]);
  });

  it('AG-071 answers a missing entry and a foreign one the same way', async () => {
    const { service, recorded } = serviceWith({ entry: null });

    await expect(
      service.reschedule(aReschedule(), REQUESTER),
    ).rejects.toBeInstanceOf(AgendaEntryNotFoundError);
    expect(recorded.reschedules).toEqual([]);
  });

  it('AG-034 refuses an unknown booking channel before touching the entry', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.reschedule(
        aReschedule({ bookingChannel: 'telefono' }),
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(InvalidBookingChannelError);
    expect(recorded.reschedules).toEqual([]);
  });

  it('AG-040 refuses to reschedule an appointment that is already terminal', async () => {
    const { service, recorded } = serviceWith({
      entry: anEntry({ status: 'CANCELLED', releasedAt: EIGHT }),
    });

    await expect(
      service.reschedule(aReschedule(), REQUESTER),
    ).rejects.toBeInstanceOf(InvalidAgendaTransitionError);
    expect(recorded.reschedules).toEqual([]);
  });

  it('AG-104 judges the NEW interval with the same rules a fresh booking gets', async () => {
    const { service, recorded } = serviceWith();

    // 14:10Z is 09:10 in Guayaquil: inside the rule, off the twenty-minute
    // grid. A reschedule that skipped these checks would place an appointment
    // the booking route refuses to create.
    await expect(
      service.reschedule(
        aReschedule({
          startsAt: new Date('2026-09-14T14:10:00Z'),
          endsAt: new Date('2026-09-14T14:30:00Z'),
        }),
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(SlotNotAlignedError);
    expect(recorded.reschedules).toEqual([]);
  });

  it('AG-027 refuses moving an appointment whose chart was merged away', async () => {
    const { service, recorded } = serviceWith({
      patient: { id: PATIENT, mergedIntoMrn: 'HC-000042' },
    });

    await expect(
      service.reschedule(aReschedule(), REQUESTER),
    ).rejects.toBeInstanceOf(PatientMergedError);
    expect(recorded.reschedules).toEqual([]);
  });

  it('AG-110 warns about the day the appointment LANDED on, read after it exists', async () => {
    const { service } = serviceWith({
      holidays: [
        {
          id: 'holiday-1',
          date: parseClinicalDate('2026-09-14'),
          name: 'Fiesta local',
          siteId: SITE,
          workedBySiteIds: [],
        },
      ],
    });

    const moved = await service.reschedule(aReschedule(), REQUESTER);

    expect(moved.warnings.join(' ')).toContain('Fiesta local');
  });

  it('AG-074 logs the site and the fact, never the patient or the reason', async () => {
    const { service, lines } = serviceWith();

    await service.reschedule(
      aReschedule({ reason: 'Motivo con dato de salud' }),
      REQUESTER,
    );

    const logged = JSON.stringify(lines);
    expect(logged).toContain('AGENDA_ENTRY_RESCHEDULED');
    expect(logged).not.toContain('Motivo con dato de salud');
    expect(logged).not.toContain(PATIENT);
    expect(logged).not.toContain(PRACTITIONER);
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

describe('las listas de referencia', () => {
  // Pass-throughs a propósito: la política es el ALCANCE que llega como
  // argumento (AG-107) y la consulta filtrada del adaptador (AG-108), probada
  // contra PostgreSQL real en agenda-http.spec.ts. Aquí solo se clava que el
  // servicio no altera ni el filtro ni el resultado por el camino.
  it('AG-107 entrega al repositorio exactamente el alcance recibido', async () => {
    const scopes: unknown[] = [];
    const { service } = serviceWith();
    const spied = new AgendaService(
      {
        ...repositoryDouble().repository,
        listSites: (scope) => {
          scopes.push(scope);
          return Promise.resolve([{ id: 'site-1', name: 'Sede Norte' }]);
        },
      },
      loggerDouble().logger,
    );

    await expect(spied.sitesFor(['site-1'])).resolves.toEqual([
      { id: 'site-1', name: 'Sede Norte' },
    ]);
    await spied.sitesFor('all');
    expect(scopes).toEqual([['site-1'], 'all']);
    expect(service).toBeDefined();
  });

  it('AG-108 delega la sede sin transformarla', async () => {
    const asked: string[] = [];
    const spied = new AgendaService(
      {
        ...repositoryDouble().repository,
        listSchedulablePractitioners: (siteId) => {
          asked.push(siteId);
          return Promise.resolve([
            {
              id: 'p-1',
              userId: 'u-1',
              fullName: 'Ana Villacís',
              specialties: [],
            },
          ]);
        },
      },
      loggerDouble().logger,
    );

    await expect(spied.schedulablePractitioners('site-9')).resolves.toEqual([
      { id: 'p-1', userId: 'u-1', fullName: 'Ana Villacís', specialties: [] },
    ]);
    expect(asked).toEqual(['site-9']);
  });

  it('AG-112 pide los tipos por especialidad y no por sede', async () => {
    // La sede de la ruta AUTORIZA (AG-071) y no filtra: un `service_type` es
    // de la clínica. Si algún día llegara hasta el repositorio sería porque
    // alguien creyó que acota, y acotar por ella daría listas distintas en
    // dos sedes para el mismo catálogo.
    const asked: unknown[] = [];
    const spied = new AgendaService(
      {
        ...repositoryDouble().repository,
        listServiceTypes: (...args) => {
          asked.push(args);
          return Promise.resolve([
            { id: 'st-1', name: 'Control', durationMinutes: 20 },
          ]);
        },
      },
      loggerDouble().logger,
    );

    await expect(spied.serviceTypesOf('sp-1')).resolves.toEqual([
      { id: 'st-1', name: 'Control', durationMinutes: 20 },
    ]);
    expect(asked).toEqual([['sp-1']]);
  });
});

/**
 * E4 — el sobrecupo y el bloqueo, contra dobles del puerto.
 *
 * LO QUE NO SE PRUEBA AQUÍ, y es la mitad importante: que la base cuente los
 * sobrecupos del día correcto, que el `EXCLUDE` arbitre el bloqueo y que
 * `agenda_entry_overbooking_coherence` impida un sobrecupo sin constancia. Un
 * doble que devuelve lo que le pedimos no demuestra ninguna de las tres:
 * viven en `test/integration/agenda-overbooking.spec.ts` contra PostgreSQL de
 * verdad. Aquí está lo que decide el servicio: qué comprueba, en qué orden, y
 * que no escribe nada cuando rechaza.
 */
describe('AG-035 el sobrecupo', () => {
  const OVERBOOKING = {
    overbooking: { reason: '  Urgencia dental  ', authorisedById: DOCTOR_USER },
  };

  it('AG-035 escribe el sobrecupo con su motivo y su autorizador', async () => {
    const { service, recorded } = serviceWith();

    await service.book({ ...aBooking(), ...OVERBOOKING }, REQUESTER);

    expect(recorded.booked[0]).toMatchObject({
      // AG-029: quien reserva sigue siendo quien reserva…
      createdById: USER,
      // …y quien autoriza es otro. Ésa es la separación entera (AG-103).
      overbooking: {
        authorisedById: DOCTOR_USER,
        // Recortado: lo que se comprobó es lo que se guarda, y la base rechaza
        // un motivo en blanco.
        reason: 'Urgencia dental',
      },
    });
  });

  it('AG-036 devuelve el indicador y el motivo del sobrecupo en la respuesta', async () => {
    // Sin esto el listado no puede distinguirlo «sin consultar otra vez», que
    // es literalmente lo que pide el requisito.
    const { service } = serviceWith({
      entries: [
        anEntry({
          blocksCalendar: false,
          overbookingReason: 'Urgencia dental',
          overbookingAuthorisedById: DOCTOR_USER,
        }),
      ],
    });

    const [entry] = await service.dailyAgenda({ siteId: SITE, date: DATE });

    expect(entry).toMatchObject({
      blocksCalendar: false,
      overbookingReason: 'Urgencia dental',
    });
  });

  it('AG-035 rechaza el sobrecupo sin motivo y no escribe nada', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.book(
        {
          ...aBooking(),
          overbooking: { reason: '   ', authorisedById: DOCTOR_USER },
        },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(OverbookingReasonRequiredError);

    expect(recorded.booked).toEqual([]);
  });

  it('AG-028, AG-104 admite el intervalo fuera de la rejilla cuando se declara sobrecupo', async () => {
    // Es la contrapartida de D-007: meter a alguien a las 08:10 sigue siendo
    // posible por la vía que exige motivo y deja constancia.
    const { service, recorded } = serviceWith();
    const eightTen = new Date('2026-09-14T13:10:00Z');
    const eightThirty = new Date('2026-09-14T13:30:00Z');

    await service.book(
      {
        ...aBooking(),
        startsAt: eightTen,
        endsAt: eightThirty,
        ...OVERBOOKING,
      },
      REQUESTER,
    );

    expect(recorded.booked).toHaveLength(1);
  });

  it('AG-039 rechaza el sobrecupo en una sede que no lo admite, sin preguntar nada más', async () => {
    // Y el orden importa: comprobar el motivo o el autorizador antes que el
    // interruptor mandaría a recepción a rellenar un formulario para una
    // excepción que esta sede no hace.
    const { service, recorded } = serviceWith({
      siteParameters: {
        minLeadMinutes: 0,
        maxLeadDays: 180,
        allowPastBooking: true,
        slotAtomMinutes: 20,
        overbookingEnabled: false,
      },
    });

    await expect(
      service.book(
        { ...aBooking(), overbooking: { authorisedById: DOCTOR_USER } },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(OverbookingNotAllowedError);

    expect(recorded.booked).toEqual([]);
    expect(recorded.authoriserQueries).toEqual([]);
    expect(recorded.overbookingCounts).toEqual([]);
  });

  it('AG-103 rechaza que quien reserva se autorice a sí mismo, y no crea la entrada', async () => {
    const { service, recorded } = serviceWith();

    await expect(
      service.book(
        {
          ...aBooking(),
          overbooking: { reason: 'Urgencia', authorisedById: USER },
        },
        REQUESTER,
      ),
    ).rejects.toBeInstanceOf(SelfAuthorisationDeniedError);

    expect(recorded.booked).toEqual([]);
  });

  it('AG-101 pregunta por los permisos del AUTORIZADOR en ESA sede, no por los de quien reserva', async () => {
    // Si preguntara por quien reserva, la separación de personas sería
    // decorado: recepción nombraría a un médico y la comprobación miraría sus
    // propios permisos, que ya incluyen `agenda:write`.
    const { service, recorded } = serviceWith();

    await service.book({ ...aBooking(), ...OVERBOOKING }, REQUESTER);

    expect(recorded.authoriserQueries).toEqual([
      { userId: DOCTOR_USER, siteId: SITE },
    ]);
  });

  it('AG-101 rechaza al autorizador sin el permiso que la sede exige, y no crea la entrada', async () => {
    const { service, recorded } = serviceWith({
      authoriserPermissions: ['agenda:read', 'agenda:write'],
    });

    await expect(
      service.book({ ...aBooking(), ...OVERBOOKING }, REQUESTER),
    ).rejects.toBeInstanceOf(OverbookingNotAuthorisedError);

    expect(recorded.booked).toEqual([]);
  });

  it('AG-100 cuenta el tope del día en America/Guayaquil y no en UTC', async () => {
    /**
     * EL BORDE QUE IMPORTA. Un sobrecupo de las 19:30 en Ecuador es
     * `2026-09-15T00:30:00Z`: contado en UTC caería en el día siguiente, y el
     * tope dejaría de limitar las tardes, que es justo cuando se abusa de él.
     */
    const halfSevenPM = new Date('2026-09-15T00:30:00Z');
    const { service, recorded } = serviceWith();

    await service.book(
      {
        ...aBooking(),
        startsAt: halfSevenPM,
        endsAt: new Date('2026-09-15T00:50:00Z'),
        ...OVERBOOKING,
      },
      REQUESTER,
    );

    expect(recorded.overbookingCounts[0]).toMatchObject({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      // El 14 de septiembre en Ecuador, no el 15 en UTC.
      from: new Date('2026-09-14T05:00:00Z'),
      untilExclusive: new Date('2026-09-15T05:00:00Z'),
    });
  });

  it('AG-100 rechaza el sobrecupo que pasaría del tope de la sede, indicándolo', async () => {
    const { service, recorded } = serviceWith({ overbookingCount: 2 });

    const rejection = await service
      .book({ ...aBooking(), ...OVERBOOKING }, REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(OverbookingLimitReachedError);
    expect((rejection as OverbookingLimitReachedError).params).toEqual({
      cap: 2,
    });
    expect(recorded.booked).toEqual([]);
  });
});

describe('AG-037 el bloqueo de agenda', () => {
  const aBlock = (overrides: Record<string, unknown> = {}) => ({
    siteId: SITE,
    practitionerId: PRACTITIONER,
    startsAt: EIGHT,
    endsAt: EIGHT_TWENTY,
    ...overrides,
  });

  it('AG-037 crea el bloqueo sin paciente y sin canal', async () => {
    const { service, recorded } = serviceWith();

    const entry = await service.blockAgenda(
      aBlock({ reason: 'Quirófano' }),
      REQUESTER,
    );

    expect(recorded.blocked[0]).toMatchObject({
      siteId: SITE,
      practitionerId: PRACTITIONER,
      reason: 'Quirófano',
      createdById: USER,
    });
    expect(entry.kind).toBe('BLOCK');
    expect(entry.patientId).toBeNull();
  });

  it('AG-038 rechaza el bloqueo enumerando las citas que lo impiden', async () => {
    const { service, recorded } = serviceWith({
      blockingAppointments: [
        { id: 'entry-a', startsAt: EIGHT, endsAt: EIGHT_TWENTY },
        {
          id: 'entry-b',
          startsAt: new Date('2026-09-14T13:40:00Z'),
          endsAt: new Date('2026-09-14T14:00:00Z'),
        },
      ],
    });

    const rejection = await service
      .blockAgenda(aBlock(), REQUESTER)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BlockOverlapsAppointmentsError);
    const problem = rejection as BlockOverlapsAppointmentsError;
    // ENUMERARLAS es la mitad útil: sin la lista hay que buscarlas a mano.
    expect(problem.params).toMatchObject({
      blockingCount: 2,
      blockingEntryIds: 'entry-a,entry-b',
    });
    // Y las horas, en hora de pared ecuatoriana (AG-001).
    expect(problem.fieldErrors?.[0]?.message).toContain('08:00');
    expect(problem.fieldErrors?.[0]?.message).toContain('08:40');
    // AG-038: rechazado, no escrito.
    expect(recorded.blocked).toEqual([]);
  });

  it('AG-072, AG-074 no nombra al paciente de ninguna de esas citas', async () => {
    // SC-006. El mensaje llega al registro y a una captura de soporte; AG-109
    // concede el nombre al LISTADO del día, que es otra ruta con su permiso.
    const { service } = serviceWith({
      blockingAppointments: [
        { id: 'entry-a', startsAt: EIGHT, endsAt: EIGHT_TWENTY },
      ],
    });

    const rejection = (await service
      .blockAgenda(aBlock(), REQUESTER)
      .catch((error: unknown) => error)) as BlockOverlapsAppointmentsError;

    const served = JSON.stringify({
      message: rejection.message,
      params: rejection.params,
      fieldErrors: rejection.fieldErrors,
      userTitle: rejection.userTitle,
    });
    expect(served).not.toContain('Guamán');
    expect(served).not.toContain(PATIENT);
  });

  it('AG-105 rechaza el bloqueo de un consultorio de otra sede', async () => {
    const { service, recorded } = serviceWith({ roomSiteId: OTHER_SITE });

    await expect(
      service.blockAgenda(aBlock({ roomId: ROOM }), REQUESTER),
    ).rejects.toBeInstanceOf(RoomNotInSiteError);

    expect(recorded.blocked).toEqual([]);
  });
});

describe('AG-080 la tasa de inasistencia', () => {
  const cell = (overrides: Partial<NoShowCountRow> = {}): NoShowCountRow => ({
    siteId: SITE,
    siteName: 'Sede Norte',
    practitionerId: PRACTITIONER,
    practitionerName: 'Ana Vera',
    bookingChannel: 'PHONE',
    status: 'FULFILLED',
    count: 1,
    ...overrides,
  });

  it('AG-071 entrega al repositorio exactamente el alcance recibido, no una sede pedida', async () => {
    // Lo único que separa a recepción de Norte de las cifras de Sur: la ruta
    // declara `'query'`, así que el guard no puede estrecharla y esto sí.
    const { service, recorded } = serviceWith();

    await service.noShowRate({
      sites: [SITE],
      from: parseClinicalDate('2026-09-01'),
      to: parseClinicalDate('2026-09-30'),
    });

    expect(recorded.noShowQueries).toHaveLength(1);
    expect(recorded.noShowQueries[0]?.sites).toEqual([SITE]);
  });

  it('AG-001 pide la ventana en instantes ecuatorianos y no fechas sueltas', async () => {
    const { service, recorded } = serviceWith();

    await service.noShowRate({
      sites: 'all',
      from: parseClinicalDate('2026-09-01'),
      to: parseClinicalDate('2026-09-29'),
    });

    // 00:00 del 1 y 00:00 del 30, en Ecuador. El adaptador nunca ve una fecha,
    // así que no hay `::date` que pueda resolverse con el huso de la sesión.
    expect(recorded.noShowQueries[0]?.from.toISOString()).toBe(
      '2026-09-01T05:00:00.000Z',
    );
  });

  it('AG-081 cierra la ventana en el instante actual y lo dice en la respuesta', async () => {
    const { service, recorded } = serviceWith();
    const before = Date.now();

    // Un rango que llega hasta 2027: nada de eso ha podido faltar todavía.
    const report = await service.noShowRate({
      sites: 'all',
      from: parseClinicalDate('2026-01-01'),
      to: parseClinicalDate('2026-12-31'),
    });

    const countedUntil = report.countedUntil.getTime();
    expect(countedUntil).toBeGreaterThanOrEqual(before);
    expect(countedUntil).toBeLessThanOrEqual(Date.now());
    // Y es EL MISMO instante que se le pidió a la base: una segunda lectura
    // del reloj dejaría la cifra y su etiqueta describiendo periodos distintos.
    expect(recorded.noShowQueries[0]?.untilExclusive.getTime()).toBe(
      countedUntil,
    );
  });

  it('AG-080 reduce el cubo del repositorio sin recontarlo por su cuenta', async () => {
    const { service } = serviceWith({
      noShowCounts: [
        cell({ status: 'NO_SHOW', count: 2 }),
        cell({ status: 'FULFILLED', count: 8 }),
        // AG-081: la base las devuelve y el dominio las descarta.
        cell({ status: 'CANCELLED', count: 5 }),
      ],
    });

    const report = await service.noShowRate({
      sites: 'all',
      from: parseClinicalDate('2026-09-01'),
      to: parseClinicalDate('2026-09-30'),
    });

    expect(report.overall).toMatchObject({ noShow: 2, total: 10, rate: 0.2 });
    expect(report.bySite).toHaveLength(1);
    expect(report.byChannel).toHaveLength(1);
  });
});
