import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  candidateCodes,
  type Cie10Entry,
  type Cie10Lookup,
} from '../../clinical/cie10-lookup.port';
import { PrismaService } from '../prisma/prisma.service';

/** The WHO four-character codes are level 3 of the imported tree. */
const SELECTABLE_LEVEL = 3;

/**
 * AS-035. One statement for every written code: the candidates of each
 * (`candidateCodes`), looked up at once among the selectable codes of the
 * CIE-10 in force on the clinical date — the same `valid_period` the
 * diagnosis trigger checks, so what passes here the record accepts.
 */
@Injectable()
export class PrismaCie10Lookup implements Cie10Lookup {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWritten(
    codes: readonly string[],
    clinicalDate: string,
  ): Promise<(Cie10Entry | null)[]> {
    const candidates = codes.map(candidateCodes);
    const wanted = [...new Set(candidates.flat())];
    if (wanted.length === 0) return codes.map(() => null);

    const rows = await this.prisma.$queryRaw<Cie10Entry[]>`
      SELECT c.id::text AS "conceptId", c.code, c.display
        FROM catalog_concept c
        JOIN catalog_system s ON s.id = c.system_id
       WHERE s.code = 'CIE10'
         AND c.code IN (${Prisma.join(wanted)})
         AND COALESCE((c.attributes->>'level')::int, 0) = ${SELECTABLE_LEVEL}
         AND c.valid_period @> ${clinicalDate}::date`;
    const byCode = new Map(rows.map((row) => [row.code, row]));

    return candidates.map(
      (forms) =>
        forms.map((form) => byCode.get(form)).find((row) => row) ?? null,
    );
  }
}
