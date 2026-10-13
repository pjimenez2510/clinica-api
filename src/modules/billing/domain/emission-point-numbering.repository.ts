import type { NumberingRecord, VoucherType } from './emission-point-numbering';

export const EMISSION_POINT_NUMBERING_REPOSITORY = Symbol(
  'EMISSION_POINT_NUMBERING_REPOSITORY',
);

export interface NumberingFix {
  emissionPointId: string;
  documentType: VoucherType;
  nextSequential: number | null;
  previousSystemLast: number | null;
  reason: string;
  changedById: string;
}

/** BI-306 to BI-309. */
export interface EmissionPointNumberingRepository {
  /** Every point of the site, active or not, each with both types. */
  listForSite(siteId: string): Promise<NumberingRecord[]>;
  /** The site of a point, or `null` when it does not exist. */
  siteOf(emissionPointId: string): Promise<string | null>;
  /**
   * Writes the numbering. Throws `NumberingBelowUsedError` when the database
   * refuses a floor at or below the largest used (BI-307).
   */
  fix(change: NumberingFix): Promise<void>;
}
