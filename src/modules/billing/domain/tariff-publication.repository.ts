import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { TariffCandidate, TariffLine } from './tariff-publication';

/**
 * BI-110 to BI-115. What the published tariff needs from storage.
 *
 * Its own port and not more methods on `BillingCatalogueRepository`: the
 * publication is another aggregate —a photo, insert-only— with its own
 * service, and the public route reads ONLY this. No method here takes a payer
 * or a price list: the source is always the clinic's self-pay list (BI-111),
 * chosen by the adapter, so no argument can point it at an agreement's.
 */

/** A publication without its lines. */
export interface TariffPublicationSummary {
  id: string;
  version: number;
  effectiveFrom: ClinicalDate;
  publishedAt: Date;
  publishedBy: { id: string; name: string };
  establishmentName: string | null;
  lineCount: number;
}

/** A publication with what it says, as it was copied (BI-113). */
export interface TariffPublicationView extends TariffPublicationSummary {
  lines: TariffLine[];
}

export interface NewTariffPublication {
  priceListId: string;
  effectiveFrom: ClinicalDate;
  publishedAt: Date;
  publishedById: string;
  lines: readonly TariffLine[];
}

export const TARIFF_PUBLICATION_REPOSITORY = Symbol(
  'TARIFF_PUBLICATION_REPOSITORY',
);

export interface TariffPublicationRepository {
  /**
   * BI-111. The clinic-wide, active self-pay list and every service with a
   * price in it, with all their validities; `null` when the installation has
   * no such list.
   */
  findSelfPayTariff(): Promise<{
    priceListId: string;
    candidates: TariffCandidate[];
  } | null>;

  /**
   * BI-113. Copies the lines under the list's lock, with the next version and
   * the establishment's name of today.
   */
  publish(publication: NewTariffPublication): Promise<TariffPublicationView>;

  /** BI-113. Every publication, newest first. */
  listPublications(): Promise<TariffPublicationSummary[]>;

  findPublication(publicationId: string): Promise<TariffPublicationView | null>;

  /** BI-110. The one on the wall: the highest version. */
  findLatestPublication(): Promise<TariffPublicationView | null>;
}
