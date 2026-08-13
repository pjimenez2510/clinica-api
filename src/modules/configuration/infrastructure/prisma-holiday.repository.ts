import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  HolidayInput,
  HolidayPatch,
  HolidayQuery,
  HolidayRepository,
  HolidayView,
} from '../domain/holiday.repository';

import {
  duplicateErrorFrom,
  isRecordNotFound,
} from './configuration-database-errors';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here, and so does the one PostgreSQL refusal
 * that means something to an administrator: `holiday_date_scope_unique`
 * answers as `HOLIDAY_DUPLICATE` (CF-061). Nothing here checks first — two
 * administrators writing in the same millisecond are arbitrated by the index,
 * not by a read that was stale before it returned.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DATE IS A CALENDAR DAY, AND THIS IS THE ONLY PLACE THAT KNOWS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The column is `date`; Prisma types it as `DateTime` and hands back a `Date`
 * pinned to midnight UTC. Reading it with `toISOString()` and slicing the day
 * off is therefore exact, and reading it with `getFullYear()`/`getDate()`
 * would NOT be: the host's timezone would move «1 de enero» to the 31st of
 * December for anybody west of Greenwich, which is everybody here. Writing
 * goes through the same door in reverse, with an explicit `Z`.
 *
 * This is the same defect `AT TIME ZONE 'America/Guayaquil'` exists for in the
 * clinical tables, arriving from the opposite side: a holiday has no hour at
 * all, so the fix is to never let it acquire one.
 */

const HOLIDAY_SELECT = {
  id: true,
  date: true,
  name: true,
  siteId: true,
} satisfies Prisma.HolidaySelect;

interface HolidayRow {
  id: string;
  date: Date;
  name: string;
  siteId: string | null;
}

function toView(row: HolidayRow): HolidayView {
  return {
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    name: row.name,
    siteId: row.siteId,
  };
}

/** `YYYY-MM-DD` as the instant PostgreSQL stores for that calendar day. */
function toColumn(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

@Injectable()
export class PrismaHolidayRepository implements HolidayRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * CF-060. Ordered by date and then by name, so the screen is stable between
   * requests and two holidays sharing a day never swap places.
   *
   * WITH A SITE, THE ALL-SITES ROWS TRAVEL TOO. That is not convenience: what
   * a site observes is its own holidays plus the clinic-wide ones, and a
   * listing that returned only the first would let somebody book on the 1st of
   * January because the row that forbids it belongs to nobody in particular.
   */
  async list(query: HolidayQuery): Promise<readonly HolidayView[]> {
    const rows = await this.prisma.holiday.findMany({
      where: {
        date: {
          gte: toColumn(`${query.year}-01-01`),
          lt: toColumn(`${query.year + 1}-01-01`),
        },
        ...(query.siteId
          ? { OR: [{ siteId: query.siteId }, { siteId: null }] }
          : {}),
      },
      select: HOLIDAY_SELECT,
      orderBy: [{ date: 'asc' }, { name: 'asc' }],
    });

    return rows.map(toView);
  }

  /** CF-061 answered by `holiday_date_scope_unique`. */
  async create(input: HolidayInput): Promise<HolidayView> {
    try {
      const row = await this.prisma.holiday.create({
        data: {
          date: toColumn(input.date),
          name: input.name,
          siteId: input.siteId,
        },
        select: HOLIDAY_SELECT,
      });
      return toView(row);
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  async update(id: string, patch: HolidayPatch): Promise<HolidayView | null> {
    try {
      const row = await this.prisma.holiday.update({
        where: { id },
        data: {
          // `undefined` leaves the column alone; only a value replaces it.
          date: patch.date === undefined ? undefined : toColumn(patch.date),
          name: patch.name,
          siteId: patch.siteId,
        },
        select: HOLIDAY_SELECT,
      });
      return toView(row);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.holiday.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      throw error;
    }
  }
}
