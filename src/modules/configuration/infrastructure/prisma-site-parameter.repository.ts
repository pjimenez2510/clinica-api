import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
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

const PARAMETER_SELECT = {
  siteId: true,
  minLeadMinutes: true,
  maxLeadDays: true,
  overbookingCap: true,
  cancelledRetention: true,
} satisfies Prisma.SiteParameterSelect;

@Injectable()
export class PrismaSiteParameterRepository implements SiteParameterRepository {
  constructor(private readonly prisma: PrismaService) {}

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
   */
  async update(
    siteId: string,
    patch: SiteParametersPatch,
  ): Promise<SiteParameterView | null> {
    try {
      return await this.prisma.siteParameter.update({
        where: { siteId },
        data: {
          minLeadMinutes: patch.minLeadMinutes,
          maxLeadDays: patch.maxLeadDays,
          overbookingCap: patch.overbookingCap,
          cancelledRetention: patch.cancelledRetention,
        },
        select: PARAMETER_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }
}
