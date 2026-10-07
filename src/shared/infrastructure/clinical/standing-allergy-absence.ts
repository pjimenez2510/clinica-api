import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AllergyAbsenceReader } from '../../clinical/allergy-absence.port';
import type { StandingAllergyAbsence } from '../../clinical/allergy-history';
import { chartScope } from '../prisma/patient-chart-scope';
import { PrismaService } from '../prisma/prisma.service';

/**
 * EN-087. THE statement that answers «¿sigue en pie un "sin alergias
 * conocidas" en esta ficha?» — for the attention's band (`encounter`), the
 * receta's screen (`prescription`) and the receta's paper (`documents`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO READS, AND THE SECOND ONE IS THE REQUIREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The latest assertion is not automatically the current answer. An allergy
 * recorded AFTER it is the chart's newer word on the subject, and it keeps
 * being the newer word even once that allergy is refuted: asserted in March,
 * penicillin in April, ruled out in May leaves an empty chart that NOBODY HAS
 * ASKED ABOUT SINCE. Serving March's assertion there would be the system
 * asserting «sin alergias conocidas» on its own initiative, which is the one
 * thing HL7's definition forbids by name.
 *
 * ⚠️ BOTH READS GO THROUGH `chartScope`. The assertion may have been written
 * on a chart that was later absorbed, and — more dangerous — the allergy that
 * supersedes it may live on one. A bare `patient_id` on the second read
 * silently keeps a stale «ninguna» alive over the absorbed chart's penicillin
 * allergy, which is PA-009 with a prescription at the end of it.
 *
 * ORDERED BY `asserted_at` AND THEN BY `id`. `uuidv7()` is time-ordered, so
 * the tie-break is still «the last one written» when two assertions share an
 * instant — which two requests in the same millisecond can.
 *
 * ONE FUNCTION AND NOT ONE PER MODULE (D-157.2): the receta printing «sin
 * alergias conocidas» where the band says «no registradas» is exactly the
 * disagreement a second copy of this rule would produce.
 */
export async function findStandingAllergyAbsence(
  db: Prisma.TransactionClient,
  chartId: string,
): Promise<StandingAbsenceRow | null> {
  const assertion = await db.patientAllergyAbsence.findFirst({
    where: { ...chartScope(chartId) },
    select: { ...STANDING_ABSENCE_SELECT, retractedAt: true },
    orderBy: [{ assertedAt: 'desc' }, { id: 'desc' }],
  });
  // EN-226. The chart's last word was withdrawn: «no se preguntó», and an
  // older assertion does not come back behind it.
  if (assertion === null || assertion.retractedAt !== null) return null;

  // EN-224. An allergy recorded after it supersedes it — and so does one
  // that is ACTIVE now although recorded before: one reactivated after the
  // assertion, or one that came with a chart merged in later.
  const supersedingAllergies = await db.patientAllergy.count({
    where: {
      ...chartScope(chartId),
      OR: [{ recordedAt: { gt: assertion.assertedAt } }, { refutedAt: null }],
    },
  });
  if (supersedingAllergies > 0) return null;

  return {
    id: assertion.id,
    patientId: assertion.patientId,
    assertedById: assertion.assertedById,
    assertedAt: assertion.assertedAt,
    assertedBy: assertion.assertedBy,
  };
}

/** What a standing assertion carries: the asserter's name and nothing else of the account. */
export const STANDING_ABSENCE_SELECT = {
  id: true,
  patientId: true,
  assertedById: true,
  assertedAt: true,
  assertedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.PatientAllergyAbsenceSelect;

/** The row `STANDING_ABSENCE_SELECT` yields. */
export type StandingAbsenceRow = Prisma.PatientAllergyAbsenceGetPayload<{
  select: typeof STANDING_ABSENCE_SELECT;
}>;

/**
 * EN-087. The name as the band reads it. `trim()` because the join is a
 * single space and a stray trailing blank in the account would put a double
 * space in the middle of the line.
 */
export function asserterNameOf(row: StandingAbsenceRow): string {
  return `${row.assertedBy.firstName} ${row.assertedBy.lastName}`.trim();
}

/** EN-087, PR-117. `AllergyAbsenceReader` over PostgreSQL. */
@Injectable()
export class PrismaAllergyAbsenceReader implements AllergyAbsenceReader {
  constructor(private readonly prisma: PrismaService) {}

  async standingAbsenceFor(
    chartId: string,
  ): Promise<StandingAllergyAbsence | null> {
    const row = await findStandingAllergyAbsence(this.prisma, chartId);
    return row === null
      ? null
      : { assertedByName: asserterNameOf(row), assertedAt: row.assertedAt };
  }
}
