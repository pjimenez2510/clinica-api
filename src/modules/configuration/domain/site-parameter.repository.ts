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

/**
 * Both sides of one write (AG-097, CF-066, D-017).
 *
 * WHY THE WRITE HANDS BACK THE PREVIOUS ROW INSTEAD OF THE SERVICE READING IT.
 * The service already reads before writing — CF-065 judges coherence on the
 * RESULT — but that read cannot be the trail's «desde qué valor»: between it
 * and the UPDATE, another administrator's request can land, and the log would
 * then claim the change started from a value it never replaced. Pairing them
 * is only honest inside the transaction that writes, and a transaction cannot
 * span two calls through this port. So the port asks for the pair.
 */
export interface SiteParameterChange {
  before: SiteParameterView;
  after: SiteParameterView;
}

export interface SiteParameterRepository {
  find(siteId: string): Promise<SiteParameterView | null>;

  /**
   * `null` when the site has no row, which means the site is unknown.
   *
   * Both sides come from ONE transaction; see `SiteParameterChange`.
   */
  update(
    siteId: string,
    patch: SiteParametersPatch,
  ): Promise<SiteParameterChange | null>;

  /**
   * D-021. Every duration the clinic has configured, in minutes, so that
   * changing the atom can be refused when it would strand one
   * (`assertAtomFitsStoredDurations`).
   *
   * IT READS TABLES THIS MODULE DOES NOT OWN — `service_type` belongs to
   * `specialties` and `duration_exception` to `staff` — and that is what a
   * port is for. `sin-imports-entre-modulos` forbids importing their code, not
   * reading rows through an adapter of our own; `agenda` already reads
   * `service_type` and `practitioner_schedule_rule` the same way, for the same
   * reason: the question is ours, the tables are theirs.
   *
   * NOT SCOPED TO THE SITE, because durations are not: a service type has no
   * `site_id`. See `clinicSlotAtom`.
   */
  configuredDurations(): Promise<readonly number[]>;
}

export const SITE_PARAMETER_REPOSITORY = Symbol('SiteParameterRepository');
