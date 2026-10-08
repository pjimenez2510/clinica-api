import { clinicalDayBounds } from '../../../shared/domain/clinic-time';
import {
  type IssuedDocumentFilter,
  parseDocumentSearch,
} from '../domain/document-search';

type NumberMatch =
  | { sequential: string }
  | {
      sequential: string;
      emissionPoint: { code: string; site: { sriEstablishmentCode: string } };
    }
  | { accessKey: { contains: string } }
  | { buyerIdentification: { startsWith: string } }
  | { buyerName: { contains: string; mode: 'insensitive' } };

/**
 * BI-233, BI-234. The filter as a `where` over the columns an invoice and a
 * credit note share. A full number (`001-002-000000123`) is the series AND
 * the sequential: the site's and point's codes as they are now, or the key's
 * digits 25–39 when it has one (the number never changes after the key,
 * SRI-070). The dates are days of the clinic: `to` reaches the start of the
 * next day in Guayaquil, never UTC midnight.
 */
export function issuedDocumentWhere(filter: IssuedDocumentFilter): {
  OR?: NumberMatch[];
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
  const or = ((): NumberMatch[] | null => {
    switch (search?.kind) {
      case 'number':
        return [
          {
            sequential: search.sequential,
            emissionPoint: {
              code: search.emissionPoint,
              site: { sriEstablishmentCode: search.establishment },
            },
          },
          {
            accessKey: {
              contains: `${search.establishment}${search.emissionPoint}${search.sequential}`,
            },
          },
        ];
      case 'digits':
        return [
          ...(search.sequential ? [{ sequential: search.sequential }] : []),
          { buyerIdentification: { startsWith: search.identificationPrefix } },
        ];
      case 'name':
        return [{ buyerName: { contains: search.text, mode: 'insensitive' } }];
      default:
        return null;
    }
  })();
  return {
    ...(or ? { OR: or } : {}),
    ...(filter.issuedFrom || filter.issuedTo ? { issuedAt } : {}),
  };
}
