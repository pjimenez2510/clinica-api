import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  chartScopeRows,
  chartScopeSelect,
} from '../../../shared/infrastructure/prisma/patient-chart-scope';
import {
  WaitlistAcceptanceRequiredError,
  WaitlistEntryClosedError,
  WaitlistPatientMismatchError,
  WaitlistSlotAlreadyClaimedError,
} from '../domain/agenda.errors';
import { OPEN_WAITLIST_STATUSES, type WaitlistCandidate } from '../domain/waitlist'; // prettier-ignore
import type {
  NewContactAttempt,
  NewWaitlistEntry,
  StoredWaitlistParameters,
  WaitlistConversion,
  WaitlistEntryQuery,
  WaitlistEntryView,
  WaitlistRepository,
} from '../domain/waitlist.repository';

/**
 * Rows in, domain shapes out — the waiting list half (E5, AG-060 to AG-067).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BASE COUNTS, THE DOMAIN DECIDES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing here filters by preferred date, orders by priority or compares a
 * count against the site's cap. Every one of those is a requirement — AG-061,
 * AG-062, AG-065, AG-066 — and each is decided in `waitlist.ts`, where a unit
 * test names it and where D-040 can change one without a migration. What this
 * file brings back are FACTS: which entries are open, between which dates,
 * fixing what, called how many times, and the birth date and priority periods
 * of the chart behind each.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO TRIGGERS ARRIVE BY SQLSTATE AND NOT BY NAME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `trg_waitlist_entry_conversion_consented` and
 * `trg_waitlist_entry_closure_final` raise `check_violation` from PL/pgSQL, so
 * PostgreSQL emits no «violates check constraint "…"» clause and
 * `database-problem.ts` — which only reads a constraint NAME — can offer
 * nothing better than a generic `CHECK_FAILED`. Three refusals with three
 * different things to do about them would arrive as one.
 *
 * So they are told apart HERE, by the sentence each raises, exactly as
 * `patients` does with the three refusals of `trg_patient_merge_not_chained`
 * (`mergeRefusalOf`). ⚠️ THIS IS NOT A SECOND COPY OF THE RULE: the rule is
 * the trigger, and it still refuses an import and a `psql`. What this decides
 * is only what the rejection MEANS to whoever is at the desk.
 */

/**
 * ⚠️ NO `groupCode` IN THIS SELECT, AND IT IS HALF THE GUARANTEE.
 *
 * The level depends on WHETHER a period is in force and never on WHICH one, so
 * the motive is not needed to compute it. Leaving it out of the query means
 * «el motivo no viaja en ningún listado» stops being a rule somebody has to
 * remember while mapping a response: the datum never leaves the database
 * (PA-042, AG-073). It is why E5 works with `patient:read`.
 */
const PRIORITY_PERIOD_SELECT = {
  select: { startsOn: true, endsOn: true },
} satisfies Prisma.Patient$priorityGroupsArgs;

/**
 * What a candidate decision needs from the chart, and nothing else.
 *
 * PA-055. THE PERIODS OF THIS CHART **AND OF THE ONES IT ABSORBED**. A
 * pregnancy recorded on a duplicate stopped counting the moment the merge went
 * through, and the waiting list called her like anybody else — the defect
 * `chartScopeSelect` exists to close. `relationJoins` is on, so it travels as
 * a `LEFT JOIN LATERAL` inside the same statement, resolved by the partial
 * index `patient_absorbed_charts`.
 *
 * `mergedIntoId` is the other half: a chart that was itself merged away cannot
 * take the slot (AG-027, and `trg_waitlist_entry_conversion_consented` demands
 * the appointment be of the same chart), and the domain drops it.
 */
const CANDIDATE_PATIENT_SELECT = {
  select: {
    birthDate: true,
    mergedIntoId: true,
    ...chartScopeSelect('priorityGroups', PRIORITY_PERIOD_SELECT),
  },
} satisfies Prisma.PatientDefaultArgs;

/**
 * AG-064, AG-066. The count and the last instant, DERIVED.
 *
 * The two columns that used to say this were dropped by
 * `agenda_waitlist_contact_trail`: two statements of one fact can only drift,
 * and the cached one is the one that can be short — an attempt recorded
 * without incrementing the counter, in the direction that harms the patient
 * who WAS called. Both come off `waitlist_contact_attempt_by_entry`, the one
 * index that table needs.
 */
const CONTACT_TRAIL_SELECT = {
  _count: { select: { contactAttempts: true } },
  contactAttempts: {
    select: { attemptedAt: true },
    orderBy: { attemptedAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.WaitlistEntrySelect;

const ENTRY_SELECT = {
  id: true,
  siteId: true,
  patientId: true,
  practitionerId: true,
  serviceTypeId: true,
  preferredFrom: true,
  preferredTo: true,
  status: true,
  convertedEntryId: true,
  createdAt: true,
  ...CONTACT_TRAIL_SELECT,
} satisfies Prisma.WaitlistEntrySelect;

const CANDIDATE_SELECT = {
  ...ENTRY_SELECT,
  patient: CANDIDATE_PATIENT_SELECT,
} satisfies Prisma.WaitlistEntrySelect;

/**
 * The waiting list's port over PostgreSQL. Closed entries stay closed because
 * `trg_waitlist_entry_closure_final` refuses to reopen them, not because this
 * class remembers to check.
 */
@Injectable()
export class PrismaWaitlistRepository implements WaitlistRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** AG-060. A plain insert: no check that the range has no free slot, see the port. */
  async enrolInWaitlist(entry: NewWaitlistEntry): Promise<WaitlistEntryView> {
    const row = await this.prisma.waitlistEntry.create({
      data: {
        siteId: entry.siteId,
        patientId: entry.patientId,
        practitionerId: entry.practitionerId,
        serviceTypeId: entry.serviceTypeId,
        // `@db.Date` columns: the calendar day, with no instant to shift. A
        // `new Date('2026-09-01')` is midnight UTC and PostgreSQL stores the
        // date part, which is the same day in every session zone.
        preferredFrom: civilDay(entry.preferredFrom),
        preferredTo: civilDay(entry.preferredTo),
      },
      select: ENTRY_SELECT,
    });
    return toEntryView(row);
  }

  async waitlistParametersFor(
    siteId: string,
  ): Promise<StoredWaitlistParameters | null> {
    const row = await this.prisma.siteParameter.findUnique({
      where: { siteId },
      select: { waitlistMaxContactAttempts: true },
    });
    // AG-095: what is STORED, resolved nowhere. Filling the gap is
    // `resolveWaitlistParameters` in the domain, where one test names the fall-
    // back; defaulting here would be a second, silent copy of the same chain.
    return row === null ? null : { maxContactAttempts: row.waitlistMaxContactAttempts }; // prettier-ignore
  }

  /**
   * AG-061, AG-067. The OPEN entries of one site.
   *
   * THE `WHERE` IS THE PREDICATE OF THE PARTIAL INDEX and of AG-067, and
   * nothing else: `waitlist_entry_open_candidates` is declared `WHERE status IN
   * ('WAITING', 'CONTACTED')`, so this is the query it was built for. Adding
   * `preferred_to >= current_date` would look like an optimisation and would be
   * a second copy of AG-065 written in a language no unit test speaks — and one
   * that resolves «today» in the session's zone, which is the bug
   * `clinical_date_in_ecuador_timezone` already had to correct once.
   *
   * ORDERED BY SENIORITY so the answer is deterministic before the domain
   * sorts it; the ORDER THAT MATTERS is `rankWaiting`'s, which needs the
   * priority the database does not store.
   */
  async openWaitlistEntriesFor(
    siteId: string,
  ): Promise<readonly WaitlistCandidate[]> {
    const rows = await this.prisma.waitlistEntry.findMany({
      where: { siteId, status: { in: [...OPEN_WAITLIST_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: CANDIDATE_SELECT,
    });

    return rows.map((row) => ({
      ...toEntryView(row),
      // The names the domain uses: an entry is a candidate, and what it was
      // created at is the seniority AG-061 breaks ties by.
      id: row.id,
      enrolledAt: row.createdAt,
      patient: {
        birthDate: toClinicalDate(row.patient.birthDate),
        // PA-055. This chart's periods and those of every chart it absorbed,
        // put back together by the shared resolution so no caller writes that
        // union by hand.
        periods: chartScopeRows<'priorityGroups', StoredPeriod>(
          row.patient,
          'priorityGroups',
        ).map((period) => ({
          startsOn: toClinicalDate(period.startsOn),
          endsOn: period.endsOn === null ? null : toClinicalDate(period.endsOn),
        })),
        chartMergedAway: row.patient.mergedIntoId !== null,
      },
    }));
  }

  /**
   * AG-065, AG-066. Closes what the domain decided has lapsed.
   *
   * THE `status` FILTER IS NOT REDUNDANT: it makes the write idempotent — a
   * second sweep over the same identifiers matches nothing — and it keeps
   * `trg_waitlist_entry_closure_final` from aborting the whole statement over
   * a row somebody closed in between.
   */
  async expireWaitlistEntries(entryIds: readonly string[]): Promise<number> {
    if (entryIds.length === 0) return 0;

    const { count } = await this.prisma.waitlistEntry.updateMany({
      where: {
        id: { in: [...entryIds] },
        status: { in: [...OPEN_WAITLIST_STATUSES] },
      },
      data: { status: 'EXPIRED' },
    });
    return count;
  }

  /** AG-071. One entry of one site, or `null` for anything else. */
  async findWaitlistEntry(
    query: WaitlistEntryQuery,
  ): Promise<WaitlistEntryView | null> {
    const row = await this.prisma.waitlistEntry.findFirst({
      where: { id: query.entryId, siteId: query.siteId },
      select: ENTRY_SELECT,
    });
    return row === null ? null : toEntryView(row);
  }

  /**
   * AG-064. The attempt and what follows from it, in ONE transaction.
   *
   * An attempt written without the status it produces leaves an entry that has
   * used up the site's calls still competing for slots (AG-066), and the trail
   * is append-only — the write cannot be taken back and corrected.
   */
  async recordWaitlistContact(
    attempt: NewContactAttempt,
  ): Promise<WaitlistEntryView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.waitlistContactAttempt.create({
          data: {
            waitlistEntryId: attempt.entryId,
            outcome: attempt.outcome,
            recordedById: attempt.recordedById,
          },
        });

        const row = await tx.waitlistEntry.update({
          where: { id: attempt.entryId },
          data: { status: attempt.status },
          select: ENTRY_SELECT,
        });
        return toEntryView(row);
      });
    } catch (error) {
      throw translateWaitlistRejection(error);
    }
  }

  /**
   * AG-063. `SCHEDULED` and the link, in one statement because they are one
   * fact — `waitlist_entry_conversion_complete` is a biconditional and refuses
   * either half alone.
   */
  async convertWaitlistEntry(
    conversion: WaitlistConversion,
  ): Promise<WaitlistEntryView> {
    try {
      const row = await this.prisma.waitlistEntry.update({
        where: { id: conversion.entryId },
        data: {
          status: 'SCHEDULED',
          convertedEntryId: conversion.appointmentId,
        },
        select: ENTRY_SELECT,
      });
      return toEntryView(row);
    } catch (error) {
      throw translateWaitlistRejection(error);
    }
  }
}

/**
 * Which refusal happened, or the original error when it is something else.
 *
 * ⚠️ NOT A SECOND COPY OF THE RULES. The rules are the two triggers and the
 * partial unique index; this only decides what each rejection MEANS to whoever
 * is at the desk, because the three arrive as the same SQLSTATE with the same
 * generic code (`23514` → `CHECK_FAILED`) and what to do about them is
 * different in each case:
 *
 *   * `WAITLIST_PATIENT_MISMATCH` — pick the appointment booked for THIS
 *     patient. A block of agenda lands here too, and needs no code of its own:
 *     a block has no patient at all, so «is it the same chart?» answers no.
 *   * `WAITLIST_ACCEPTANCE_REQUIRED` — record the acceptance first (AG-064).
 *   * `WAITLIST_ENTRY_CLOSED` — the entry moved on and does not reopen
 *     (AG-067); enrol the patient again if they are still waiting.
 *   * `WAITLIST_SLOT_ALREADY_CLAIMED` — another entry took that appointment
 *     first. It is the race this feature exists to arbitrate: two receptionists
 *     handing one freed slot to two people. Prisma resolves the unique
 *     violation itself and reports the COLUMN rather than the index name, so
 *     that is what is matched.
 */
function translateWaitlistRejection(error: unknown): unknown {
  const message = databaseMessageOf(error);

  if (/appointment of another patient/.test(message)) {
    return new WaitlistPatientMismatchError();
  }
  if (/no recorded acceptance/.test(message)) {
    return new WaitlistAcceptanceRequiredError();
  }
  if (/cannot be reopened/.test(message)) {
    return new WaitlistEntryClosedError();
  }
  if (/converted_entry_id|convertedEntryId/.test(message)) {
    return new WaitlistSlotAlreadyClaimedError();
  }
  return error;
}

/**
 * Everything PostgreSQL said, from both layers.
 *
 * The driver's own message carries what the trigger raised; the ORM's carries
 * the field of a unique violation it resolved itself. Neither `detail` nor the
 * failing row is ever read — that is where the patient data is.
 */
function databaseMessageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';

  const parts: string[] = [];
  const candidate = error as {
    message?: unknown;
    meta?: {
      driverAdapterError?: { cause?: { originalMessage?: unknown } };
      target?: unknown;
    };
  };

  if (typeof candidate.message === 'string') parts.push(candidate.message);
  const original = candidate.meta?.driverAdapterError?.cause?.originalMessage;
  if (typeof original === 'string') parts.push(original);
  const target = candidate.meta?.target;
  if (Array.isArray(target)) parts.push(target.join(','));

  return parts.join('\n');
}

/** A period as the two date columns store it. */
interface StoredPeriod {
  startsOn: Date;
  endsOn: Date | null;
}

/** A `@db.Date` column, read as the calendar day it stores. */
function toClinicalDate(value: Date): ClinicalDate {
  return parseClinicalDate(value.toISOString().slice(0, 10));
}

/** The same, on the way in. */
function civilDay(date: ClinicalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Row to view. The attempt count and the last call are derived from the
 * contact trail, not from columns of their own (see `CONTACT_TRAIL_SELECT`).
 */
function toEntryView(row: {
  id: string;
  siteId: string;
  patientId: string;
  practitionerId: string | null;
  serviceTypeId: string | null;
  preferredFrom: Date;
  preferredTo: Date;
  status: WaitlistEntryView['status'];
  convertedEntryId: string | null;
  createdAt: Date;
  _count: { contactAttempts: number };
  contactAttempts: { attemptedAt: Date }[];
}): WaitlistEntryView {
  return {
    id: row.id,
    siteId: row.siteId,
    patientId: row.patientId,
    practitionerId: row.practitionerId,
    serviceTypeId: row.serviceTypeId,
    preferredFrom: toClinicalDate(row.preferredFrom),
    preferredTo: toClinicalDate(row.preferredTo),
    status: row.status,
    convertedEntryId: row.convertedEntryId,
    contactAttempts: row._count.contactAttempts,
    lastContactedAt: row.contactAttempts[0]?.attemptedAt ?? null,
    createdAt: row.createdAt,
  };
}
