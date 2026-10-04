import type { ClinicalDate } from './clinic-time';

/**
 * PA-062. A rest certificate as the merge notice names it. Here and not in
 * `patients` or `certificates`: the merge (`patients`) reads it from the rests
 * (`certificates`) through `shared/infrastructure/prisma/rests-on-merge.ts`.
 */
export interface RestOverlapSide {
  /** CER-009. The certificate's number, which is how the desk finds it. */
  number: number;
  from: ClinicalDate;
  to: ClinicalDate;
  maternity: boolean;
}

/** PA-062. One rest of the absorbed chart over one of the survivor's. */
export interface RestOverlap {
  absorbed: RestOverlapSide;
  surviving: RestOverlapSide;
}
