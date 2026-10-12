import type { Prisma } from '@prisma/client';

import {
  substanceKeysOf,
  withComponents,
  type SubstanceKeys,
} from '../../clinical/allergy-match';

/** The catalogue system of the cuadro (`catalog_system.code`). */
const CNMB = 'CNMB';

/**
 * PR-114, AS-069. The keys of each CNMB concept named, of whatever edition: the code
 * and the codes it replaces. A pooled client or a transaction, so the issue
 * reads them with the allergies they are compared with.
 */
export async function substanceKeysIn(
  client: Prisma.TransactionClient,
  conceptIds: readonly string[],
): Promise<SubstanceKeys> {
  if (conceptIds.length === 0) return new Map();
  const concepts = await client.catalogConcept.findMany({
    where: { id: { in: [...new Set(conceptIds)] }, system: { code: CNMB } },
    select: { id: true, code: true, display: true, attributes: true },
  });
  /**
   * PR-114. A concept of an earlier cuadro also carries the substances of the
   * concepts that name it in `replaces`: the development «Diclofenaco sódico»
   * is the official diclofenac, eye drops included, though its own name is
   * not the DCI the cuadro writes.
   */
  const successors = await client.$queryRaw<
    { replaced: string; successor: string; substances: unknown }[]
  >`
    SELECT r.code AS replaced, c.code AS successor,
           c.attributes -> 'substances' AS substances
      FROM catalog_concept c
      JOIN catalog_system s ON s.id = c.system_id AND s.code = ${CNMB}
     CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(c.attributes -> 'replaces') = 'array'
                 THEN c.attributes -> 'replaces' ELSE '[]'::jsonb END) AS r(code)
     WHERE r.code = ANY(${concepts.map((concept) => concept.code)}::text[])
  `;
  return new Map(
    concepts.map((concept) => {
      const inherited = successors
        .filter((row) => row.replaced === concept.code)
        .flatMap((row) => [
          // PR-065. The successor's code is its ATC: an allergy recorded
          // against the development cuadro has a class through it.
          row.successor,
          ...(Array.isArray(row.substances)
            ? row.substances.filter(
                (value): value is string => typeof value === 'string',
              )
            : []),
        ]);
      return [
        concept.id,
        withComponents([...substanceKeysOf(concept), ...inherited]),
      ];
    }),
  );
}
