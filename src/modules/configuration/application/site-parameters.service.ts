import { Inject, Injectable } from '@nestjs/common';

import { SiteParametersNotFoundError } from '../domain/configuration.errors';
import {
  SITE_PARAMETER_REPOSITORY,
  type SiteParameterRepository,
  type SiteParameterView,
} from '../domain/site-parameter.repository';
import {
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

    // Read before writing, so coherence is judged on the RESULT: the two lead
    // numbers can arrive in different requests, and a minimum that is fine
    // today becomes absurd the moment somebody lowers the maximum.
    const current = await this.repository.find(siteId);
    if (!current) throw new SiteParametersNotFoundError();

    assertLeadWindowCoherent({
      minLeadMinutes: patch.minLeadMinutes ?? current.minLeadMinutes,
      maxLeadDays: patch.maxLeadDays ?? current.maxLeadDays,
      overbookingCap: patch.overbookingCap ?? current.overbookingCap,
      cancelledRetention:
        patch.cancelledRetention ?? current.cancelledRetention,
    });

    const updated = await this.repository.update(siteId, patch);
    // Somebody deleted the site between the read and the write. Answering 404
    // is truthful; retrying would be guessing what the caller wanted.
    if (!updated) throw new SiteParametersNotFoundError();

    await this.trail.record('UPDATE', updated.siteId, requester);
    return updated;
  }
}
