import { z } from 'zod';

import {
  instruction,
  withContext,
} from '../../src/modules/assistant/application/llm-client.port.ts';
import { caseText } from '../case-text.ts';
import type { Cie10Case, CodiEspRow } from '../cases.ts';
import {
  type Catalogues,
  formatCode,
  searchCie10,
  toWhoCode,
} from '../catalogue.ts';
import { seeded } from '../stats.ts';
import type { EvalCase, EvalTask } from '../task.ts';

/** One problem and the WHO codes that are right for it, invented or from CodiEsp. */
export interface Cie10EvalCase extends EvalCase {
  phrase: string;
  /**
   * WHO CIE-10 of 4 characters, with its dot. One for an invented case; a
   * CodiEsp phrase an expert gave several codes keeps them all, so naming any
   * of them first is right (otherwise acierto@1 could not pass 1/k).
   */
  codes: string[];
}

/** The invented set as cases of the task. */
export function inventedCie10Cases(
  cases: readonly Cie10Case[],
): Cie10EvalCase[] {
  return cases.map(({ code, ...rest }) => ({ ...rest, codes: [code] }));
}

export const CIE10_PROMPT_VERSIONS = {
  A: 'cie10-a-v1',
  D: 'cie10-d-v1',
} as const;

/** The candidates arm D puts in the prompt. */
export const CIE10_CANDIDATES = 20;
const SHOWN = 5;

const answer = z.object({
  codes: z.array(z.string().min(1).max(10)).max(SHOWN),
});
type Cie10Answer = z.infer<typeof answer>;

const SYSTEM_A = instruction`Eres un médico codificador en Ecuador. Para el problema clínico que escribió un médico, propone los códigos de la CIE-10 de la OMS que lo codifican, del más probable al menos probable, hasta cinco. Escribe cada código con cuatro caracteres y punto (por ejemplo J02.9); los que no tienen subdivisión llevan X (por ejemplo I10.X). Si el problema no se puede codificar, devuelve la lista vacía.`;

const SYSTEM_D = instruction`Eres un médico codificador en Ecuador. Para el problema clínico que escribió un médico, propone los códigos de la CIE-10 de la OMS que lo codifican, del más probable al menos probable, hasta cinco. Debajo del problema va una lista de candidatos sacada del catálogo oficial: elige de ella siempre que alguno sirva. Escribe cada código exactamente como aparece en el catálogo, con cuatro caracteres y punto (J02.9, I10.X). Un código que no esté en el catálogo oficial se descartará. Si el problema no se puede codificar, devuelve la lista vacía.`;

/**
 * EV-5. The cases of CodiEsp in the WHO catalogue: each code resolved to 4
 * characters, the ones without an equivalent left out and counted, one case
 * per phrase of an article with every code it was given, and a seeded sample
 * so two runs see the same cases.
 */
export function codiEspCases(
  rows: readonly CodiEspRow[],
  cie10: ReadonlyMap<string, string>,
  { sample, seed }: { sample: number; seed: number },
): { cases: Cie10EvalCase[]; withoutEquivalent: number; total: number } {
  const byPhrase = new Map<string, Cie10EvalCase>();
  let withoutEquivalent = 0;
  for (const row of rows) {
    const code = toWhoCode(row.code, cie10);
    if (code === null) {
      withoutEquivalent += 1;
      continue;
    }
    const key = `${row.article}|${row.phrase.toLowerCase()}`;
    const known = byPhrase.get(key);
    if (known) {
      if (!known.codes.includes(code)) known.codes.push(code);
      continue;
    }
    byPhrase.set(key, {
      id: `codiesp-${row.article}-${byPhrase.size + 1}`,
      origin: 'codiesp',
      phrase: row.phrase,
      codes: [code],
    });
  }
  const resolved = [...byPhrase.values()];
  const random = seeded(seed);
  for (let i = resolved.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [resolved[i], resolved[j]] = [resolved[j]!, resolved[i]!];
  }
  return {
    cases: resolved.slice(0, sample),
    withoutEquivalent,
    total: rows.length,
  };
}

/**
 * CIE-10 by problem (D-239 §5, PLAN-ASISTENTE-IA §5): acierto@1, R@5, the
 * category of 3 characters, and invention — a code the WHO list does not
 * have, counted on what the model WROTE in both arms. Arm A shows what the
 * model wrote; arm D shows only what is in the catalogue exactly as written
 * (EV-5): the barrier removes, it never repairs, so D − A measures the
 * catalogue and not a fix of the format (review of 11-10-2026).
 */
export function cie10Task(
  catalogues: Catalogues,
): EvalTask<Cie10EvalCase, Cie10Answer> {
  const { cie10 } = catalogues;
  return {
    name: 'cie10',
    title: 'CIE-10 por problema',
    arms: ['A', 'D'],
    promptVersions: CIE10_PROMPT_VERSIONS,
    latencyBudgetMs: 5_000,
    metrics: [
      { key: 'hit1', label: 'Acierto@1', kind: 'binary', primary: true },
      { key: 'recall5', label: 'R@5', kind: 'binary', primary: true },
      { key: 'category1', label: 'Categoría@1 (3 caracteres)', kind: 'binary' },
      {
        key: 'invented',
        label: 'Códigos inexistentes escritos (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'empty',
        label: 'Sin propuesta',
        kind: 'binary',
        lowerIsBetter: true,
      },
    ],
    request(item, arm) {
      const prompt = caseText(`Problema: ${item.phrase}`);
      const base = {
        tier: 'quality' as const,
        purpose: 'eval-cie10',
        promptVersion: CIE10_PROMPT_VERSIONS[arm],
        answer,
        maxTokens: 400,
      };
      if (arm === 'A') return { ...base, system: SYSTEM_A, prompt };
      const candidates = searchCie10(item.phrase, cie10, CIE10_CANDIDATES);
      return {
        ...base,
        system: SYSTEM_D,
        prompt: withContext(
          prompt,
          [
            'Candidatos del catálogo CIE-10 OMS:',
            ...candidates.map(({ code, name }) => `- ${code} · ${name}`),
          ].join('\n'),
        ),
      };
    },
    evaluate(item, arm, value) {
      const written = value.codes.map(formatCode).slice(0, SHOWN);
      // EV-5. The barrier of D: what is not in the catalogue is not shown.
      const shown =
        arm === 'D'
          ? [...new Set(written.filter((code) => cie10.has(code)))]
          : written;
      const first = shown[0];
      const right = new Set(item.codes);
      const categories = new Set(item.codes.map((code) => code.slice(0, 3)));
      return Promise.resolve({
        shown,
        scores: {
          hit1: first !== undefined && right.has(first) ? 1 : 0,
          recall5: shown.some((code) => right.has(code)) ? 1 : 0,
          category1:
            first !== undefined && categories.has(first.slice(0, 3)) ? 1 : 0,
          invented:
            written.length === 0
              ? null
              : written.filter((code) => !cie10.has(code)).length /
                written.length,
          empty: shown.length === 0 ? 1 : 0,
        },
      });
    },
  };
}
