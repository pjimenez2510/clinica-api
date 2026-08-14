import { Inject, Injectable } from '@nestjs/common';

import { SiteParametersNotFoundError } from '../domain/configuration.errors';
import {
  SITE_PARAMETER_REPOSITORY,
  type SiteParameterRepository,
  type SiteParameterView,
} from '../domain/site-parameter.repository';
import {
  assertAtomFitsStoredDurations,
  assertLeadWindowCoherent,
  assertParametersInRange,
  type SiteParametersPatch,
} from '../domain/site-parameters';

import {
  ConfigurationAuditTrail,
  type Requester,
} from './configuration-audit.trail';

/**
 * The operating numbers of a site: CF-062, CF-064, CF-065, CF-066.
 *
 * CF-064 IS SATISFIED BY WHAT THIS SERVICE DOES NOT DO. Changing a parameter
 * writes one row of `site_parameter` and nothing else: no revalidation pass,
 * no query over `agenda_entry`, no cancellation. A shortened maximum lead
 * cannot un-book the appointment somebody already has, because the code that
 * would have to do it does not exist and there is a test asserting the rows
 * are untouched. Saying this out loud is the point — «rige hacia adelante» is
 * easy to break later by adding a helpful cleanup.
 */
@Injectable()
export class SiteParametersService {
  constructor(
    @Inject(SITE_PARAMETER_REPOSITORY)
    private readonly repository: SiteParameterRepository,
    private readonly trail: ConfigurationAuditTrail,
  ) {}

  /**
   * CF-062. A site always has a row — the base writes it on insert — so a
   * missing one means the site is unknown.
   */
  async get(siteId: string): Promise<SiteParameterView> {
    const parameters = await this.repository.find(siteId);
    if (!parameters) throw new SiteParametersNotFoundError();

    return parameters;
  }

  /**
   * CF-064, CF-065, CF-066.
   *
   * THE RANGES ARE CHECKED HERE AND NOT ONLY IN THE DTO. The DTO refuses what
   * is not an integer, which is the shape of the transport; the RANGE is a
   * rule of the clinic, it has to answer `PARAM_OUT_OF_RANGE` naming the range
   * (CF-065), and the same rule must hold for any future caller that is not an
   * HTTP request. The base checks it a third time, because a `psql` skips both.
   */
  async update(
    siteId: string,
    patch: SiteParametersPatch,
    requester: Requester,
  ): Promise<SiteParameterView> {
    assertParametersInRange(patch);

    /**
     * D-021, the second half of the guarantee. `assertParametersInRange` says
     * the atom is a sane increment; this says it does not strand a duration
     * somebody already configured against the atom it replaces.
     *
     * ONLY WHEN THE ATOM IS BEING TOUCHED: reading every service type on a
     * request that moves the minimum lead would be a query nothing needs, and
     * `undefined` here means «leave it as it is», which strands nothing.
     */
    if (patch.slotAtomMinutes !== undefined) {
      assertAtomFitsStoredDurations(
        patch.slotAtomMinutes,
        await this.repository.configuredDurations(),
      );
    }

    // Read before writing, so coherence is judged on the RESULT: the two lead
    // numbers can arrive in different requests, and a minimum that is fine
    // today becomes absurd the moment somebody lowers the maximum.
    const current = await this.repository.find(siteId);
    if (!current) throw new SiteParametersNotFoundError();

    // `??` and never `||`: `0` minutes of minimum lead and `false` for past
    // booking are values a site chose, and the falsy test would silently
    // replace them with what the row already had.
    assertLeadWindowCoherent({
      minLeadMinutes: patch.minLeadMinutes ?? current.minLeadMinutes,
      maxLeadDays: patch.maxLeadDays ?? current.maxLeadDays,
      overbookingCap: patch.overbookingCap ?? current.overbookingCap,
      slotAtomMinutes: patch.slotAtomMinutes ?? current.slotAtomMinutes,
      allowPastBooking: patch.allowPastBooking ?? current.allowPastBooking,
      cancelledRetention:
        patch.cancelledRetention ?? current.cancelledRetention,
    });

    const change = await this.repository.update(siteId, patch);
    // Somebody deleted the site between the read and the write. Answering 404
    // is truthful; retrying would be guessing what the caller wanted.
    if (!change) throw new SiteParametersNotFoundError();

    // AG-097, CF-066: «desde qué valor», and it is `change.before` rather than
    // the `current` read above ON PURPOSE. That read exists to judge coherence
    // and is already stale; `change.before` is the row this very statement
    // overwrote, read inside the same transaction. When two administrators
    // save at once, the two entries chain — each one's `before` is the other's
    // `after` — instead of both claiming to have started from the same value.
    await this.trail.record('UPDATE', change.after.siteId, requester, change);
    return change.after;
  }
}
