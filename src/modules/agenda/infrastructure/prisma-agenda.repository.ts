import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  isSerialisationFailure,
  withSerialisationRetry,
} from '../../../shared/infrastructure/prisma/serialisation-retry';
import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  BookingRetryExhaustedError,
  InvalidAgendaTransitionError,
} from '../domain/agenda.errors';
import type {
  AgendaEntryView,
  AgendaRepository,
  AgendaServiceType,
  AgendaSite,
  AuthoriserPermissionsQuery,
  BlockingAppointment,
  BlockingAppointmentsQuery,
  SchedulablePractitioner,
  SiteScopeFilter,
  AvailabilityContext,
  AvailabilityContextQuery,
  DailyAgendaQuery,
  DurationSourcesQuery,
  EntryQuery,
  HolidayQuery,
  NewBlock,
  NewBooking,
  NoShowCountRow,
  NoShowCountsQuery,
  OverbookingCountQuery,
  PatientBookingStatus,
  RescheduleOutcome,
  RescheduledBooking,
  ScheduleContext,
  ScheduleContextQuery,
  StatusChange,
  StoredDurationSources,
  StoredSiteParameters,
  TransitionCommand,
  TransitionRead,
} from '../domain/agenda.repository';
import {
  type ClinicalDate,
  WallClockTime,
} from '../../../shared/domain/clinic-time';
import { type Holiday, yearOf } from '../domain/holiday-calendar';
import { checkBookingChannel } from '../domain/booking-policy';
import type {
  AgendaOccupancy,
  ScheduleRule,
} from '../domain/slot-availability';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here: the service above never sees a
 * `Prisma.` type, and it never sees a PostgreSQL error either — the ones that
 * mean something to a user are translated by `database-problem.ts` on the way
 * out, and the transient one is retried here.
 */

/**
 * What a day's list needs, and no clinical content whatsoever (AG-072).
 *
 * NO `reason`, and that is the load-bearing absence. It is free text a
 * receptionist types and it carries the reason for the visit, which is health
 * data: served here it would be read by anyone with `agenda:read` over the
 * site, forty rows at a time, without a single row in `access_audit` — an
 * access to clinical content with no accountable act behind it (AG-072,
 * AG-074, SC-006). Whoever needs it opens the chart, and that route audits.
 * A value that is never loaded cannot leak into a response, a log or a support
 * screenshot, which is the same reason `OCCUPANCY_SELECT` below leaves it out.
 */
const ENTRY_SELECT = {
  id: true,
  kind: true,
  siteId: true,
  practitionerId: true,
  roomId: true,
  patientId: true,
  // The NAME travels with the listing since the calendar redesign: reception
  // operates by name ("señora Andrade, pase"), and a grid of anonymous ids is
  // unusable. The REASON stays out — that is clinical content (AG-072/074);
  // identification is not, and opening the chart remains the audited act.
  patient: { select: { givenName: true, familyName: true } },
  startsAt: true,
  endsAt: true,
  status: true,
  blocksCalendar: true,
  // AG-035, AG-036. The two columns of the deliberate exception. They ARE
  // served — unlike `reason` — because they are administrative: why the grid
  // was broken and who said it could be. That is the whole point of them being
  // separate columns.
  overbookingReason: true,
  overbookingAuthorisedById: true,
  releasedAt: true,
  bookingChannel: true,
  serviceTypeId: true,
  createdById: true,
  // AG-051, the two directions of the reschedule chain. `rescheduledTo` is the
  // partial unique index read backwards, so it costs one indexed lookup and
  // never more than one row — the constraint says so.
  rescheduledFromId: true,
  rescheduledTo: { select: { id: true } },
} satisfies Prisma.AgendaEntrySelect;

/**
 * What availability reads of an entry: WHEN it is taken, and nothing about
 * WHO takes it (AG-074, SC-006).
 *
 * No `patient_id`, no `reason`, no `service_type`: the availability answer is
 * "where are the holes", and a value that is never loaded cannot leak into a
 * response, a log or a support screenshot. Whoever needs to act on an entry
 * lists the day's agenda, which is a different route with its own scope check.
 */
const OCCUPANCY_SELECT = {
  id: true,
  practitionerId: true,
  siteId: true,
  startsAt: true,
  endsAt: true,
  blocksCalendar: true,
  releasedAt: true,
} satisfies Prisma.AgendaEntrySelect;

/**
 * AG-015, AG-092. The holiday and the sites that work it, and nothing else.
 *
 * `workedBy` travels unfiltered — every site that works the holiday, not only
 * the one being asked about — because that is what the domain field claims to
 * be. It is bounded by the number of sites of one clinic, and a list narrowed
 * to the caller's site under a name that promises all of them is the kind of
 * half-truth the next reader builds a bug on.
 */
const HOLIDAY_SELECT = {
  id: true,
  date: true,
  name: true,
  siteId: true,
  workedBy: { select: { siteId: true } },
} satisfies Prisma.HolidaySelect;

/**
 * How many times a booking is attempted before giving up (AG-026).
 *
 * Three, and the receptionist waits at most a few tens of milliseconds for
 * them. A larger budget holds a connection while the person at the desk waits
 * for an answer she can act on either way.
 */
const BOOKING_ATTEMPTS = 3;

@Injectable()
export class PrismaAgendaRepository implements AgendaRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrismaAgendaRepository.name);
  }

  /** AG-107. Names only; the scope narrowing IS the authorisation here. */
  async listSites(scope: SiteScopeFilter): Promise<AgendaSite[]> {
    const rows = await this.prisma.site.findMany({
      where: {
        active: true,
        ...(scope === 'all' ? {} : { id: { in: [...scope] } }),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return rows;
  }

  /**
   * AG-108, AG-111. The join to `user` exists only for the display name:
   * nothing else of the account — email, cedula, MFA state — is selected, so
   * nothing else can leak into the dropdown or a screenshot of it.
   *
   * The join to `specialty` is the same shape and the same discipline: the id,
   * the name and the `is_primary` of the link row, and not one column more.
   * `WHERE specialty.active` is SP-004 — a deactivated specialty is not
   * offered for new appointments — and it filters the CATALOGUE row without
   * touching `practitioner_specialty`, so reactivating it brings the
   * assignment back exactly as it was.
   */
  async listSchedulablePractitioners(
    siteId: string,
  ): Promise<SchedulablePractitioner[]> {
    const rows = await this.prisma.practitioner.findMany({
      where: {
        active: true,
        schedulable: true,
        sites: { some: { siteId } },
      },
      select: {
        id: true,
        userId: true,
        user: { select: { firstName: true, lastName: true } },
        specialties: {
          where: { specialty: { active: true } },
          select: {
            isPrimary: true,
            specialty: { select: { id: true, name: true } },
          },
        },
      },
    });
    return rows
      .map((row) => ({
        id: row.id,
        // For "my agenda": the session knows the USER, the column is the
        // PRACTITIONER, and this is the only place the two ids meet.
        userId: row.userId,
        fullName: `${row.user.firstName} ${row.user.lastName}`.trim(),
        /**
         * PRIMARY FIRST, then by name. The order is the server's because the
         * dialog preselects the primary one (SP-005, SP-008), and a screen
         * that had to re-sort what the server already knows would eventually
         * sort it differently from the next screen.
         */
        specialties: row.specialties
          .map((link) => ({
            id: link.specialty.id,
            name: link.specialty.name,
            isPrimary: link.isPrimary,
          }))
          .sort(
            (a, b) =>
              Number(b.isPrimary) - Number(a.isPrimary) ||
              a.name.localeCompare(b.name, 'es'),
          ),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));
  }

  /**
   * AG-112. The attention types the booking dialog offers, once a specialty is
   * chosen.
   *
   * ACTIVE ONLY, and no existence check on the specialty: an unknown id and a
   * specialty with no active types are the same answer to this question — an
   * empty dropdown — and a 404 here would make the screen distinguish a case
   * it cannot act on either way. The ids it can send come from AG-111.
   */
  async listServiceTypes(specialtyId: string): Promise<AgendaServiceType[]> {
    return this.prisma.serviceType.findMany({
      where: { specialtyId, active: true },
      select: { id: true, name: true, durationMinutes: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * AG-080. The cube: how many appointments of each site · practitioner ·
   * channel · status started inside the window.
   *
   * COUNTED HERE AND DECIDED THERE. There is no status filter in this query
   * and there must not be one: AG-081 says which statuses count, it says it in
   * `summariseNoShow`, and a `WHERE status <> 'CANCELLED'` added here would
   * silently become the real rule while the test that names the requirement
   * kept passing over a cube that no longer contained anything to exclude.
   *
   * THE WINDOW IS ALREADY INSTANTS (AG-001): `starts_at` is `timestamptz` and
   * the two bounds were resolved in Ecuador by the domain, so nothing in this
   * file casts a date and nothing depends on the session's `TimeZone`.
   *
   * `groupBy` AND NOT A `findMany`: what comes back is bounded by the clinic's
   * shape — sites × practitioners × 4 channels × 8 statuses — and not by how
   * many appointments it has taken. A year of them and an afternoon of them
   * cross the wire identically.
   */
  async noShowCounts(
    query: NoShowCountsQuery,
  ): Promise<readonly NoShowCountRow[]> {
    // An empty window is what `noShowWindow` answers for a range entirely in
    // the future (AG-081). Asking anyway would be a round trip for a set the
    // half-open bounds already prove is empty.
    if (query.untilExclusive.getTime() <= query.from.getTime()) return [];

    const cells = await this.prisma.agendaEntry.groupBy({
      by: ['siteId', 'practitionerId', 'bookingChannel', 'status'],
      where: {
        // A block is neither attended nor missed: it has no patient and no
        // channel, so it has no cell here (AG-021, AG-034).
        kind: 'APPOINTMENT',
        startsAt: { gte: query.from, lt: query.untilExclusive },
        ...(query.sites === 'all' ? {} : { siteId: { in: [...query.sites] } }),
      },
      _count: { _all: true },
    });

    // The labels the report is read by, for the ids that actually appeared.
    // Two small lookups rather than a join, because `groupBy` cannot carry a
    // relation — and resolving them on the client would be a second answer
    // that can disagree with the first.
    const [sites, practitioners] = await Promise.all([
      this.prisma.site.findMany({
        where: { id: { in: [...new Set(cells.map((cell) => cell.siteId))] } },
        select: { id: true, name: true },
      }),
      this.prisma.practitioner.findMany({
        where: {
          id: { in: [...new Set(cells.map((cell) => cell.practitionerId))] },
        },
        // The display name and NOTHING else of the account: not the email, not
        // the cedula, exactly like the booking selector (AG-108).
        select: { id: true, user: { select: { firstName: true, lastName: true } } }, // prettier-ignore
      }),
    ]);

    const siteName = new Map(sites.map((site) => [site.id, site.name]));
    const practitionerName = new Map(
      practitioners.map((row) => [
        row.id,
        `${row.user.firstName} ${row.user.lastName}`.trim(),
      ]),
    );

    return cells.map((cell) => ({
      siteId: cell.siteId,
      siteName: siteName.get(cell.siteId) ?? '',
      practitionerId: cell.practitionerId,
      practitionerName: practitionerName.get(cell.practitionerId) ?? '',
      /**
       * `checkBookingChannel` AND NOT A SILENT `filter`, and the difference is
       * the whole reason this line reads like this.
       *
       * `booking_channel` is NOT NULL for an appointment —
       * `agenda_entry_booking_channel_coherence` — so reaching the refusal
       * means that CHECK is gone or the `kind` filter above stopped working.
       * Dropping such a row instead would UNDER-COUNT the metric with no
       * signal anywhere: the clinic would read a rate computed over fewer
       * appointments than it had, and nothing would say so. It also makes the
       * `kind` filter load-bearing rather than a second, untested copy of the
       * same exclusion — a block reaching here now fails loudly, which is what
       * lets a test prove blocks are excluded on purpose.
       */
      bookingChannel: checkBookingChannel(cell.bookingChannel),
      status: cell.status,
      count: cell._count._all,
    }));
  }

  /**
   * AG-017, AG-018.
   *
   * The default path — released entries excluded — is exactly the predicate of
   * the partial index `agenda_entry_daily_agenda … WHERE released_at IS NULL`.
   * Filtering them out in JavaScript afterwards would return the same rows and
   * lose the index, which is what SC-003 is about.
   *
   * The bounds arrive as instants already resolved in Ecuador. NO `::date`
   * anywhere: that cast uses the session's time zone, and at 21:00 it lands on
   * the following day.
   *
   * THE DAY IS A TRUE OVERLAP, `starts_at < until AND ends_at > from`, exactly
   * like the availability query below and for the same reason: a `BLOCK` of a
   * week's leave is ONE row whose `starts_at` is the first day, so asking for
   * the rows that START inside the day loses it on every day but the first.
   * The two routes then contradicted each other over the same date — the
   * availability said the Wednesday was taken and the list recepción reads
   * showed it empty (AG-011, AG-017).
   *
   * The partial index `agenda_entry_daily_agenda … WHERE released_at IS NULL`
   * still serves the default path: `ends_at` is one of its INCLUDEd columns,
   * so the second bound is applied without leaving the index.
   */
  async dailyAgenda(query: DailyAgendaQuery): Promise<AgendaEntryView[]> {
    const rows = await this.prisma.agendaEntry.findMany({
      where: {
        siteId: query.siteId,
        startsAt: { lt: query.untilExclusive },
        endsAt: { gt: query.from },
        ...(query.practitionerId
          ? { practitionerId: query.practitionerId }
          : {}),
        ...(query.roomId ? { roomId: query.roomId } : {}),
        ...(query.includeReleased ? {} : { releasedAt: null }),
      },
      // AG-017. `id` breaks the tie so two entries at the same minute keep a
      // stable order between two requests.
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: ENTRY_SELECT,
    });

    return rows.map(toEntryView);
  }

  /**
   * AG-027. The merge status of a chart, and nothing else.
   *
   * NO NAME AND NO DOCUMENT are selected — not because they would be hard to
   * read, but because a value that is never loaded cannot leak into a log or a
   * response. The agenda has no business knowing who the patient is.
   */
  async findPatientForBooking(
    patientId: string,
  ): Promise<PatientBookingStatus | null> {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, mergedInto: { select: { mrn: true } } },
    });
    if (!row) return null;

    return { id: row.id, mergedIntoMrn: row.mergedInto?.mrn ?? null };
  }

  /**
   * AG-071. Which site a consulting room belongs to, and nothing else about it.
   *
   * The room is a physical resource of ONE site and nothing in `agenda_entry`
   * ties `room_id` to `site_id`, so this is what the application has to ask
   * until a composite foreign key against `site_room(id, site_id)` makes the
   * question unnecessary.
   */
  async roomSiteOf(roomId: string): Promise<string | null> {
    const row = await this.prisma.siteRoom.findUnique({
      where: { id: roomId },
      select: { siteId: true },
    });
    return row?.siteId ?? null;
  }

  /**
   * AG-010, AG-013, AG-014: the rules that could apply that day, plus whether
   * the practitioner takes appointments at all.
   *
   * The weekday and the validity window are filtered HERE so the query returns
   * a handful of rows, but which of them applies is decided by
   * `ruleAppliesOn` in the domain — the same function the availability view
   * uses. Two implementations of "is this rule in force" is how the booking
   * screen and the booking endpoint end up disagreeing.
   */
  async scheduleContextFor(
    query: ScheduleContextQuery,
  ): Promise<ScheduleContext> {
    const day = new Date(`${query.date}T00:00:00Z`);
    const [practitioner, rules] = await Promise.all([
      this.loadPractitioner(query.practitionerId),
      this.loadRules(query.practitionerId, query.siteId, {
        notAfter: day,
        notBefore: day,
      }),
    ]);

    return { practitioner, rules };
  }

  /**
   * SP-023, SP-028. The two STORED rungs of the duration hierarchy.
   *
   * IT READS TWO TABLES THAT BELONG TO OTHER MODULES, and that is the same
   * decision `findPatientForBooking` took for AG-027 and `loadHolidays` for
   * AG-090: no module imports another, so the agenda declares what it needs in
   * its port and its OWN adapter answers it. Importing `specialties` or
   * `staff` for «just one lookup» is what stops modules being modules.
   *
   * IT RESOLVES NOTHING. The ORDER of the rungs is `resolveDuration` in
   * `shared/domain`, where SP-023 is written once and tested without a
   * database. An adapter that returned «the duration» would be a second,
   * silent copy of the hierarchy — and the one that no test names.
   *
   * `active` IS NOT FILTERED. A deactivated type is not offered by the
   * selection listing (SP-007's reasoning), but an appointment that already
   * names one still has to resolve its minutes; refusing here would turn
   * deactivating a type into breaking every screen that shows a booked one.
   */
  async durationSourcesFor(
    query: DurationSourcesQuery,
  ): Promise<StoredDurationSources | null> {
    const [serviceType, exception] = await Promise.all([
      this.prisma.serviceType.findUnique({
        where: { id: query.serviceTypeId },
        select: { durationMinutes: true },
      }),
      this.prisma.durationException.findUnique({
        where: {
          practitionerId_serviceTypeId: {
            practitionerId: query.practitionerId,
            serviceTypeId: query.serviceTypeId,
          },
        },
        select: { durationMinutes: true },
      }),
    ]);
    if (!serviceType) return null;

    return {
      exceptionMinutes: exception?.durationMinutes ?? null,
      serviceTypeMinutes: serviceType.durationMinutes,
    };
  }

  /**
   * AG-094, AG-095. The operating parameters of the site as they are STORED.
   *
   * SEVEN COLUMNS AND NOT THE WHOLE ROW. The three of the overbooking joined
   * on 14-08-2026 with E4, which is the delivery that reads them (D-018).
   * `cancelled_retention` stays out: the listing filter of AG-102 does not
   * exist yet, and a value nobody consumes is a value nobody notices has gone
   * wrong.
   *
   * `null` when the site has no row. A trigger writes one for every site
   * (CF-062), so in a healthy database this never happens — which is exactly
   * why the case is answered honestly instead of assumed away: a restored
   * dump, a data import or a site created before the trigger existed would
   * otherwise book with `undefined` minutes of lead.
   */
  async siteParametersFor(
    siteId: string,
  ): Promise<StoredSiteParameters | null> {
    return this.prisma.siteParameter.findUnique({
      where: { siteId },
      select: {
        minLeadMinutes: true,
        maxLeadDays: true,
        allowPastBooking: true,
        // D-021. The grid, read on the same trip: both availability and
        // booking need it, and it is a site parameter like the other three.
        slotAtomMinutes: true,
        // E4 (AG-039, AG-100, AG-101). Read on the SAME trip as the window,
        // even though only a declared overbooking uses them: they are three
        // columns of a row that is already being fetched by primary key, and a
        // second round trip on the path of an urgency would be paying latency
        // for nothing.
        overbookingEnabled: true,
        overbookingCap: true,
        overbookingPermission: true,
      },
    });
  }

  /**
   * AG-003, AG-010, AG-011, AG-013, AG-014: everything the derivation of a
   * range needs, read in one round trip and subtracted afterwards.
   *
   * THE ENTRIES ARE NOT FILTERED BY THE RULES (AG-011). An appointment booked
   * under a rule that has since expired is still an appointment; joining the
   * two would erase it from the screen and from nowhere else.
   *
   * WHY THE OCCUPANCY IS A TRUE OVERLAP and not `starts_at` inside the window.
   * A `BLOCK` for a week of leave starts before the window and occupies every
   * day of it. Asking only for rows that START inside the range would offer
   * slots on days the practitioner is away — the one mistake this query cannot
   * afford, because the answer is what a receptionist books against.
   *
   * `blocks_calendar = true AND released_at IS NULL` is the predicate of the
   * `EXCLUDE` constraints and of the partial index. It is applied in SQL for
   * the index and re-applied by `occupiesCalendar` in the domain, which is
   * cheap and keeps the meaning of "occupies the calendar" in one place.
   */
  async availabilityContextFor(
    query: AvailabilityContextQuery,
  ): Promise<AvailabilityContext> {
    const [practitioner, rules, entries, holidays, calendarYears] =
      await Promise.all([
        this.loadPractitioner(query.practitionerId),
        this.loadRules(query.practitionerId, query.siteId, {
          // The window of the rule has to touch the window asked for; which
          // dates it actually covers is `ruleAppliesOn` in the domain.
          notAfter: new Date(`${query.toDate}T00:00:00Z`),
          notBefore: new Date(`${query.fromDate}T00:00:00Z`),
        }),
        this.prisma.agendaEntry.findMany({
          where: {
            siteId: query.siteId,
            practitionerId: query.practitionerId,
            blocksCalendar: true,
            releasedAt: null,
            startsAt: { lt: query.untilExclusive },
            endsAt: { gt: query.from },
          },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          select: OCCUPANCY_SELECT,
        }),
        this.loadHolidays(query.siteId, query.fromDate, query.toDate),
        this.loadCalendarYears(query.siteId, query.fromDate, query.toDate),
      ]);

    return {
      practitioner,
      rules,
      // `satisfies` and not a mapping function: the select above IS the domain
      // shape, and this fails to compile the day one of the two moves.
      entries: entries satisfies AgendaOccupancy[],
      holidays,
      calendarYears,
    };
  }

  /**
   * AG-110. The holidays of ONE date, through the very same reader the
   * availability range uses.
   *
   * A RANGE OF ONE DAY AND NOT A SECOND QUERY: `loadHolidays` already narrows
   * to «this site's rows plus the national ones» and already attaches the
   * AG-092 exceptions, and a query written again here would be the second
   * answer to «is that day closed?» that AG-110 exists to prevent.
   *
   * The calendar years are NOT read: AG-093 is about offering slots for a year
   * nobody loaded, and here the appointment is already stored — a doubt about
   * the catalogue changes nothing that can still be decided.
   */
  async holidaysFor(query: HolidayQuery): Promise<readonly Holiday[]> {
    return this.loadHolidays(query.siteId, query.date, query.date);
  }

  /**
   * AG-015, AG-016, AG-090, AG-092: the holidays of the range this site could
   * observe, with the sites that work each of them.
   *
   * NOTHING IS COMPUTED. There is no arithmetic here about Easter or about
   * which Monday a holiday moves to: the rows of `holiday` are the entire
   * calendar (AG-090), because the Executive moves those dates by decree and
   * a formula in code is wrong the year it does, silently.
   *
   * THE SCOPE IS READ, NOT RESOLVED. The `WHERE` narrows to «this site's rows
   * plus the national ones», which is the widest set that can matter and is
   * what the index over `date` can serve; deciding which of them actually
   * closes the site — including the AG-092 exception — is `holiday-calendar.ts`.
   * Resolving it here would be a second copy of AG-091 living in a query, with
   * no test naming it.
   */
  private async loadHolidays(
    siteId: string,
    fromDate: ClinicalDate,
    toDate: ClinicalDate,
  ): Promise<Holiday[]> {
    const rows = await this.prisma.holiday.findMany({
      where: {
        // A CIVIL DAY, NOT AN INSTANT. `date` columns round-trip as UTC
        // midnight, so the bounds are built with an explicit `Z` and read back
        // by slicing the ISO prefix. Letting the host's zone anywhere near
        // this would move «1 de enero» to the 31st of December for everybody
        // west of Greenwich, which is everybody here.
        date: { gte: civilDay(fromDate), lte: civilDay(toDate) },
        OR: [{ siteId }, { siteId: null }],
      },
      select: HOLIDAY_SELECT,
      orderBy: [{ date: 'asc' }, { name: 'asc' }],
    });

    return rows.map(toHoliday);
  }

  /**
   * AG-093: which of the years the range touches have a calendar at all.
   *
   * ONE PROBE PER YEAR, and at most two of them: `MAX_RANGE_DAYS` is 366, so a
   * range spans one year or straddles one New Year. Each probe is an indexed
   * `LIMIT 1` over `holiday_by_date`, which is cheaper than reading the year
   * to count it.
   *
   * THE PROBE IS SITE-SCOPED, like the listing above, and that is the
   * conservative reading on purpose: a year whose only rows belong to another
   * site tells this site nothing about its own calendar, and AG-093 forbids
   * assuming there are no holidays. Warning once too often costs a notice on
   * a screen; staying silent costs an appointment booked on a closed day.
   */
  private async loadCalendarYears(
    siteId: string,
    fromDate: ClinicalDate,
    toDate: ClinicalDate,
  ): Promise<number[]> {
    const years = yearsBetween(fromDate, toDate);

    const probes = await Promise.all(
      years.map((year) =>
        this.prisma.holiday.findFirst({
          where: {
            // `lte` on the 31st of December instead of `lt` on the next New
            // Year: the year after 9999 is not a date any column can hold.
            date: {
              gte: civilDay(`${year}-01-01`),
              lte: civilDay(`${year}-12-31`),
            },
            OR: [{ siteId }, { siteId: null }],
          },
          select: { id: true },
        }),
      ),
    );

    return years.filter((_, index) => probes[index] !== null);
  }

  /**
   * The practitioner as the domain sees them, in ONE place.
   *
   * `scheduleContextFor` and `availabilityContextFor` used to repeat this
   * query and the mapping literally, comment included — so the day "bookable"
   * changes (say, vacations), one copy gets the change and the booking path
   * and the availability screen disagree about who can be booked
   * (maintainability review, finding 5).
   */
  private async loadPractitioner(practitionerId: string) {
    const row = await this.prisma.practitioner.findUnique({
      where: { id: practitionerId },
      select: {
        id: true,
        schedulable: true,
        active: true,
        sites: { select: { siteId: true } },
      },
    });
    if (!row) return null;

    return {
      practitionerId: row.id,
      // An inactive practitioner is unbookable for the same reason as an
      // unschedulable one, and the domain only knows the one flag.
      schedulable: row.schedulable && row.active,
      siteIds: row.sites.map((site) => site.siteId),
    };
  }

  /**
   * The active rules whose validity window touches `[notBefore, notAfter]`.
   *
   * AG-012, AG-028. THE ORDER IS EXPLICIT AND DETERMINISTIC: nothing forbids
   * two rules in force over the same hours, and without an order the row
   * PostgreSQL happens to return first decided whether a booking was accepted
   * — an answer that can change on its own after a `VACUUM`. The order is the
   * one `mostRecentlyInForce` states in the domain, which is where the
   * criterion is written and tested; this is the adapter refusing to hand
   * over an arbitrary sequence in the first place.
   */
  private async loadRules(
    practitionerId: string,
    siteId: string,
    window: { notBefore: Date; notAfter: Date },
  ): Promise<ScheduleRule[]> {
    const rows = await this.prisma.practitionerScheduleRule.findMany({
      where: {
        practitionerId,
        siteId,
        active: true,
        validFrom: { lte: window.notAfter },
        OR: [{ validTo: null }, { validTo: { gte: window.notBefore } }],
      },
      orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toScheduleRule);
  }

  /**
   * AG-020, AG-029, and AG-026 around them.
   *
   * ONE INSERT AND NO PRIOR READ. The three `EXCLUDE USING gist` constraints
   * decide who gets the slot, so this method's job is to let them decide and
   * to survive the one failure that means nothing to the user: a transaction
   * PostgreSQL aborted for serialisation.
   *
   * `40001` is retried because it is not an answer — the transaction was
   * killed before it could produce one. On the retry the winner's row is
   * committed, so the loser now gets the honest `23P01`, which reaches the
   * client as `PRACTITIONER_SLOT_TAKEN`. Without this the same race answers
   * "that slot is taken" or "try again" depending on the millisecond.
   */
  async book(booking: NewBooking): Promise<AgendaEntryView> {
    try {
      const row = await withSerialisationRetry(
        () =>
          this.prisma.agendaEntry.create({
            data: {
              kind: 'APPOINTMENT',
              siteId: booking.siteId,
              practitionerId: booking.practitionerId,
              patientId: booking.patientId,
              roomId: booking.roomId,
              startsAt: booking.startsAt,
              endsAt: booking.endsAt,
              bookingChannel: booking.bookingChannel,
              serviceTypeId: booking.serviceTypeId,
              reason: booking.reason,
              createdById: booking.createdById,
              /**
               * AG-035, AG-036, D-005. The three fields of an overbooking move
               * TOGETHER: `blocks_calendar = false` is what takes the row out
               * of the `EXCLUDE` predicate, and the reason and the authoriser
               * are what stop that from being an exception with no record.
               * `agenda_entry_overbooking_coherence` refuses any other
               * combination, so this is the only place that can compose one.
               */
              ...(booking.overbooking === undefined
                ? {}
                : {
                    blocksCalendar: false,
                    overbookingReason: booking.overbooking.reason,
                    overbookingAuthorisedById:
                      booking.overbooking.authorisedById,
                  }),
            },
            select: ENTRY_SELECT,
          }),
        {
          attempts: BOOKING_ATTEMPTS,
          onRetry: (attempt) =>
            // No interpolation: the logger prunes by allowlist and a template
            // string walks straight past it.
            this.logger.warn(
              { retries: attempt, error_code: 'SERIALISATION_RETRY' },
              'booking retried after a serialisation failure',
            ),
        },
      );

      return toEntryView(row);
    } catch (error) {
      if (!isSerialisationFailure(error)) throw error;

      /**
       * AG-026: at `error` level, because this one IS ours.
       *
       * A slot conflict is the system working and logs at `warn` through the
       * filter. Exhausting the retries means the database could not commit a
       * booking three times running, and nobody finds that out unless it is
       * loud.
       */
      this.logger.error(
        { error_code: 'BOOKING_RETRY_EXHAUSTED', retries: BOOKING_ATTEMPTS },
        'booking abandoned after exhausting serialisation retries',
      );
      throw new BookingRetryExhaustedError(BOOKING_ATTEMPTS);
    }
  }

  /**
   * AG-037. A block of agenda, arbitrated by the very same constraints.
   *
   * THERE IS NO OVERLAP CHECK HERE EITHER, and that is the requirement rather
   * than an omission: the predicate of the three `EXCLUDE USING gist` is
   * `released_at IS NULL AND blocks_calendar` and says nothing about `kind`,
   * so a block competes with appointments and with other blocks exactly as an
   * appointment does — since `20260806022956`, before this method existed. The
   * enumeration AG-038 asks for is a READ the service does first; this write
   * is what makes the guarantee real when that read goes stale.
   *
   * `status: 'BLOCKED'` is the one state AG-046 reserves for blocks. It is set
   * at creation because nothing can move a block afterwards — `assertTransition`
   * refuses every target for `kind = BLOCK`, since all six of them state
   * something about a patient a block does not have.
   *
   * THE REASON GOES INTO `reason` AND IS NOT SERVED BACK. It is the same
   * column the day's listing deliberately never reads (AG-072, AG-074): the
   * line this module draws is by COLUMN and not by row, because a serialiser
   * that decided per row would be one condition away from serving a patient's
   * motive. What a block needs on screen is its interval, and that travels.
   */
  async blockAgenda(block: NewBlock): Promise<AgendaEntryView> {
    try {
      const row = await withSerialisationRetry(
        () =>
          this.prisma.agendaEntry.create({
            data: {
              kind: 'BLOCK',
              status: 'BLOCKED',
              siteId: block.siteId,
              practitionerId: block.practitionerId,
              roomId: block.roomId,
              startsAt: block.startsAt,
              endsAt: block.endsAt,
              reason: block.reason,
              createdById: block.createdById,
            },
            select: ENTRY_SELECT,
          }),
        {
          attempts: BOOKING_ATTEMPTS,
          onRetry: (attempt) =>
            this.logger.warn(
              { retries: attempt, error_code: 'SERIALISATION_RETRY' },
              'block retried after a serialisation failure',
            ),
        },
      );

      return toEntryView(row);
    } catch (error) {
      if (!isSerialisationFailure(error)) throw error;

      this.logger.error(
        { error_code: 'BOOKING_RETRY_EXHAUSTED', retries: BOOKING_ATTEMPTS },
        'block abandoned after exhausting serialisation retries',
      );
      throw new BookingRetryExhaustedError(BOOKING_ATTEMPTS);
    }
  }

  /**
   * AG-100. How many overbookings this practitioner already holds that day.
   *
   * BY THE INSTANT IT STARTS, and not by overlap — which is the opposite
   * choice to the daily agenda two methods above, and deliberate. The cap is
   * about how many exceptions were made ON a date; an overbooking belongs to
   * the date it begins, and matching by overlap would count one appointment
   * against two days when it happens to straddle a midnight nobody works.
   *
   * The bounds are instants the service resolved in `America/Guayaquil`
   * (AG-001). No `::date` cast anywhere: that one uses the session's zone, and
   * a 19:30 overbooking would count against the following day — at which point
   * the cap stops limiting the evenings, which is exactly when it is abused.
   *
   * RELEASED ONES DO NOT COUNT. A cancelled or no-show overbooking gave its
   * exception back; spending a cap on it would refuse a real urgency because
   * of an appointment nobody is attending.
   */
  async overbookingCount(query: OverbookingCountQuery): Promise<number> {
    return this.prisma.agendaEntry.count({
      where: {
        siteId: query.siteId,
        practitionerId: query.practitionerId,
        blocksCalendar: false,
        releasedAt: null,
        startsAt: { gte: query.from, lt: query.untilExclusive },
      },
    });
  }

  /**
   * AG-101. What the NAMED AUTHORISER may do at this site.
   *
   * IT ASKS THE SAME TABLES THE REQUEST GUARD ASKS, and it asks them of
   * SOMEBODY ELSE — which is why it cannot reuse the principal in CLS: that
   * one is whoever is calling, and the whole point of AG-103 is that the two
   * are different people. No module imports another, so the agenda declares
   * the question in its port and answers it here, the same route AG-027 took
   * for the patient's merge state.
   *
   * REVOKED GRANTS AND INACTIVE ROLES ARE FILTERED IN THE QUERY, never
   * afterwards: a filter in application code is one somebody can forget, and
   * the consequence here is a revoked role still authorising exceptions to the
   * strongest guarantee of the module. An INACTIVE ACCOUNT holds nothing
   * either — a doctor who left the clinic cannot be named as the authoriser of
   * today's urgency.
   *
   * `siteId: null` IS A GRANT EVERYWHERE (AU-011). The clinic director is not
   * hired at one site, and dropping those grants here would refuse the very
   * person D-005 names as the third case.
   */
  async authoriserPermissions(
    query: AuthoriserPermissionsQuery,
  ): Promise<readonly string[]> {
    const grants = await this.prisma.userRoleGrant.findMany({
      where: {
        userId: query.userId,
        revokedAt: null,
        user: { active: true },
        role: { active: true },
        OR: [{ siteId: query.siteId }, { siteId: null }],
      },
      select: { role: { select: { permissions: { select: { permissionCode: true } } } } }, // prettier-ignore
    });

    return [
      ...new Set(
        grants.flatMap((grant) =>
          grant.role.permissions.map((held) => held.permissionCode),
        ),
      ),
    ];
  }

  /**
   * AG-038. The appointments standing inside the interval about to be blocked.
   *
   * APPOINTMENTS ONLY (`kind = APPOINTMENT`), because that is what the
   * requirement enumerates. A block that lands on another block is refused by
   * `agenda_entry_no_practitioner_overlap` with its own message; listing it
   * here would answer «hay 1 cita» about a row that is not one.
   *
   * A TRUE OVERLAP, `starts_at < until AND ends_at > from`: an appointment that
   * began before the interval and runs into it is just as much in the way as
   * one that starts inside it.
   *
   * THE SELECT IS THREE COLUMNS. The name AG-109 grants to the day's listing
   * has no business in an error that reaches logs (AG-074, SC-006), and a
   * value that is never loaded cannot leak into one.
   */
  async blockingAppointments(
    query: BlockingAppointmentsQuery,
  ): Promise<readonly BlockingAppointment[]> {
    return this.prisma.agendaEntry.findMany({
      where: {
        siteId: query.siteId,
        practitionerId: query.practitionerId,
        kind: 'APPOINTMENT',
        blocksCalendar: true,
        releasedAt: null,
        startsAt: { lt: query.endsAt },
        endsAt: { gt: query.startsAt },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: { id: true, startsAt: true, endsAt: true },
    });
  }

  /**
   * AG-004, AG-040 to AG-045: one transition, one transaction.
   *
   * READ, DECIDE, WRITE CONDITIONALLY. The read is by id AND site, so an
   * entry of another site answers exactly like a missing one — telling them
   * apart would confirm foreign entries to whoever guesses identifiers. The
   * policy is the `decide` closure the service built; whatever it throws
   * aborts the transaction with nothing written.
   *
   * THE UPDATE DOES NOT TRUST THE READ. Two receptionists resolve the same
   * BOOKED at the same moment; both closures approve. The `updateMany` is
   * conditioned on the status that was read, so the loser matches zero rows,
   * re-reads, and is refused with the status the WINNER left — the honest
   * 409, not a stale acceptance (AG-040 is what closes AG-025's race here).
   *
   * The history row rides in the same transaction (AG-004): a transition
   * that could commit without its history would make `agenda_status_history`
   * a best-effort diary. And this module only ever INSERTS into it (AG-005).
   */
  async transition(
    command: TransitionCommand,
    decide: (entry: TransitionRead) => StatusChange,
  ): Promise<AgendaEntryView> {
    return this.prisma.$transaction(async (tx) => {
      await applyStatusChange(tx, command, decide);

      const entry = await tx.agendaEntry.findUniqueOrThrow({
        where: { id: command.entryId },
        select: ENTRY_SELECT,
      });
      return toEntryView(entry);
    });
  }

  /**
   * AG-071. One entry of one site, or `null` for anything else.
   *
   * A READ AND NOT A LOCK. Rescheduling needs the practitioner and the patient
   * of the appointment in order to judge the new interval before it opens a
   * transaction, and neither column is written by any path of this system. The
   * things that DO move under us — the status, the release, an encounter — are
   * re-read and re-arbitrated inside `reschedule`, so a stale read here can
   * only cost a refusal, never a wrong write.
   */
  async findEntry(query: EntryQuery): Promise<AgendaEntryView | null> {
    const row = await this.prisma.agendaEntry.findFirst({
      where: { id: query.entryId, siteId: query.siteId },
      select: ENTRY_SELECT,
    });
    return row === null ? null : toEntryView(row);
  }

  /**
   * AG-050, AG-051, AG-052. Rescheduling: one transaction, two entries.
   *
   * AG-052 IS THE WHOLE SHAPE OF THIS METHOD. The release of the original and
   * the creation of its replacement are one atomic unit, so a destination slot
   * that is already taken (`23P01`), a patient who is already booked then, or
   * any other rejection the database issues, aborts BOTH: the original comes
   * out of this still occupying the calendar, which is exactly what the
   * requirement demands. There is no ordering of two separate writes that
   * gives that — checking first and then committing is the race AG-025 already
   * taught this module not to run.
   *
   * AG-050: the existing row is never moved. It is annulled and released by
   * `applyStatusChange`, and the new interval belongs to a NEW row that points
   * back at it through `rescheduled_from_id` (AG-051).
   *
   * THE RETRY IS AG-026 APPLIED TO THIS PATH, and it is safe precisely because
   * the transaction is all-or-nothing: a `40001` or a `40P01` killed it before
   * it could decide anything, so re-running re-reads, re-decides and writes
   * once. A constraint rejection is NOT retried — that answer is final and the
   * receptionist can act on it.
   */
  async reschedule(
    command: TransitionCommand,
    booking: RescheduledBooking,
    decide: (entry: TransitionRead) => StatusChange,
  ): Promise<RescheduleOutcome> {
    try {
      return await withSerialisationRetry(
        () =>
          this.prisma.$transaction(async (tx) => {
            await applyStatusChange(tx, command, decide);

            /**
             * WHAT THE NEW ENTRY INHERITS, AND IT IS EXACTLY WHAT NOBODY MAY
             * CHOOSE (AG-115). The patient, the room and the motive of the
             * visit are read from the stored row here, inside the transaction:
             * there is no field for them anywhere above, so a reschedule can
             * never be a way of handing one person's hour to another.
             *
             * `reason` TRAVELS THROUGH HERE AND NOWHERE ELSE. It is the free
             * text where the motive for the visit lands — health data this
             * module never serves back (AG-072, AG-074) — and losing it on a
             * reschedule would quietly empty the field a receptionist typed.
             * It is read inside the transaction, written straight back, and
             * never returned by this method nor logged.
             */
            const source = await tx.agendaEntry.findUniqueOrThrow({
              where: { id: command.entryId },
              select: {
                patientId: true,
                roomId: true,
                reason: true,
              },
            });

            const created = await tx.agendaEntry.create({
              data: {
                kind: 'APPOINTMENT',
                siteId: command.siteId,
                // AG-115. Already resolved by the service: either the one the
                // request named or the original's. Nothing is decided here.
                practitionerId: booking.practitionerId,
                patientId: source.patientId,
                roomId: source.roomId,
                startsAt: booking.startsAt,
                endsAt: booking.endsAt,
                bookingChannel: booking.bookingChannel,
                serviceTypeId: booking.serviceTypeId,
                reason: source.reason,
                // AG-029: whoever moved the appointment is who created this
                // one. The original keeps its own author untouched.
                createdById: command.changedById,
                // AG-051, the stored half of the link. The forward direction
                // is this same column read through
                // `agenda_entry_one_reschedule_per_entry`.
                rescheduledFromId: command.entryId,
              },
              select: ENTRY_SELECT,
            });

            /**
             * READ AFTER THE INSERT, and the order is the requirement: before
             * it, `rescheduledTo` would still be empty and the original would
             * come back claiming to point at nothing (AG-051).
             */
            const original = await tx.agendaEntry.findUniqueOrThrow({
              where: { id: command.entryId },
              select: ENTRY_SELECT,
            });

            return {
              original: toEntryView(original),
              created: toEntryView(created),
            };
          }),
        {
          attempts: BOOKING_ATTEMPTS,
          onRetry: (attempt) =>
            this.logger.warn(
              { retries: attempt, error_code: 'SERIALISATION_RETRY' },
              'reschedule retried after a serialisation failure',
            ),
        },
      );
    } catch (error) {
      if (!isSerialisationFailure(error)) throw error;

      // AG-026, at `error` level like the booking path: a conflict is the
      // system working, three aborted transactions in a row is not.
      this.logger.error(
        { error_code: 'BOOKING_RETRY_EXHAUSTED', retries: BOOKING_ATTEMPTS },
        'reschedule abandoned after exhausting serialisation retries',
      );
      throw new BookingRetryExhaustedError(BOOKING_ATTEMPTS);
    }
  }
}

/**
 * READ, DECIDE, WRITE CONDITIONALLY — the half `transition` and `reschedule`
 * share (AG-004, AG-040 to AG-045).
 *
 * The read is by id AND site, so an entry of another site answers exactly like
 * a missing one — telling them apart would confirm foreign entries to whoever
 * guesses identifiers. The policy is the `decide` closure the service built;
 * whatever it throws aborts the caller's transaction with nothing written.
 *
 * THE UPDATE DOES NOT TRUST THE READ. Two receptionists resolve the same
 * BOOKED at the same moment; both closures approve. The `updateMany` is
 * conditioned on the status that was read, so the loser matches zero rows,
 * re-reads, and is refused with the status the WINNER left — the honest 409,
 * not a stale acceptance (AG-040 is what closes AG-025's race here).
 *
 * The history row rides in the same transaction (AG-004): a change that could
 * commit without its history would make `agenda_status_history` a best-effort
 * diary. And this module only ever INSERTS into it (AG-005).
 *
 * A FUNCTION AND NOT A METHOD: it needs the transaction client and nothing of
 * `this`, and taking `tx` as a parameter is what makes it impossible to call
 * outside one.
 */
async function applyStatusChange(
  tx: Prisma.TransactionClient,
  command: TransitionCommand,
  decide: (entry: TransitionRead) => StatusChange,
): Promise<void> {
  const row = await tx.agendaEntry.findFirst({
    where: { id: command.entryId, siteId: command.siteId },
    select: {
      id: true,
      kind: true,
      status: true,
      startsAt: true,
      releasedAt: true,
      encounter: { select: { id: true } },
    },
  });
  if (!row) throw new AgendaEntryNotFoundError();

  const fromStatus = row.status;
  const change = decide({
    id: row.id,
    kind: row.kind,
    status: fromStatus,
    startsAt: row.startsAt,
    releasedAt: row.releasedAt,
    hasEncounter: row.encounter !== null,
  });

  /**
   * EVERYTHING THE CLOSURE DECIDED ON is re-arbitrated by the WRITE, not
   * only `status` (adversarial review of E2, P1 and P2-1):
   *
   *  - `encounter: { is: null }` when the move releases the slot. The
   *    decide saw no encounter, but one can be committed between our read
   *    and our write, and cancelling an attended appointment is exactly
   *    what AG-045 prohibits. This narrows the window to intra-statement;
   *    the residual gap (encounter created after this UPDATE commits) is
   *    a DOCUMENTED ACCEPTED WINDOW until the encounter module closes it
   *    from its side — see the `Falta esquema` note on AG-045 in SPEC.md.
   *  - `releasedAt: null` when the effects stamp a release. It is what stops
   *    a second reschedule of an entry that was already released from
   *    overwriting the first release instant.
   */
  const releasing = change.effects.releasedAt !== undefined;
  const updated = await tx.agendaEntry.updateMany({
    where: {
      id: command.entryId,
      siteId: command.siteId,
      status: fromStatus,
      ...(releasing ? { releasedAt: null, encounter: { is: null } } : {}),
    },
    data: {
      status: change.to,
      ...change.effects,
      ...(change.cancellationNote === undefined
        ? {}
        : { cancellationNote: change.cancellationNote }),
    },
  });
  if (updated.count === 0) {
    // Somebody else changed what we decided on, between our read and our
    // write. WHICH dimension changed decides the refusal: blaming the
    // status when an encounter appeared would tell the receptionist to
    // retry an action AG-045 forbids.
    const current = await tx.agendaEntry.findUniqueOrThrow({
      where: { id: command.entryId },
      select: { status: true, encounter: { select: { id: true } } },
    });
    if (releasing && current.encounter !== null) {
      throw new AgendaEntryHasEncounterError();
    }
    throw new InvalidAgendaTransitionError(current.status, change.to);
  }

  await tx.agendaStatusHistory.create({
    data: {
      agendaEntryId: command.entryId,
      fromStatus,
      toStatus: change.to,
      changedById: command.changedById,
      note: change.historyNote,
    },
  });
}

/** `YYYY-MM-DD` as the instant PostgreSQL stores for that calendar day. */
function civilDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * The calendar years an inclusive range of clinical dates touches.
 *
 * On the CALENDAR and not in hours: no zone is involved, so this is the year
 * printed on the date and never the one the host's clock would compute.
 */
function yearsBetween(from: ClinicalDate, to: ClinicalDate): number[] {
  const first = yearOf(from);
  const last = yearOf(to);
  if (last < first) return [];
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** A `holiday` row as the domain reads it, exceptions included (AG-092). */
function toHoliday(row: {
  id: string;
  date: Date;
  name: string;
  siteId: string | null;
  workedBy: { siteId: string }[];
}): Holiday {
  return {
    id: row.id,
    // A `date` column round-trips as UTC midnight, so its ISO prefix is a
    // valid calendar date by construction; the cast records that provenance.
    date: row.date.toISOString().slice(0, 10) as ClinicalDate,
    name: row.name,
    siteId: row.siteId,
    workedBySiteIds: row.workedBy.map((exception) => exception.siteId),
  };
}

/** A `practitioner_schedule_rule` row as the domain reads it. */
function toScheduleRule(row: {
  id: string;
  practitionerId: string;
  siteId: string;
  serviceTypeConceptId: string | null;
  weekday: number;
  startTime: Date;
  endTime: Date;
  validFrom: Date;
  validTo: Date | null;
  active: boolean;
}): ScheduleRule {
  return {
    id: row.id,
    practitionerId: row.practitionerId,
    siteId: row.siteId,
    serviceTypeConceptId: row.serviceTypeConceptId,
    weekday: row.weekday,
    // `time` columns arrive as a Date pinned to 1970-01-01 whose UTC parts ARE
    // the wall clock. Local getters would shift the rule by the host offset.
    startTime: WallClockTime.fromTimeColumn(row.startTime),
    endTime: WallClockTime.fromTimeColumn(row.endTime),
    // `date` columns are UTC midnight; the calendar date is their ISO prefix.
    // A `date` column round-trips as UTC midnight, so its ISO prefix is a
    // valid calendar date by construction; the cast records that provenance.
    validFrom: row.validFrom.toISOString().slice(0, 10) as ClinicalDate,
    validTo: row.validTo
      ? (row.validTo.toISOString().slice(0, 10) as ClinicalDate)
      : null,
    active: row.active,
  };
}

function toEntryView(row: {
  id: string;
  kind: string;
  siteId: string;
  practitionerId: string;
  roomId: string | null;
  patientId: string | null;
  patient: { givenName: string; familyName: string } | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  blocksCalendar: boolean;
  releasedAt: Date | null;
  bookingChannel: string | null;
  serviceTypeId: string | null;
  createdById: string | null;
  overbookingReason: string | null;
  overbookingAuthorisedById: string | null;
  rescheduledFromId: string | null;
  rescheduledTo: { id: string }[];
}): AgendaEntryView {
  return {
    // Ecuadorian filing order, same as the register screen: surname first.
    patientName: row.patient
      ? `${row.patient.familyName}, ${row.patient.givenName}`
      : null,
    id: row.id,
    kind: row.kind as AgendaEntryView['kind'],
    siteId: row.siteId,
    practitionerId: row.practitionerId,
    roomId: row.roomId,
    patientId: row.patientId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as AgendaEntryView['status'],
    blocksCalendar: row.blocksCalendar,
    // AG-036: the flag and the WHY travel together, so a client distinguishes
    // an overbooking without asking a second time.
    overbookingReason: row.overbookingReason,
    overbookingAuthorisedById: row.overbookingAuthorisedById,
    releasedAt: row.releasedAt,
    bookingChannel: row.bookingChannel as AgendaEntryView['bookingChannel'],
    serviceTypeId: row.serviceTypeId,
    createdById: row.createdById,
    // AG-051. `agenda_entry_one_reschedule_per_entry` is what makes reading
    // `[0]` honest: a second successor cannot exist, so this is not "the first
    // of several" but "the one, or none".
    rescheduledFromId: row.rescheduledFromId,
    rescheduledToId: row.rescheduledTo[0]?.id ?? null,
  };
}
