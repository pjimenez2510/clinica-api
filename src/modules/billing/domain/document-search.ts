import type { ClinicalDate } from '../../../shared/domain/clinic-time';

/**
 * BI-233, BI-234. How caja finds an invoice or a credit note: by the number
 * the customer reads off the paper, by who paid, and by the day it was issued.
 */
export interface IssuedDocumentFilter {
  /** A number (`123`, `000000123`, `001-001-000000123`) or the buyer. */
  search?: string;
  /** Days of the clinic, both ends included. */
  issuedFrom?: ClinicalDate;
  issuedTo?: ClinicalDate;
}

/** What a typed search means, decided once for both lists. */
export type DocumentSearch =
  | { kind: 'number'; sequential: string }
  /** Digits that may be a number or the start of a cedula or RUC. */
  | { kind: 'digits'; sequential: string | null; identificationPrefix: string }
  | { kind: 'name'; text: string };

const SEQUENTIAL_LENGTH = 9;
const FULL_NUMBER = /^(\d{3})-(\d{3})-(\d{1,9})$/;

/**
 * `001-001-000000123` is a number and nothing else. Plain digits are a
 * sequential (padded to nine) OR the beginning of an identification: «0912»
 * is both a cedula being typed and nobody's invoice. Anything else is a name.
 * `null` for an empty search: no filter.
 */
export function parseDocumentSearch(
  raw: string | undefined,
): DocumentSearch | null {
  const term = (raw ?? '').trim();
  if (term === '') return null;
  const full = FULL_NUMBER.exec(term);
  if (full) {
    return {
      kind: 'number',
      sequential: full[3]!.padStart(SEQUENTIAL_LENGTH, '0'),
    };
  }
  if (/^\d+$/.test(term)) {
    return {
      kind: 'digits',
      sequential:
        term.length <= SEQUENTIAL_LENGTH
          ? term.padStart(SEQUENTIAL_LENGTH, '0')
          : null,
      identificationPrefix: term,
    };
  }
  return { kind: 'name', text: term };
}
