import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  HolidayChange,
  HolidayInput,
  HolidayPatch,
  HolidayQuery,
  HolidayRepository,
  HolidayView,
} from '../domain/holiday.repository';

import {
  duplicateErrorFrom,
  isForeignKeyViolationOf,
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

/** One selection for every read, so every path yields the same view. */
const HOLIDAY_SELECT = {
  id: true,
  date: true,
  name: true,
  siteId: true,
  /**
   * AG-092. Ordered, so two exceptions never swap places between requests and
   * a client comparing the two answers does not see a change that is not one.
   */
  workedBy: { select: { siteId: true }, orderBy: { siteId: 'asc' } },
} satisfies Prisma.HolidaySelect;

/** The row `HOLIDAY_SELECT` produces; `date` is a `Date` at midnight UTC. */
interface HolidayRow {
  id: string;
  date: Date;
  name: string;
  siteId: string | null;
  workedBy: { siteId: string }[];
}

/**
 * The day is read with `toISOString()`, never with local getters: see the
 * header for why that is exact.
 */
function toView(row: HolidayRow): HolidayView {
  return {
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    name: row.name,
    siteId: row.siteId,
    workedBySiteIds: row.workedBy.map((exception) => exception.siteId),
  };
}

/** `YYYY-MM-DD` as the instant PostgreSQL stores for that calendar day. */
function toColumn(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Prisma adapter for `HolidayRepository`. The unique index arbitrates
 * duplicates (CF-061) and the foreign key arbitrates unknown sites; nothing
 * here reads first.
 */
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

  /** CF-067. The authorisation read: whose holiday is this, before anything. */
  async findById(id: string): Promise<HolidayView | null> {
    return this.find(this.prisma, id);
  }

  /**
   * CF-060, CF-061: a duplicate date in the same scope is refused by
   * `holiday_date_scope_unique` and translated to `HOLIDAY_DUPLICATE`.
   */
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

  /**
   * AG-097, CF-066: the row as it was and as it became, both read inside the
   * transaction that writes. The previous value is the point — see
   * `HolidayChange` for why a read issued before the call cannot serve.
   */
  async update(id: string, patch: HolidayPatch): Promise<HolidayChange | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // `FOR UPDATE`, which Prisma cannot express: at READ COMMITTED another
        // transaction can commit between this read and the update, and the
        // trail would then name a previous value this write never replaced.
        // The row's own lock is enough; the exceptions travel with it because
        // nothing changes them here.
        await tx.$queryRaw`SELECT 1 FROM holiday WHERE id = ${id}::uuid FOR UPDATE`;

        const before = await this.find(tx, id);
        if (!before) return null;

        const row = await tx.holiday.update({
          where: { id },
          data: {
            // `undefined` leaves the column alone; only a value replaces it.
            date: patch.date === undefined ? undefined : toColumn(patch.date),
            name: patch.name,
            siteId: patch.siteId,
          },
          select: HOLIDAY_SELECT,
        });

        return { before, after: toView(row) };
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * The row that disappeared, so the trail can keep it (AG-097): after this
   * runs, the audit entry is the only place it still exists.
   *
   * Read and delete in one transaction, and the read is `FOR UPDATE`: two
   * simultaneous deletions must not both claim to have removed the row.
   */
  async delete(id: string): Promise<HolidayView | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM holiday WHERE id = ${id}::uuid FOR UPDATE`;

        const deleted = await this.find(tx, id);
        if (!deleted) return null;

        await tx.holiday.delete({ where: { id } });
        return deleted;
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * AG-092. `holiday_site_exception` gains the pair, or already had it.
   *
   * AN UPSERT AND NOT A CREATE, so the second click is not a 409: the primary
   * key IS the pair, and «esta sede trabaja este feriado» said twice is the
   * same statement. There is nothing to update — the row has no other column
   * the caller controls — so `update: {}` is the whole point of it.
   *
   * NEITHER FOREIGN KEY IS CHECKED FIRST. A missing holiday comes back as
   * `null` so the service can answer `HOLIDAY_NOT_FOUND`; a missing site keeps
   * travelling, because the site belongs to `organization` and
   * `configuration.constraints.ts` turns that refusal into `SITE_NOT_FOUND`
   * with a message. Reading before writing would only move the race.
   */
  async markWorkedBy(
    holidayId: string,
    siteId: string,
  ): Promise<HolidayChange | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM holiday WHERE id = ${holidayId}::uuid FOR UPDATE`;

        const before = await this.find(tx, holidayId);
        if (!before) return null;

        await tx.holidaySiteException.upsert({
          where: { holidayId_siteId: { holidayId, siteId } },
          create: { holidayId, siteId },
          update: {},
        });

        const after = await this.find(tx, holidayId);
        return after ? { before, after } : null;
      });
    } catch (error) {
      if (
        isForeignKeyViolationOf(error, 'holiday_site_exception_holiday_id_fkey')
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * AG-092, in reverse: the site observes the holiday again.
   *
   * `deleteMany` and not `delete`, so removing an exception that is not there
   * answers «hecho» instead of 404: the caller asked for a state, and the
   * state is already that one. What DOES answer 404 is the holiday being gone,
   * which the read below settles.
   */
  async unmarkWorkedBy(
    holidayId: string,
    siteId: string,
  ): Promise<HolidayChange | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM holiday WHERE id = ${holidayId}::uuid FOR UPDATE`;

      const before = await this.find(tx, holidayId);
      if (!before) return null;

      await tx.holidaySiteException.deleteMany({
        where: { holidayId, siteId },
      });

      const after = await this.find(tx, holidayId);
      return after ? { before, after } : null;
    });
  }

  /**
   * The holiday with its exceptions, or `null` when it is gone.
   *
   * It takes the client rather than reaching for `this.prisma`, so that a
   * caller inside a transaction reads what that transaction sees. Handing it
   * the pooled client instead would read from a different connection — and the
   * `before` of a mutation would come from outside the write that produced it.
   */
  private async find(
    client: Prisma.TransactionClient,
    id: string,
  ): Promise<HolidayView | null> {
    const row = await client.holiday.findUnique({
      where: { id },
      select: HOLIDAY_SELECT,
    });

    return row ? toView(row) : null;
  }
}
