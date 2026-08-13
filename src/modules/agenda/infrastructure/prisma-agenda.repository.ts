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
  AgendaSite,
  SchedulablePractitioner,
  SiteScopeFilter,
  AvailabilityContext,
  AvailabilityContextQuery,
  DailyAgendaQuery,
  NewBooking,
  PatientBookingStatus,
  ScheduleContext,
  ScheduleContextQuery,
  StatusChange,
  TransitionCommand,
  TransitionRead,
} from '../domain/agenda.repository';
import {
  type ClinicalDate,
  WallClockTime,
} from '../../../shared/domain/clinic-time';
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
  releasedAt: true,
  bookingChannel: true,
  serviceTypeConceptId: true,
  createdById: true,
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
   * AG-108. The join to `user` exists only for the display name: nothing else
   * of the account — email, cedula, MFA state — is selected, so nothing else
   * can leak into the dropdown or a screenshot of it.
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
      },
    });
    return rows
      .map((row) => ({
        id: row.id,
        // For "my agenda": the session knows the USER, the column is the
        // PRACTITIONER, and this is the only place the two ids meet.
        userId: row.userId,
        fullName: `${row.user.firstName} ${row.user.lastName}`.trim(),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));
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
    const [practitioner, rules, entries] = await Promise.all([
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
    ]);

    return {
      practitioner,
      rules,
      // `satisfies` and not a mapping function: the select above IS the domain
      // shape, and this fails to compile the day one of the two moves.
      entries: entries satisfies AgendaOccupancy[],
    };
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
              serviceTypeConceptId: booking.serviceTypeConceptId,
              reason: booking.reason,
              createdById: booking.createdById,
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
       *  - `releasedAt: null` when the effects stamp a release. Unreachable
       *    today (only terminal states release, and terminals admit nothing),
       *    but E3's "liberar el cupo original" will create released rows in
       *    non-terminal states, and without this guard a stale transition
       *    would overwrite the release instant.
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

      const entry = await tx.agendaEntry.findUniqueOrThrow({
        where: { id: command.entryId },
        select: ENTRY_SELECT,
      });
      return toEntryView(entry);
    });
  }
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
  slotMinutes: number;
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
    slotMinutes: row.slotMinutes,
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
  serviceTypeConceptId: string | null;
  createdById: string | null;
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
    releasedAt: row.releasedAt,
    bookingChannel: row.bookingChannel as AgendaEntryView['bookingChannel'],
    serviceTypeConceptId: row.serviceTypeConceptId,
    createdById: row.createdById,
  };
}
