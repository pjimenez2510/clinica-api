import type { z } from 'zod';

import {
  CODES_INSTRUCTIONS,
  CODES_PROMPT_VERSION,
  codesAnswer,
  problemLine,
} from '../../src/modules/assistant/application/problem-coding.prompts.ts';
import { candidateCodes } from '../../src/shared/clinical/cie10-lookup.port.ts';
import { caseText } from '../case-text.ts';
import type { CodiEspRow } from '../cases.ts';
import { formatCode, toWhoCode, type Catalogues } from '../catalogue.ts';
import type { EvalTask } from '../task.ts';

import type { Cie10EvalCase } from './cie10.ts';

/** The physician gets five (AS-035), the baseline too (AS-027). */
const SHOWN = 5;

type CodesAnswer = z.infer<typeof codesAnswer>;

/**
 * AS-042 (D1). «Proponer por problema» measured as the product runs it: the
 * prompt of `problem-coding.prompts.ts` and the barrier of AS-035
 * (`candidateCodes` against the WHO catalogue: exact, or a category through
 * its `.X`), against the baseline of AS-027 — what is coded most, with no
 * model. CodiEsp has no patient history, so the baseline here is its
 * frequency alone, counted without the case's own codes (leave one out).
 *
 * ⚠️ AS-035 REPAIRS ONE FORMAT AND `cie10` (A6) DOES NOT: `I10` is shown as
 * `I10.X` here. That is what the physician would see, so it is what this task
 * measures; A6's arm D measures the catalogue without the repair.
 *
 * Arm A is the model's answer as written; arm D is what the screen shows.
 * `invented` counts what the model wrote, in both. That nothing invented is
 * SHOWN is the barrier's guarantee, tested against PostgreSQL (AS-035): here
 * it would be 0 by construction, so it is not a metric (review 11-10-2026).
 *
 * What this measures is the coding step, with the expert's phrase as the
 * problem; naming problems out of a note has no reference set yet (phase F).
 */
export function cie10ByProblemTask(
  catalogues: Catalogues,
  cases: readonly Cie10EvalCase[],
  codiesp: readonly CodiEspRow[] = [],
): EvalTask<Cie10EvalCase, CodesAnswer> {
  const { cie10 } = catalogues;
  // AS-027. «What the clinic codes most»: for CodiEsp, the whole corpus —
  // every phrase of train and dev, in the WHO list — less the case's own
  // article, which is the patient being coded (leave one article out); for
  // the invented set, the set itself less the case. Counted inside a sample
  // of 60 phrases nothing repeats, and the baseline would read 0 for want of
  // a clinic, not for want of skill.
  const corpus = new Map<string, number>();
  const byArticle = new Map<string, Map<string, number>>();
  for (const row of codiesp) {
    const code = toWhoCode(row.code, cie10);
    if (code === null) continue;
    corpus.set(code, (corpus.get(code) ?? 0) + 1);
    const own = byArticle.get(row.article) ?? new Map<string, number>();
    own.set(code, (own.get(code) ?? 0) + 1);
    byArticle.set(row.article, own);
  }
  const invented = new Map<string, number>();
  for (const item of cases) {
    if (item.origin !== 'invented') continue;
    for (const code of item.codes) invented.set(code, (invented.get(code) ?? 0) + 1); // prettier-ignore
  }
  const top = (counts: Iterable<readonly [string, number]>): string[] =>
    [...counts]
      .filter(([, times]) => times > 0)
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .slice(0, SHOWN)
      .map(([code]) => code);
  const baselineOf = (item: Cie10EvalCase): string[] => {
    if (item.origin === 'invented') {
      const own = new Set(item.codes);
      return top([...invented].map(([code, times]) => [code, own.has(code) ? times - 1 : times] as const)); // prettier-ignore
    }
    const article = articleOf(item.id);
    const own = byArticle.get(article) ?? new Map<string, number>();
    return top([...corpus].map(([code, times]) => [code, times - (own.get(code) ?? 0)] as const)); // prettier-ignore
  };
  const resolve = (written: string): string | null =>
    candidateCodes(written).find((form) => cie10.has(form)) ?? null;

  return {
    name: 'cie10-problema',
    title: 'CIE-10 por problema (D1) frente a la línea base',
    arms: ['A', 'D'],
    promptVersions: { A: CODES_PROMPT_VERSION, D: CODES_PROMPT_VERSION },
    latencyBudgetMs: 5_000,
    metrics: [
      { key: 'recall5', label: 'R@5', kind: 'binary', primary: true },
      { key: 'baselineRecall5', label: 'R@5 de la línea base', kind: 'binary' },
      {
        key: 'gainOverBaseline',
        label: 'R@5 menos el de la línea base (por caso)',
        kind: 'mean',
        primary: true,
      },
      { key: 'hit1', label: 'Acierto@1', kind: 'binary' },
      { key: 'category5', label: 'Categoría en las 5 (3 caracteres)', kind: 'binary' }, // prettier-ignore
      {
        key: 'invented',
        label: 'Códigos inexistentes escritos (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
      },
      {
        key: 'baselineCategory5',
        label: 'Categoría en las 5 de la línea base (3 caracteres)',
        kind: 'binary',
      },
    ],
    request(item) {
      return {
        tier: 'quality',
        purpose: 'eval-cie10-problema',
        promptVersion: CODES_PROMPT_VERSION,
        system: CODES_INSTRUCTIONS,
        prompt: caseText(problemLine(item.phrase)),
        answer: codesAnswer,
        maxTokens: 1500,
      };
    },
    evaluate(item, arm, value) {
      const written = value.codes.slice(0, SHOWN);
      // AS-035. The barrier of the product: resolved, deduplicated, or gone.
      const shown =
        arm === 'D'
          ? [...new Set(written.map(resolve).filter((c) => c !== null))]
          : written.map(formatCode);
      const right = new Set(item.codes);
      const categories = new Set(item.codes.map((code) => code.slice(0, 3)));
      const inCategory = (codes: readonly string[]) =>
        codes.some((code) => categories.has(code.slice(0, 3))) ? 1 : 0;
      const recall5 = shown.some((code) => right.has(code)) ? 1 : 0;
      // The invented set has no history and each code once: no baseline.
      const baseline = item.origin === 'invented' ? null : baselineOf(item);
      const baselineRecall5 =
        baseline === null ? null : baseline.some((code) => right.has(code)) ? 1 : 0; // prettier-ignore
      return Promise.resolve({
        shown,
        scores: {
          recall5,
          baselineRecall5,
          gainOverBaseline:
            baselineRecall5 === null ? null : recall5 - baselineRecall5,
          hit1: shown[0] !== undefined && right.has(shown[0]) ? 1 : 0,
          category5: inCategory(shown),
          baselineCategory5: baseline === null ? null : inCategory(baseline),
          // What the model WROTE that the WHO list does not have; that none
          // of it is shown is AS-035's, proven against the database.
          invented:
            written.length === 0
              ? null
              : written.filter((code) => resolve(code) === null).length /
                written.length,
        },
      });
    },
  };
}

/** `codiesp-<article>-<n>` (codiEspCases) → the article, which has dashes too. */
function articleOf(id: string): string {
  return id.replace(/^codiesp-/, '').replace(/-\d+$/, '');
}
