import { clinicalDayBounds } from '../../../shared/domain/clinic-time';
import {
  type IssuedDocumentFilter,
  parseDocumentSearch,
} from '../domain/document-search';

/**
 * BI-233, BI-234. The filter as a `where` over the columns an invoice and a
 * credit note share (`sequential`, `buyer_name`, `buyer_identification`,
 * `issued_at`). The dates are days of the clinic: `to` reaches the start of
 * the next day in Guayaquil, never UTC midnight.
 */
export function issuedDocumentWhere(filter: IssuedDocumentFilter): {
  OR?: (
    | { sequential: string }
    | { buyerIdentification: { startsWith: string } }
    | { buyerName: { contains: string; mode: 'insensitive' } }
  )[];
  sequential?: string;
  issuedAt?: { gte?: Date; lt?: Date };
} {
  const search = parseDocumentSearch(filter.search);
  const issuedAt = {
    ...(filter.issuedFrom
      ? { gte: clinicalDayBounds(filter.issuedFrom).startsAt }
      : {}),
    ...(filter.issuedTo
      ? { lt: clinicalDayBounds(filter.issuedTo).endsAtExclusive }
      : {}),
  };
  return {
    ...(search?.kind === 'number' ? { sequential: search.sequential } : {}),
    ...(search?.kind === 'digits'
      ? {
          OR: [
            ...(search.sequential ? [{ sequential: search.sequential }] : []),
            {
              buyerIdentification: { startsWith: search.identificationPrefix },
            },
          ],
        }
      : {}),
    ...(search?.kind === 'name'
      ? {
          OR: [
            {
              buyerName: {
                contains: search.text,
                mode: 'insensitive' as const,
              },
            },
          ],
        }
      : {}),
    ...(filter.issuedFrom || filter.issuedTo ? { issuedAt } : {}),
  };
}
