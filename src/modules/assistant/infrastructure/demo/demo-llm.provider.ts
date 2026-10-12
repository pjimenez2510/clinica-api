import type { z } from 'zod';

import type {
  LlmProvider,
  LlmRequest,
  ProviderAnswer,
} from '../../application/llm-client.port';
import {
  LINES_PURPOSE,
  MAPPING_PURPOSE,
} from '../../application/prescription-reading.prompts';
import {
  CODES_PURPOSE,
  PROBLEMS_PURPOSE,
} from '../../application/problem-coding.prompts';
import { LlmCallFailed } from '../../domain/assistant.errors';
import type { ModelTier } from '../../domain/llm-outcome';
import type { ModelPrice } from '../../domain/pricing';

import script from './demo-script.json';

/** The model `ai_run` names for the demonstration: never a real one. */
export const DEMO_MODEL = 'guion-de-demostracion';

/**
 * AS-029. The fake costs nothing, and says so in a price of its own that is
 * never written in `llm-pricing.json`: that table is what the real chain is
 * billed by.
 */
export const DEMO_PRICES: readonly ModelPrice[] = [
  {
    model: DEMO_MODEL,
    provider: 'fake',
    validFrom: '2000-01-01',
    inputPerMillion: 0,
    outputPerMillion: 0,
    cacheReadPerMillion: 0,
    cacheWritePerMillion: 0,
    currency: 'USD',
    asOf: '2026-10-11',
    source: 'AS-029: modo de demostración, sin proveedor',
  },
];

const QUOTE_REACH = 60;

/**
 * AS-029. The provider of the demonstration mode: it answers from
 * `demo-script.json`, by what the text contains, with no model and no
 * network. It answers through the request's own schema, like a real
 * provider, so a script that drifted from the prompt fails as
 * `invalid-answer` instead of reaching the screen.
 *
 * `ai_run` records it as provider `fake` and model `guion-de-demostracion`;
 * the proposals it makes carry `demo: true` and the screen says so.
 */
export class DemoLlmProvider implements LlmProvider {
  readonly name = 'fake' as const;

  modelFor(tier: ModelTier): string {
    void tier;
    return DEMO_MODEL;
  }

  generate<Shape extends z.ZodType>(
    request: LlmRequest<Shape>,
  ): Promise<ProviderAnswer<z.infer<Shape>>> {
    const value = this.answerFor(request.purpose, request.prompt);
    const raw = JSON.stringify(value);
    const parsed = request.answer.safeParse(value);
    if (!parsed.success) {
      return Promise.reject(
        new LlmCallFailed(this.name, 'invalid-answer', {
          model: DEMO_MODEL,
          raw,
          status: 200,
        }),
      );
    }
    return Promise.resolve({
      value: parsed.data,
      model: DEMO_MODEL,
      raw,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  private answerFor(purpose: string, prompt: string): unknown {
    if (purpose === PROBLEMS_PURPOSE) return { problems: problemsIn(prompt) };
    if (purpose === CODES_PURPOSE) {
      const problem = /«(.+)»/.exec(prompt)?.[1] ?? '';
      const codes = (script.codes as Record<string, string[]>)[problem] ?? [];
      return { codes };
    }
    if (purpose === LINES_PURPOSE) return { lines: linesIn(noteOf(prompt)) };
    if (purpose === MAPPING_PURPOSE) return { choices: choicesIn(prompt) };
    return {};
  }
}

/**
 * The problems whose phrase the text contains, each once, quoted as the text
 * writes it: from the phrase to the end of its sentence, as a physician would
 * underline it.
 */
function problemsIn(text: string): { problem: string; quote: string }[] {
  const lower = text.toLowerCase();
  const named = new Map<string, string>();
  for (const { phrase, problem } of script.problems) {
    const at = lower.indexOf(phrase.toLowerCase());
    if (at < 0 || named.has(problem)) continue;
    const rest = text.slice(at, at + QUOTE_REACH);
    const end = rest.search(/[.;\n]/);
    named.set(problem, (end > 0 ? rest.slice(0, end) : rest).trim());
  }
  return [...named].map(([problem, quote]) => ({ problem, quote }));
}

/** The note of a prompt: what is between <nota> and </nota>, not the lists after it. */
function noteOf(prompt: string): string {
  return /<nota>([\s\S]*?)<\/nota>/.exec(prompt)?.[1] ?? prompt;
}

/**
 * AS-029, AS-063. The receta of the script: each medicine whose name the
 * note writes, quoted to the end of its sentence, its fields read from that
 * sentence with a few plain patterns. Nothing calculated, like the prompt
 * asks of a model.
 */
function linesIn(text: string) {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const lines = [];
  for (const { phrase, drug } of script.medicines) {
    const at = lower.indexOf(phrase.toLowerCase());
    if (at < 0 || seen.has(drug)) continue;
    seen.add(drug);
    const rest = text.slice(at, at + QUOTE_REACH * 2);
    const end = rest.search(/[.;\n]/);
    const quote = (end > 0 ? rest.slice(0, end) : rest).trim();
    const folded = quote.toLowerCase();
    const strength = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|g)\b/.exec(folded);
    const hours = /cada\s+(4|6|8|12)\s+horas/.exec(folded)?.[1];
    const days = /por\s+(\d+)\s+d[ií]as/.exec(folded)?.[1];
    const tablets = /\b(una|1|dos|2)\s+tabletas?\b/.exec(folded)?.[1];
    lines.push({
      drug,
      strength: strength ? `${strength[1]} ${strength[2]}` : null,
      form: /tableta/.test(folded) ? 'TABLET' : null,
      doseAmount: tablets ? (/(dos|2)/.test(tablets) ? 2 : 1) : null,
      doseUnit: tablets ? 'TABLET' : null,
      route: null,
      frequency: hours
        ? `EVERY_${hours}_HOURS`
        : /una vez al d[ií]a|cada d[ií]a/.test(folded)
          ? 'ONCE_DAILY'
          : null,
      frequencyText: null,
      durationDays: days ? Number(days) : null,
      instructions: null,
      quote,
    });
  }
  return lines;
}

/**
 * AS-029, AS-064. The script's choice: the first candidate of each line, in
 * the presentation whose concentration is the one written, else none.
 */
function choicesIn(prompt: string) {
  const written = [
    ...prompt.matchAll(
      /^(\d+)\. Medicamento: «[^»]*» · Concentración: «([^»]*)»/gm,
    ),
  ];
  return written.map(([, line, strength]) => {
    const block =
      new RegExp(
        `Para la línea ${line}:\\n([\\s\\S]*?)(?=\\nPara la línea|$)`,
      ).exec(prompt)?.[1] ?? '';
    if (!/^\s+1\. /m.test(block)) {
      return { line: Number(line), medicine: null, presentation: null };
    }
    const first = block.split(/\n\s+2\. /)[0] ?? '';
    const presentations = [...first.matchAll(/^\s+(\d+)\) .* · (.+)$/gm)];
    const match = presentations.find(
      ([, , concentration]) =>
        concentration?.replace(/\s+/g, '') === strength?.replace(/\s+/g, ''),
    );
    return {
      line: Number(line),
      medicine: 1,
      presentation: match ? Number(match[1]) : null,
    };
  });
}
