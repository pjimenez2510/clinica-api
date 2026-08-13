import type { SiteParameters, SiteParametersPatch } from './site-parameters';

/**
 * What administering a site's operating numbers needs from storage.
 *
 * NO `create`. The row is written by the database when the site is inserted
 * (`trg_site_parameter_defaults`, CF-062), so an application-level create
 * would be a second way for the defaults to exist — and the day the two
 * disagreed, the answer to «what does this site do by default?» would depend
 * on who inserted the site.
 */

export interface SiteParameterView extends SiteParameters {
  siteId: string;
}

export interface SiteParameterRepository {
  find(siteId: string): Promise<SiteParameterView | null>;

  /** `null` when the site has no row, which means the site is unknown. */
  update(
    siteId: string,
    patch: SiteParametersPatch,
  ): Promise<SiteParameterView | null>;
}

export const SITE_PARAMETER_REPOSITORY = Symbol('SiteParameterRepository');
