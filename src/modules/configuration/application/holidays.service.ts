import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared/authorisation/principal';
import { assertScopesInScope } from '../../../shared/authorisation/site-scope';
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

/**
 * CF-060. The date is a calendar day, `YYYY-MM-DD`. Writing a clinic-wide
 * holiday (`siteId` null) demands a clinic-wide grant (CF-067).
 */
export interface CreateHolidayCommand {
  date: string;
  name: string;
  /** `null` or absent = every site. That is the «alcance» of CF-060. */
  siteId?: string | null;
}

/**
 * CF-060. Absent fields keep their stored value; `siteId: null` moves the
 * holiday to every site, which is a clinic-wide write (CF-067).
 */
export interface UpdateHolidayCommand {
  date?: string;
  name?: string;
  siteId?: string | null;
}

/**
 * Holidays: CF-060, CF-061, CF-066, and the working exception of AG-092.
 *
 * THE SITE HALF OF THE AUTHORISATION IS HERE, and only that half (CF-067,
 * D-023). The guard settled the permission from the route's
 * `@RequirePermission`, but it cannot settle the SITE: a holiday's scope
 * arrives in the body and guards run before the pipes. It matters more here
 * than almost anywhere else because `site_id IS NULL` is not «sin sede», it is
 * «todas» — a national holiday shuts every site's agenda (AG-015), so writing
 * one is an act of clinic-wide reach and demands a clinic-wide grant. What is
 * also here is what must hold regardless of which endpoint asked: an audit
 * entry on every mutation (CF-066).
 *
 * THE SCOPE IS READ BEFORE THE WRITE, not inside the writing transaction, and
 * the two reads are different questions. The trail's «desde qué valor» must be
 * the row the write actually replaced, so it comes from inside; the
 * authorisation answer must exist BEFORE anything is written, because a
 * refusal that already changed a row is not a refusal. The window between them
 * needs a concurrent privileged write to matter, and it is the same trade
 * ST-047 accepted.
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

  /** CF-060, CF-061, CF-066, CF-067. */
  async create(
    command: CreateHolidayCommand,
    requester: Requester,
    caller: Principal,
  ): Promise<HolidayView> {
    // CF-067. `null` — «todas las sedes» — demands the clinic-wide grant.
    assertScopesInScope(caller, 'settings:manage', [command.siteId ?? null]);

    const created = await this.repository.create({
      date: command.date,
      name: command.name,
      siteId: command.siteId ?? null,
    });

    // AG-097: no `before`, and that is the honest answer rather than an empty
    // object — nothing was replaced.
    await this.trail.record('CREATE', created.id, requester, {
      after: created,
    });
    return created;
  }

  /**
   * CF-060, CF-066, CF-067, AG-097.
   *
   * BOTH ENDS OF THE MOVE ARE JUDGED, like ST-047 does with a practitioner's
   * sites. Editing a holiday moves its reach, and both ends of that move
   * change an agenda: promoting Norte's holiday to national SHUTS the day
   * everywhere, and demoting a national one to Norte REOPENS it everywhere
   * else. Checking only what the caller sent would let either happen from one
   * site's screen; checking only what is stored would let a national holiday
   * be created out of a local one.
   */
  async update(
    id: string,
    command: UpdateHolidayCommand,
    requester: Requester,
    caller: Principal,
  ): Promise<HolidayView> {
    const current = await this.repository.findById(id);
    if (!current) throw new HolidayNotFoundError();
    assertScopesInScope(caller, 'settings:manage', [
      current.siteId,
      command.siteId === undefined ? current.siteId : command.siteId,
    ]);

    const patch: HolidayPatch = { date: command.date, name: command.name };
    // Only when the caller sent it. `undefined` means "leave the scope alone"
    // and `null` means "make it apply to every site"; collapsing the two would
    // silently widen a site's holiday to the whole clinic on every rename.
    if (command.siteId !== undefined) patch.siteId = command.siteId;

    const change = await this.repository.update(id, patch);
    if (!change) throw new HolidayNotFoundError();

    await this.trail.record('UPDATE', change.after.id, requester, change);
    return change.after;
  }

  /**
   * CF-066, AG-097. A hard delete, and this is the one row in the module where
   * that is right: nothing references a holiday — the agenda READS the
   * calendar when it books and stores no pointer to it — so there is no
   * evidence to orphan. The trail keeps who removed it AND what was removed,
   * which here is the only surviving copy of the row.
   */
  async delete(
    id: string,
    requester: Requester,
    caller: Principal,
  ): Promise<void> {
    // CF-067. Deleting is the same power with the sign flipped: removing a
    // national holiday OPENS that day in every site. The scope is not in the
    // request at all — it is in the row — so it is read and judged the same.
    const current = await this.repository.findById(id);
    if (!current) throw new HolidayNotFoundError();
    assertScopesInScope(caller, 'settings:manage', [current.siteId]);

    const deleted = await this.repository.delete(id);
    if (!deleted) throw new HolidayNotFoundError();

    await this.trail.record('UPDATE', id, requester, { before: deleted });
  }

  /**
   * AG-092, CF-066. This site works that holiday: A&E opens on 25 December
   * while every other site stays shut.
   *
   * AN EXCEPTION AND NOT A DELETION, which is the whole requirement: deleting
   * the national holiday would open the other sites too, and there would be
   * nothing left to say the day IS a holiday for them.
   *
   * The mutation is on the HOLIDAY, so the trail names the holiday (CF-066).
   * The site is in the URL and the guard already checked the caller's scope
   * over it before this ran.
   */
  async markWorkedBy(
    id: string,
    siteId: string,
    requester: Requester,
  ): Promise<HolidayView> {
    const change = await this.repository.markWorkedBy(id, siteId);
    if (!change) throw new HolidayNotFoundError();

    // AG-097: what changed IS the list of exceptions, so the pair is what
    // makes the entry mean anything — «se tocó este feriado» does not say
    // which site started or stopped working it.
    await this.trail.record('UPDATE', change.after.id, requester, change);
    return change.after;
  }

  /** AG-092, CF-066, AG-097. The site goes back to observing the holiday. */
  async unmarkWorkedBy(
    id: string,
    siteId: string,
    requester: Requester,
  ): Promise<HolidayView> {
    const change = await this.repository.unmarkWorkedBy(id, siteId);
    if (!change) throw new HolidayNotFoundError();

    await this.trail.record('UPDATE', change.after.id, requester, change);
    return change.after;
  }
}
