/**
 * EN-084. The active allergies of a chart, for whoever has to check them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SHARED PORT AND NOT A METHOD ON THE ENCOUNTER REPOSITORY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patient_allergy` is written and read by `encounter` — REQ-008 demands the
 * allergies be visible «de manera permanente durante la consulta», and the
 * consultation is that module. But the half of REQ-008 that saves a life is
 * the CHECK AT PRESCRIBING TIME, and that lives in `prescription`.
 *
 * No module imports another (`sin-imports-entre-modulos`), so the datum has to
 * cross through `shared/` or not cross at all. The alternative anybody reaches
 * for first — `prescription` writing its own `prisma.patientAllergy.findMany`
 * — is the failure this file exists to prevent: TWO STATEMENTS OF ONE
 * PREDICATE. And the predicate is not the obvious one. «Active allergies of a
 * chart» means the chart AND the charts it absorbed (`chartScope`, PA-055),
 * because a merge re-points nothing (D-031) — so the naive second copy returns
 * half the list, silently, and the half it drops is the penicillin allergy of
 * the absorbed chart. That is PA-009 with a prescription at the end of it.
 *
 * So there is ONE reader, in `shared/infrastructure/clinical`, and both the
 * doctor's screen and the prescriber's check are answered by the same
 * statement. `PrescriptionModule` wires it exactly as `EncounterModule` does:
 *
 * ```ts
 * { provide: ACTIVE_ALLERGY_READER, useClass: PrismaActiveAllergyReader }
 * ```
 *
 * ⚠️ IT READS AND IT NEVER WRITES. Recording an allergy is a clinical act with
 * its own route, its own permission and its own audit entry, and it belongs to
 * the module that owns the consultation. A port that could also write would
 * eventually be how a prescription screen «corrects» an allergy in passing.
 */

/**
 * EN-083. How bad the reaction is, in the three values `AllergyCriticality`
 * has.
 *
 * ⚠️ THE DEFAULT IS `UNABLE_TO_ASSESS` AND IT IS DELIBERATE. It says «nadie lo
 * evaluó», never «es leve»: it is the same decision `NOT_APPLIED` makes in the
 * violence screening, and the opposite of what a pre-filled `LOW` would do. §7
 * bis of `FLUJO-DE-LA-ATENCION.md` measured that cost — of 324 safety events
 * attributed to pre-loaded values, 128 were simply not changing the value that
 * came set, the single dominant failure.
 *
 * WRITTEN AS A UNION AND NOT IMPORTED FROM `@prisma/client`: a shared port is
 * read by domain code, which may not know an ORM exists.
 */
export type AllergyCriticality = 'LOW' | 'HIGH' | 'UNABLE_TO_ASSESS';

/**
 * One allergy that has NOT been refuted, as anybody checking it reads it.
 *
 * ⚠️ `substanceConceptId` IS THE FIELD A PRESCRIPTION CHECKS AGAINST, and
 * `substanceText` is the one a human reads. The schema splits them on purpose:
 * the CNMB concept when the allergen is a drug, free text when it is not —
 * foods, latex, insect stings — and only the first can be compared to what is
 * being prescribed. Matching on the text would make «Penicilina»,
 * «penicilina» and «PENICILINA G» three different substances, which is the
 * same defect free-text CIE-10 codes produce in the monthly report (EN-040).
 *
 * NO PATIENT NAME AND NO CHART NUMBER: the caller already holds the chart id
 * it asked with, and a name that is never loaded cannot reach a log.
 */
export interface ActiveAllergy {
  id: string;
  /**
   * The chart the allergy was WRITTEN ON, which after a merge may be the
   * absorbed one and not the one that was asked about (D-031). Carried so a
   * caller can tell the two apart; nothing needs it to match its request.
   */
  patientId: string;
  /** EN-080. The CNMB concept when the allergen is a drug, `null` otherwise. */
  substanceConceptId: string | null;
  /** EN-080. Always present, including when the concept is: it is the label. */
  substanceText: string;
  reaction: string | null;
  criticality: AllergyCriticality;
  recordedAt: Date;
}

/**
 * Read-only access to the allergies a prescriber must see, for modules that do
 * not own `patient_allergy` (EN-081, EN-084).
 */
export interface ActiveAllergyReader {
  /**
   * EN-081, EN-084. The chart's unrefuted allergies, worst first.
   *
   * ⚠️ THE CHART AND THE CHARTS IT ABSORBED. The implementation resolves the
   * scope; a caller must never pre-resolve it, and must never pass a list.
   *
   * WORST FIRST because the caller that matters is a person reading a screen
   * mid-consultation, and `HIGH` is the one that changes what they do. A list
   * ordered by insertion buries it behind whatever was typed first.
   *
   * AN EMPTY LIST IS AN ANSWER, never an error: «no consta ninguna alergia» is
   * information, and it is not the same as «no se preguntó» — which this
   * system cannot yet distinguish and does not pretend to.
   */
  activeFor(chartId: string): Promise<readonly ActiveAllergy[]>;
}

/** Injection token. No caller ever names the adapter. */
export const ACTIVE_ALLERGY_READER = Symbol('ActiveAllergyReader');

/**
 * PR-118 (D-169.2). The allergies a PRESCRIPTION checks: those of the person,
 * from whichever of her charts the attention was opened on.
 *
 * ⚠️ A SEPARATE PORT AND NOT A SECOND METHOD OF `ActiveAllergyReader`, because
 * the two answer different questions. `activeFor` is «what this chart and the
 * ones it absorbed say» — the band of an attention reads it. This one also
 * climbs to the chart that absorbed the one asked about: an attention opened
 * on a duplicate that admissions merged afterwards is still open (the merge
 * does not look at attentions), and the surviving chart's allergy has to stop
 * the prescription written in it. The same adapter answers both, so the
 * predicate is still written once (`patient-chart-scope.ts`).
 */
export interface SurvivingChartAllergyReader {
  /**
   * PR-027, PR-060, PR-062, PR-067, PR-118. The unrefuted allergies of the
   * surviving chart of `chartId` and of every chart it absorbed, worst first.
   * For a chart nobody absorbed it is exactly `activeFor`.
   */
  activeForSurvivorOf(chartId: string): Promise<readonly ActiveAllergy[]>;
}

/** Injection token. No caller ever names the adapter. */
export const SURVIVING_CHART_ALLERGY_READER = Symbol(
  'SurvivingChartAllergyReader',
);
