import type { EncounterRepository } from '../domain/encounter.repository';

/**
 * EN-237 (D-169.2 b). The chart an attention's history is read FROM: its own,
 * or — when admissions merged it while the consultation was still open — the
 * one that absorbed it.
 *
 * The merge does not look at attentions, so the duplicate's stays open, and
 * from it `chartScope` reads down and never up: the surviving chart's
 * penicillin allergy, its history and its earlier attentions are invisible
 * there. Resolved here, every reader below keeps its own `chartScope` and the
 * survivor's scope already contains the absorbed chart.
 *
 * ⚠️ TWO STATEMENTS AND NOT ONE, and for a SCREEN that is enough. A merge or an
 * undo landing between them leaves a read of the instant before, which the
 * next opening corrects. What must not have that gap — the check that blocks a
 * prescription (PR-060) — reads `chartScopeOfSurvivor` in one statement, and
 * the band reads that same statement (`SurvivingChartAllergyReader`).
 */
export async function chartOfRecord(
  encounters: Pick<EncounterRepository, 'findSurvivingChart'>,
  chartId: string,
): Promise<string> {
  return (await encounters.findSurvivingChart(chartId))?.id ?? chartId;
}
