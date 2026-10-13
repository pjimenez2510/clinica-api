import { Inject, Injectable } from '@nestjs/common';

import {
  NumberingEmissionPointNotFoundError,
  NumberingReasonRequiredError,
} from '../domain/billing.errors';
import {
  numberingView,
  type NumberingView,
  type VoucherType,
} from '../domain/emission-point-numbering';
import {
  EMISSION_POINT_NUMBERING_REPOSITORY,
  type EmissionPointNumberingRepository,
} from '../domain/emission-point-numbering.repository';

export interface NumberingInput {
  nextSequential: number | null;
  previousSystemLast: number | null;
  reason: string;
}

/**
 * BI-306 to BI-309 (D-262). Where each point's numbering goes, fixed by
 * administration and read by the screen of the emission points.
 *
 * A SERVICE OF ITS OWN, not methods of `InvoicingService`: it changes when the
 * clinic changes how it migrates or sets up a point, never when an invoice
 * changes; and it is `site:manage`, a permission nobody who issues holds.
 */
@Injectable()
export class EmissionPointNumberingService {
  constructor(
    @Inject(EMISSION_POINT_NUMBERING_REPOSITORY)
    private readonly numbering: EmissionPointNumberingRepository,
  ) {}

  /** BI-309. */
  async list(siteId: string): Promise<NumberingView[]> {
    return (await this.numbering.listForSite(siteId)).map(numberingView);
  }

  /** BI-306, BI-307. */
  async fix(
    siteId: string,
    emissionPointId: string,
    documentType: VoucherType,
    input: NumberingInput,
    changedById: string,
  ): Promise<NumberingView> {
    // A point of another site is answered as one that does not exist: the
    // permission was checked for THIS site.
    if ((await this.numbering.siteOf(emissionPointId)) !== siteId) {
      throw new NumberingEmissionPointNotFoundError();
    }
    const reason = input.reason.trim();
    if (reason.length === 0) throw new NumberingReasonRequiredError();

    await this.numbering.fix({
      emissionPointId,
      documentType,
      nextSequential: input.nextSequential,
      previousSystemLast: input.previousSystemLast,
      reason,
      changedById,
    });

    const views = await this.list(siteId);
    return views.find(
      (view) =>
        view.emissionPointId === emissionPointId &&
        view.documentType === documentType,
    )!;
  }
}
