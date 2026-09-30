import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type {
  ActiveAllergy,
  ActiveAllergyReader,
} from '../../clinical/patient-allergy.port';
import { chartScope } from '../prisma/patient-chart-scope';
import { PrismaService } from '../prisma/prisma.service';

/**
 * EN-081, EN-084. THE statement that answers «¿a qué es alérgica esta persona?»
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE QUERY, TWO CALLERS, AND THAT IS THE WHOLE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The consultation reads it to put the allergies in front of the doctor
 * (EN-081) and the prescription reads it to check what is being prescribed
 * (EN-084). If those were two statements they would eventually disagree, and
 * the way they would disagree is known in advance: one of them would forget
 * `chartScope` and return the allergies of the surviving chart only.
 *
 * That is not a hypothetical. `patient-chart-scope.ts` opens with the scene —
 * admissions merges two charts correctly, the absorbed one held the penicillin
 * allergy, the doctor sees none and prescribes. A merge re-points nothing
 * (D-031), so the absorbed chart's rows keep their own `patient_id` and are
 * reachable ONLY through the link. Half a clinical history, returned with no
 * error and no warning.
 *
 * `patient-chart-scope.spec.ts` walks this file and breaks the build if the
 * `where` below ever loses the scope.
 *
 * ⚠️ IT LIVES IN `shared/infrastructure` AND NOT IN `modules/encounter`
 * because `prescription` has to be able to wire it, and no module may import
 * another. `waitlist-follows-merge.ts` is here for the same reason: a rule
 * about the chart that two modules depend on is not the property of either.
 */
@Injectable()
export class PrismaActiveAllergyReader implements ActiveAllergyReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * EN-081, EN-082, EN-084. The chart's unrefuted allergies, worst first.
   *
   * `refutedAt: null` IS THE DEFINITION OF «ACTIVE» (EN-082): nothing is ever
   * deleted, so «active» is «not yet ruled out» and the refuted rows stay
   * readable through the module's own listing. The pair
   * `(patient_id, refuted_at)` is the index `patient_allergy` ships with, so
   * this predicate is the one the planner was given.
   *
   * ORDERED BY CRITICALITY AND NOT BY DATE. `HIGH` first, then `LOW`, then
   * `UNABLE_TO_ASSESS` — the enum's own declaration order reversed, written
   * out rather than relying on it, because a value inserted into the enum
   * later would silently reorder a clinical screen. Ties break by recency, so
   * the most recently recorded of two equally critical allergies reads first.
   *
   * ⚠️ THE CRITICALITY ORDER IS APPLIED HERE AND NOT IN THE `ORDER BY`, and
   * the reason is that Prisma cannot express «order by this list of enum
   * values»: `orderBy` takes a column, and the enum's storage order puts
   * `UNABLE_TO_ASSESS` last only by accident. What that costs is nothing,
   * because THIS LIST IS NEVER PAGINATED — a person has a handful of
   * allergies, and one that did not fit on the page would be the one that
   * kills. The day it ever needs a `LIMIT`, the sort has to move into the
   * statement, and this comment is the warning.
   */
  async activeFor(chartId: string): Promise<readonly ActiveAllergy[]> {
    const rows = await this.prisma.patientAllergy.findMany({
      where: { ...chartScope(chartId), refutedAt: null },
      select: ALLERGY_SELECT,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map(toActiveAllergy).sort(worstFirst);
  }
}

/**
 * What travels out of the reader.
 *
 * ⚠️ `refutedNotes` IS NOT HERE. This reader answers what is still believed
 * true; why something was ruled out is read through the module's own listing,
 * where the whole row is served. A prescription check has no use for it, and a
 * field that is never loaded cannot end up in a log.
 */
const ALLERGY_SELECT = {
  id: true,
  patientId: true,
  substanceConceptId: true,
  substanceText: true,
  reaction: true,
  criticality: true,
  recordedAt: true,
} satisfies Prisma.PatientAllergySelect;

type AllergyRow = Prisma.PatientAllergyGetPayload<{
  select: typeof ALLERGY_SELECT;
}>;

function toActiveAllergy(row: AllergyRow): ActiveAllergy {
  return {
    id: row.id,
    patientId: row.patientId,
    substanceConceptId: row.substanceConceptId,
    substanceText: row.substanceText,
    reaction: row.reaction,
    criticality: row.criticality,
    recordedAt: row.recordedAt,
  };
}

/**
 * EN-083. `HIGH` before `LOW` before `UNABLE_TO_ASSESS`, written out.
 *
 * The ranks are spelled rather than derived from the enum so that adding a
 * fourth value fails to compile here instead of quietly landing wherever the
 * database happens to put it.
 */
const CRITICALITY_RANK: Readonly<Record<ActiveAllergy['criticality'], number>> =
  { HIGH: 0, LOW: 1, UNABLE_TO_ASSESS: 2 };

/** Stable: the query already ordered by recency, and `sort` preserves it. */
function worstFirst(left: ActiveAllergy, right: ActiveAllergy): number {
  return (
    CRITICALITY_RANK[left.criticality] - CRITICALITY_RANK[right.criticality]
  );
}
