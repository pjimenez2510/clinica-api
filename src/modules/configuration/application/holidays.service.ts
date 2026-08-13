import { Inject, Injectable } from '@nestjs/common';

import { HolidayNotFoundError } from '../domain/configuration.errors';
import {
  HOLIDAY_REPOSITORY,
  type HolidayPatch,
  type HolidayQuery,
  type HolidayRepository,
  type HolidayView,
} from '../domain/holiday.repository';

import {
  ConfigurationAuditTrail,
  type Requester,
} from './configuration-audit.trail';

export interface CreateHolidayCommand {
  date: string;
  name: string;
  /** `null` or absent = every site. That is the «alcance» of CF-060. */
  siteId?: string | null;
}

export interface UpdateHolidayCommand {
  date?: string;
  name?: string;
  siteId?: string | null;
}

/**
 * Holidays: CF-060, CF-061, CF-066.
 *
 * The authorisation decision is NOT here — the guard settled it from the
 * route's `@RequirePermission`. What IS here is what must hold regardless of
 * which endpoint asked: an audit entry on every mutation (CF-066).
 *
 * WHAT THIS SERVICE DOES NOT DO: check for a duplicate before writing. Two
 * administrators loading the year's calendar and adding «Carnaval» in the same
 * second both read "free"; only `holiday_date_scope_unique` can arbitrate, and
 * the adapter translates its refusal into `HOLIDAY_DUPLICATE` (CF-061).
 *
 * SEPARATE FROM `SiteParametersService`, and not by symmetry. ADR-008 §2 splits
 * a service when two groups of methods share no dependencies: these two share
 * the audit trail and nothing else — different tables, different repositories,
 * different reasons to change. What holds them together is a screen, and a
 * screen is not a module (ADR-011).
 */
@Injectable()
export class HolidaysService {
  constructor(
    @Inject(HOLIDAY_REPOSITORY)
    private readonly repository: HolidayRepository,
    private readonly trail: ConfigurationAuditTrail,
  ) {}

  /**
   * CF-060. Reads leave NO audit row: a calendar of public holidays is not
   * clinical content, and recording every listing would bury the accesses that
   * matter (REQ-111).
   */
  async list(query: HolidayQuery): Promise<readonly HolidayView[]> {
    return this.repository.list(query);
  }

  /** CF-060, CF-061, CF-066. */
  async create(
    command: CreateHolidayCommand,
    requester: Requester,
  ): Promise<HolidayView> {
    const created = await this.repository.create({
      date: command.date,
      name: command.name,
      siteId: command.siteId ?? null,
    });

    await this.trail.record('CREATE', created.id, requester);
    return created;
  }

  /** CF-060, CF-066. */
  async update(
    id: string,
    command: UpdateHolidayCommand,
    requester: Requester,
  ): Promise<HolidayView> {
    const patch: HolidayPatch = { date: command.date, name: command.name };
    // Only when the caller sent it. `undefined` means "leave the scope alone"
    // and `null` means "make it apply to every site"; collapsing the two would
    // silently widen a site's holiday to the whole clinic on every rename.
    if (command.siteId !== undefined) patch.siteId = command.siteId;

    const updated = await this.repository.update(id, patch);
    if (!updated) throw new HolidayNotFoundError();

    await this.trail.record('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * CF-066. A hard delete, and this is the one row in the module where that is
   * right: nothing references a holiday — the agenda READS the calendar when
   * it books and stores no pointer to it — so there is no evidence to orphan.
   * The trail keeps who removed it.
   */
  async delete(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) throw new HolidayNotFoundError();

    await this.trail.record('UPDATE', id, requester);
  }
}
