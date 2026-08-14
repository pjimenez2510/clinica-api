import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type ClinicalDate,
  WallClockTime,
  clinicalDayBounds,
} from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { BookedInterval } from '../domain/schedule-conflicts';
import type {
  ScheduleRuleRepository,
  ScheduleRuleView,
  ScheduleRuleWrite,
} from '../domain/schedule-rule.repository';

import { isRecordNotFound } from './staff-database-errors';

/**
 * Schedule rules in and out, with the two conversions that this table needs
 * and no other table does.
 *
 * WALL CLOCK, NOT INSTANTS. `start_time` and `end_time` are `time` columns —
 * the one deliberate exception to `timestamptz` in this schema — and the
 * driver hands them over as a `Date` pinned to 1970-01-01 whose UTC parts ARE
 * the wall clock. Reading them with local getters would shift every rule by
 * the host's offset, silently: a Quito morning read on a UTC server becomes
 * the small hours. `WallClockTime.fromTimeColumn` is the only way in, and it
 * also refuses a value that rolled past midnight.
 *
 * NOTHING HERE ASKS WHETHER A RULE WOULD OVERLAP. ST-042 is
 * `schedule_rule_no_overlap` in the base, and adding a check-first query would
 * be an invitation to lose the race the constraint exists to close.
 */

const RULE_SELECT = {
  id: true,
  practitionerId: true,
  siteId: true,
  weekday: true,
  startTime: true,
  endTime: true,
  validFrom: true,
  validTo: true,
  active: true,
} satisfies Prisma.PractitionerScheduleRuleSelect;

type RuleRow = Prisma.PractitionerScheduleRuleGetPayload<{
  select: typeof RULE_SELECT;
}>;

function toClinicalDate(value: Date): ClinicalDate {
  return value.toISOString().slice(0, 10) as ClinicalDate;
}

function fromClinicalDate(value: ClinicalDate): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** `HH:MM` into the shape the `time` column expects. */
function toTimeColumn(value: string): Date {
  return new Date(`1970-01-01T${WallClockTime.parse(value).toString()}:00Z`);
}

function toView(row: RuleRow): ScheduleRuleView {
  return {
    id: row.id,
    practitionerId: row.practitionerId,
    siteId: row.siteId,
    weekday: row.weekday,
    startTime: WallClockTime.fromTimeColumn(row.startTime).toString(),
    endTime: WallClockTime.fromTimeColumn(row.endTime).toString(),
    validFrom: toClinicalDate(row.validFrom),
    validTo: row.validTo === null ? null : toClinicalDate(row.validTo),
    active: row.active,
  };
}

@Injectable()
export class PrismaScheduleRuleRepository implements ScheduleRuleRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ST-040. `includeClosed` decides whether rules already ended travel: the
   * editing screen needs them to explain last month's agenda, the day-to-day
   * one does not.
   */
  async listByPractitioner(
    practitionerId: string,
    includeClosed: boolean,
  ): Promise<readonly ScheduleRuleView[]> {
    const rows = await this.prisma.practitionerScheduleRule.findMany({
      where: { practitionerId, ...(includeClosed ? {} : { active: true }) },
      select: RULE_SELECT,
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
    return rows.map(toView);
  }

  async findRule(id: string): Promise<ScheduleRuleView | null> {
    const row = await this.prisma.practitionerScheduleRule.findUnique({
      where: { id },
      select: RULE_SELECT,
    });
    return row === null ? null : toView(row);
  }

  async create(rule: ScheduleRuleWrite): Promise<ScheduleRuleView> {
    const created = await this.prisma.practitionerScheduleRule.create({
      data: {
        practitionerId: rule.practitionerId,
        siteId: rule.siteId,
        weekday: rule.weekday,
        startTime: toTimeColumn(rule.startTime),
        endTime: toTimeColumn(rule.endTime),
        validFrom: fromClinicalDate(rule.validFrom),
        validTo: rule.validTo === null ? null : fromClinicalDate(rule.validTo),
      },
      select: RULE_SELECT,
    });
    return toView(created);
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRuleWrite, 'practitionerId'>> & {
      active?: boolean;
    },
  ): Promise<ScheduleRuleView | null> {
    try {
      const updated = await this.prisma.practitionerScheduleRule.update({
        where: { id },
        data: {
          ...(patch.siteId !== undefined ? { siteId: patch.siteId } : {}),
          ...(patch.weekday !== undefined ? { weekday: patch.weekday } : {}),
          ...(patch.startTime !== undefined
            ? { startTime: toTimeColumn(patch.startTime) }
            : {}),
          ...(patch.endTime !== undefined
            ? { endTime: toTimeColumn(patch.endTime) }
            : {}),
          ...(patch.validFrom !== undefined
            ? { validFrom: fromClinicalDate(patch.validFrom) }
            : {}),
          ...(patch.validTo !== undefined
            ? {
                validTo:
                  patch.validTo === null
                    ? null
                    : fromClinicalDate(patch.validTo),
              }
            : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        },
        select: RULE_SELECT,
      });
      return toView(updated);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  async practitionerWorksAt(
    practitionerId: string,
    siteId: string,
  ): Promise<boolean> {
    const row = await this.prisma.practitionerSite.findUnique({
      where: { practitionerId_siteId: { practitionerId, siteId } },
      select: { siteId: true },
    });
    return row !== null;
  }

  /** `null` distinguishes "not schedulable" from "does not exist". */
  async isSchedulable(practitionerId: string): Promise<boolean | null> {
    const row = await this.prisma.practitioner.findUnique({
      where: { id: practitionerId },
      select: { schedulable: true },
    });
    return row?.schedulable ?? null;
  }

  /**
   * ST-043. `kind = 'APPOINTMENT'` and `released_at IS NULL` are what the two
   * exclusions in the comment this replaces were actually about: a cancelled
   * appointment stopped occupying the calendar, and a holiday block outside
   * the new hours is exactly what a holiday block is for.
   *
   * ⚠️ `blocks_calendar` IS DELIBERATELY NOT FILTERED, and it used to be. That
   * column is `false` for an OVERBOOKING — an urgent case squeezed in on
   * purpose — which is a real appointment with a real patient waiting. Copying
   * the agenda's exclusion predicate wholesale hid exactly the people somebody
   * has to phone. The agenda's constraint ignores those rows because it is
   * arbitrating who occupies a slot; this query is asking who is left outside
   * the hours, and that is a different question.
   *
   * The lower bound is resolved in `America/Guayaquil`, never in the session's
   * zone: `>= today at 00:00` computed on a UTC host would drop the whole
   * Ecuadorian evening of the previous day into the range.
   */
  async bookedFrom(
    practitionerId: string,
    siteId: string,
    from: ClinicalDate,
  ): Promise<readonly BookedInterval[]> {
    const rows = await this.prisma.agendaEntry.findMany({
      where: {
        practitionerId,
        siteId,
        kind: 'APPOINTMENT',
        releasedAt: null,
        startsAt: { gte: clinicalDayBounds(from).startsAt },
      },
      select: { id: true, siteId: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    return rows;
  }

  /**
   * D-021, ST-045. The site's slot atom, or `null` when the site has no
   * parameter row.
   *
   * `null` IS NOT ZERO. It is the AG-095 case — «un parámetro no está definido
   * para la sede» — and what it means here is «there is nothing to compare the
   * band against», not «every band is too short». A trigger writes the row for
   * every site (CF-062), so in a healthy database it never happens; answering
   * it honestly is what stops a restored dump from refusing every schedule.
   */
  async slotAtomOfSite(siteId: string): Promise<number | null> {
    const row = await this.prisma.siteParameter.findUnique({
      where: { siteId },
      select: { slotAtomMinutes: true },
    });
    return row?.slotAtomMinutes ?? null;
  }
}
