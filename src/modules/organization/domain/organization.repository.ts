/**
 * What administering the establishment and its sites needs from storage,
 * stated without naming a database.
 *
 * WHAT IS DELIBERATELY ABSENT: any "does this MSP code already exist?" query.
 * OR-002 is a unique index; a check-first method would be an invitation to
 * read, decide and lose the race the index exists to close. The adapter lets
 * PostgreSQL arbitrate and translates the refusal into `MSP_UNICODE_DUPLICATE`.
 */

/** The establishment as the administration screen shows it (OR-001, OR-003). */
export interface EstablishmentView {
  id: string;
  /** The code the RDACAA demands in every attention (REQ-020, OR-003). */
  mspUnicode: string;
  /** MSP typology of A.M. 00000079 (OR-001). */
  typology: string;
  legalName: string;
  /** Validated by the `Ruc` value object before it gets here (OR-008). */
  ruc: string | null;
  /** OR-028. `dirMatriz` of every electronic voucher. */
  headOfficeAddress: string | null;
  /** OR-029. The fiscal flags the RIDE prints and the voucher declares. */
  keepsAccounting: boolean;
  specialTaxpayerResolution: string | null;
  withholdingAgentResolution: string | null;
  rimpeRegime: RimpeRegime;
  /**
   * OR-031. When a person last declared the fiscal flags; `null` while
   * nobody has, and then no voucher is prepared (SRI-008).
   */
  fiscalProfileDeclaredAt: Date | null;
  active: boolean;
}

/** OR-029. The SRI's RIMPE regime, as the schema's enum says it. */
export type RimpeRegime = 'NONE' | 'ENTREPRENEUR' | 'POPULAR_BUSINESS';

/** A site as the administration and selection screens list it (OR-004). */
export interface SiteView {
  id: string;
  establishmentId: string | null;
  mspUnicode: string;
  name: string;
  ruc: string | null;
  /** Parish of the INEC's DPA, from `catalogs` (OR-004). */
  parishConceptId: string | null;
  addressLine: string | null;
  phone: string | null;
  /** OR-027. The SRI's establishment code: three digits, leading zero kept. */
  sriEstablishmentCode: string | null;
  active: boolean;
}

/** Everything the establishment form writes (OR-001, OR-008, OR-028). */
export interface EstablishmentInput {
  mspUnicode: string;
  typology: string;
  legalName: string;
  ruc: string | null;
  headOfficeAddress: string | null;
  keepsAccounting: boolean;
  specialTaxpayerResolution: string | null;
  withholdingAgentResolution: string | null;
  rimpeRegime: RimpeRegime;
  /** OR-031. This save states the fiscal flags; the adapter stamps the instant. */
  declaresFiscalProfile: boolean;
  active: boolean;
}

/**
 * OR-004: what a new site row carries, with the RUC already validated (OR-008)
 * and the establishment already resolved.
 */
export interface SiteInput {
  mspUnicode: string;
  establishmentId: string | null;
  name: string;
  ruc: string | null;
  parishConceptId: string | null;
  addressLine: string | null;
  phone: string | null;
  sriEstablishmentCode: string | null;
}

/**
 * The sites a caller may see, already resolved from their grants.
 *
 * `'all'` and not an empty array for "no filter": an empty array is a real and
 * different answer — the permission is held at no site at all — and collapsing
 * the two is how a denial turns into a listing of the whole clinic. Same shape
 * and same reasoning as the agenda's `SiteScopeFilter`; each module states it
 * for itself rather than importing another module's type.
 */
export type SiteScopeFilter = 'all' | readonly string[];

/**
 * Absent fields are left untouched; `null` clears an optional one. The MSP code
 * is not here: it cannot be edited.
 */
export interface SitePatch {
  name?: string;
  ruc?: string | null;
  parishConceptId?: string | null;
  addressLine?: string | null;
  phone?: string | null;
  /** OR-027. */
  sriEstablishmentCode?: string | null;
  active?: boolean;
}

/**
 * The establishment and its sites (OR-001..OR-008). Duplicates and references
 * are arbitrated by the database and translated by the adapter, never checked
 * first.
 */
export interface OrganizationRepository {
  /**
   * The establishment, or `null` when none has been registered.
   *
   * SINGULAR ON PURPOSE. The clinic is one establishment with one or more
   * sites (ADR-011); the table admits several so that a group of clinics
   * sharing an installation is a data change rather than a migration, and
   * this method returns the oldest one, which is the one the screens mean.
   */
  findEstablishment(): Promise<EstablishmentView | null>;

  /** Throws `MspUnicodeDuplicateError` when the unique index refuses (OR-002). */
  createEstablishment(input: EstablishmentInput): Promise<EstablishmentView>;

  /** `null` when the row is gone; the service owns the refusal. */
  updateEstablishment(
    id: string,
    input: EstablishmentInput,
  ): Promise<EstablishmentView | null>;

  /**
   * OR-007: `includeInactive` decides whether deactivated sites travel.
   *
   * `scope` is the SITE dimension of ADR-007, and it is a required argument on
   * purpose. The listing has no site in its URL, so the guard cannot narrow
   * it; leaving the narrowing optional is how `GET /organization/sites` ended
   * up serving the name, MSP code, RUC, address and phone of every site of the
   * clinic to a caller scoped to one city — while `GET /sites/:id` correctly
   * refused the very same row. `'all'` is the answer for a clinic-wide grant
   * and has to be spelled out.
   */
  listSites(
    includeInactive: boolean,
    scope: SiteScopeFilter,
  ): Promise<readonly SiteView[]>;

  findSite(id: string): Promise<SiteView | null>;

  /** Throws `MspUnicodeDuplicateError` on a repeated MSP code (OR-002). */
  createSite(input: SiteInput): Promise<SiteView>;

  updateSite(id: string, patch: SitePatch): Promise<SiteView | null>;

  /**
   * Hard delete (OR-006). `false` when the row does not exist; throws
   * `SiteInUseError` when a FK RESTRICT refuses, which is what offers
   * deactivation instead.
   */
  deleteSite(id: string): Promise<boolean>;
}

export const ORGANIZATION_REPOSITORY = Symbol('OrganizationRepository');
