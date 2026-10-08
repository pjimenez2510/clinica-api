import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import {
  PriceListNotFoundError,
  TariffPublicationEmptyError,
  TariffPublicationNotFoundError,
} from '../domain/billing.errors';
import {
  type TariffDifference,
  tariffDifferences,
  tariffLinesOn,
} from '../domain/tariff-publication';
import {
  TARIFF_PUBLICATION_REPOSITORY,
  type TariffPublicationRepository,
  type TariffPublicationSummary,
  type TariffPublicationView,
} from '../domain/tariff-publication.repository';
import type { Requester } from './service-catalogue.service';

const RESOURCE_TYPE = 'tariff_publication';

/** BI-113, BI-115. The publications and whether the newest still holds. */
export interface TariffPublicationOverview {
  items: TariffPublicationSummary[];
  /** The one on the wall, or `null` if nothing was ever published. */
  latest: {
    id: string;
    version: number;
    /** BI-115. Empty: the wall says what the list charges today. */
    differences: TariffDifference[];
  } | null;
}

/**
 * THE TARIFF THAT IS SHOWN TO THE PUBLIC (LOS art. 184, BI-110 to BI-115).
 *
 * A service of its own, not more methods of `PricingService`: publishing is
 * an act with its own permission (`tariff:publish`) on an insert-only
 * aggregate, and the public view reads only what this service publishes.
 * Changing a price never comes through here — and that is BI-115: the wall
 * only changes when somebody publishes again.
 */
@Injectable()
export class TariffPublicationService {
  constructor(
    @Inject(TARIFF_PUBLICATION_REPOSITORY)
    private readonly publications: TariffPublicationRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * BI-111, BI-113. Copies what the self-pay list charges TODAY, in Ecuador,
   * to the next version. Nothing to show → `TARIFF_PUBLICATION_EMPTY`.
   */
  async publish(
    requester: Requester,
    now: Date = new Date(),
  ): Promise<TariffPublicationView> {
    const day = clinicalDateOf(now);
    const published = await this.publications.publish({
      effectiveFrom: day,
      publishedAt: now,
      publishedById: requester.userId,
      linesOf: (candidates) => {
        const lines = tariffLinesOn(candidates, day);
        if (lines.length === 0) throw new TariffPublicationEmptyError();
        return lines;
      },
    });
    if (published === null) throw new PriceListNotFoundError();

    // BI-046, BI-132: what the clinic tells the public it charges is
    // answerable — who published which version. NO PAYLOAD, on purpose: the
    // publication is insert-only and IS the record of what it said, so a copy
    // in the trail would only be a second, weaker one
    // (`access_audit_payload_only_for_declared_resources`).
    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: published.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    return published;
  }

  /**
   * BI-113, BI-115. Every publication, and how the newest differs from what
   * would be published now. Reading it never rewrites it.
   */
  async overview(now: Date = new Date()): Promise<TariffPublicationOverview> {
    const [items, latest] = await Promise.all([
      this.publications.listPublications(),
      this.publications.findLatestPublication(),
    ]);
    if (latest === null) return { items, latest: null };

    const source = await this.publications.findSelfPayTariff();
    const current = source === null ? [] : tariffLinesOn(source.candidates, clinicalDateOf(now)); // prettier-ignore
    return {
      items,
      latest: {
        id: latest.id,
        version: latest.version,
        differences: tariffDifferences(latest.lines, current),
      },
    };
  }

  /** BI-113. «¿Qué decía el cartel?»: one publication as it was copied. */
  async find(publicationId: string): Promise<TariffPublicationView> {
    const publication = await this.publications.findPublication(publicationId);
    if (publication === null) throw new TariffPublicationNotFoundError();
    return publication;
  }

  /**
   * BI-110, BI-112. What the public route serves: the newest publication and
   * nothing else. It takes no argument, so nothing can steer it.
   */
  async onTheWall(): Promise<TariffPublicationView> {
    const latest = await this.publications.findLatestPublication();
    if (latest === null) throw new TariffPublicationNotFoundError();
    return latest;
  }
}
