import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  SiteParameterChange,
  SiteParameterRepository,
  SiteParameterView,
} from '../domain/site-parameter.repository';
import type { SiteParametersPatch } from '../domain/site-parameters';

import { isRecordNotFound } from './configuration-database-errors';

/**
 * Rows in, domain shapes out.
 *
 * NO `create`, and no upsert either. `trg_site_parameter_defaults` writes the
 * row of D-001 when the site is inserted (CF-062), so an upsert here would be
 * a second source of the defaults — and the day the two disagreed, what a site
 * does by default would depend on who inserted it. A missing row is therefore
 * information: the site does not exist.
 *
 * THE RANGE CHECKS ARE NOT TRANSLATED HERE. `assertParametersInRange` refuses
 * the value before it ever reaches PostgreSQL, so a `23514` from these columns
 * means the write bypassed the service — and for that path
 * `configuration.constraints.ts` already registers a message naming the range.
 */

/** Every column of `SiteParameterView`, and nothing else from the row. */
const PARAMETER_SELECT = {
  siteId: true,
  minLeadMinutes: true,
  maxLeadDays: true,
  overbookingCap: true,
  slotAtomMinutes: true,
  allowPastBooking: true,
  // E4 (AG-039, AG-101). Los dos parámetros que D-018 dejó para la entrega
  // que los lee, y que ésta ya lee.
  overbookingEnabled: true,
  overbookingPermission: true,
  // E5 (AG-066, AG-094). El octavo parámetro de AG-094, que `site_parameter`
  // no tuvo hasta `agenda_waitlist_contact_trail`.
  waitlistMaxContactAttempts: true,
  cancelledRetention: true,
  // ORD-046, ORD-063, ORD-065: la política de las colas de resultados.
  criticalNoticeWithinMinutes: true,
  criticalEscalationRoleId: true,
  unmatchedResultOwnerRoleId: true,
  unmatchedResultDeadlineHours: true,
} satisfies Prisma.SiteParameterSelect;

/**
 * Prisma adapter for `SiteParameterRepository`. Also answers two questions
 * about tables of other modules — configured durations and installed
 * permissions — without importing their code.
 */
@Injectable()
export class PrismaSiteParameterRepository implements SiteParameterRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `null` means the site is unknown: the database writes this row with every
   * site (CF-062).
   */
  async find(siteId: string): Promise<SiteParameterView | null> {
    return this.prisma.siteParameter.findUnique({
      where: { siteId },
      select: PARAMETER_SELECT,
    });
  }

  /**
   * CF-064 lives in what this method WRITES: one row of `site_parameter`, and
   * nothing else. No pass over `agenda_entry`, no revalidation, no
   * cancellation — a change rules forward only, and the cheapest way to keep
   * that true is for the code that would undo it not to exist.
   *
   * AG-097, CF-066: it answers with BOTH sides, and the read that produces
   * `before` runs INSIDE the transaction that writes `after`. The service also
   * reads before calling — for CF-065's coherence check — and that read cannot
   * serve here: it is already stale by the time the UPDATE runs, so two
   * administrators saving at once would each log a previous value the other
   * had replaced. `SELECT … FOR UPDATE` is what makes the pair exact rather
   * than merely likely: the second transaction waits for the first, reads what
   * it actually left, and the entries chain instead of contradicting.
   */
  async update(
    siteId: string,
    patch: SiteParametersPatch,
  ): Promise<SiteParameterChange | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Prisma has no `FOR UPDATE`, so the lock is asked for in SQL. Without
        // it, READ COMMITTED lets another transaction commit between this read
        // and the update below, and `before` would name a value this write did
        // not replace. It locks nothing when the site has no row, which the
        // read then reports as the unknown site it is.
        await tx.$queryRaw`
          SELECT 1 FROM site_parameter WHERE site_id = ${siteId}::uuid FOR UPDATE
        `;

        const before = await tx.siteParameter.findUnique({
          where: { siteId },
          select: PARAMETER_SELECT,
        });
        if (!before) return null;

        const after = await tx.siteParameter.update({
          where: { siteId },
          data: {
            minLeadMinutes: patch.minLeadMinutes,
            maxLeadDays: patch.maxLeadDays,
            overbookingCap: patch.overbookingCap,
            slotAtomMinutes: patch.slotAtomMinutes,
            // `undefined` leaves the column alone; `false` is a value the site
            // chose and has to reach the row like any other.
            allowPastBooking: patch.allowPastBooking,
            overbookingEnabled: patch.overbookingEnabled,
            /**
             * AG-101. La clave foránea contra `permission(code)` es la última
             * palabra: el servicio ya rechazó lo que el catálogo no declara y
             * lo que esta instalación no tiene sembrado, y esto es lo que
             * queda si la escritura llega por otro camino.
             */
            overbookingPermission: patch.overbookingPermission,
            waitlistMaxContactAttempts: patch.waitlistMaxContactAttempts,
            // `null` clears (sin plazo, quien pidió); `undefined` leaves alone.
            criticalNoticeWithinMinutes: patch.criticalNoticeWithinMinutes,
            criticalEscalationRoleId: patch.criticalEscalationRoleId,
            unmatchedResultOwnerRoleId: patch.unmatchedResultOwnerRoleId,
            unmatchedResultDeadlineHours: patch.unmatchedResultDeadlineHours,
          },
          select: PARAMETER_SELECT,
        });

        return { before, after };
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * D-021. The distinct durations the clinic has configured: the base of every
   * service type and every per-practitioner exception.
   *
   * BOTH TABLES, and both belong to other modules — see the port. Missing
   * either one would make the refusal a half-truth: an exception of 30 minutes
   * is just as unbookable on a 20-minute grid as a base duration of 30, and
   * ST-009 is the rung that wins when it exists (SP-023).
   *
   * INACTIVE ROWS COUNT. A deactivated service type keeps its duration and
   * SP-004 promises the existing references stay intact, so reactivating it
   * after the atom moved would produce exactly the unbookable configuration
   * this refusal exists to prevent — silently, and much later.
   */
  async configuredDurations(): Promise<readonly number[]> {
    const [types, exceptions] = await Promise.all([
      this.prisma.serviceType.findMany({
        distinct: ['durationMinutes'],
        select: { durationMinutes: true },
      }),
      this.prisma.durationException.findMany({
        distinct: ['durationMinutes'],
        select: { durationMinutes: true },
      }),
    ]);

    return [...types, ...exceptions].map((row) => row.durationMinutes);
  }

  /**
   * AG-101, AU-033. Which of these codes the `permission` mirror actually has.
   *
   * IT READS `permission`, a table of `auth`, through this module's own
   * adapter — the same route `configuredDurations` takes to `service_type`.
   * The alternative was letting the foreign key answer, and that answer
   * reaches a screen as «Datos inválidos» over a form where nothing is
   * invalid: the exact failure `PERMISSION_NOT_INSTALLED` was created for.
   */
  async installedPermissions(
    codes: readonly string[],
  ): Promise<readonly string[]> {
    const rows = await this.prisma.permission.findMany({
      where: { code: { in: [...codes] } },
      select: { code: true },
    });
    return rows.map((row) => row.code);
  }
}
