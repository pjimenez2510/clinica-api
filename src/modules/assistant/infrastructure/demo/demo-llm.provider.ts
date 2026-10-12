import type { z } from 'zod';

import type {
  LlmProvider,
  LlmRequest,
  ProviderAnswer,
} from '../../application/llm-client.port';
import { DRAFT_PURPOSE } from '../../application/note-draft.prompts';
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
    if (purpose === DRAFT_PURPOSE) return { sections: draftOf(prompt) };
    if (purpose === CODES_PURPOSE) {
      const problem = /«(.+)»/.exec(prompt)?.[1] ?? '';
      const codes = (script.codes as Record<string, string[]>)[problem] ?? [];
      return { codes };
    }
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

type DraftAnswer = { section: string; segments: { text: string; source: string | null }[] }; // prettier-ignore

/**
 * AS-099. The draft of the script: each line of the conversation that holds
 * a phrase of the script gives that phrase's sentence to its section, with
 * the line's marker, when the template has the section; and one sentence with
 * no marker, so the screen shows «Nadie lo dijo».
 */
function draftOf(prompt: string): DraftAnswer[] {
  const keys = new Set(
    [...prompt.matchAll(/^- (\w+) · /gm)].map((match) => match[1]!),
  );
  const said = [...prompt.matchAll(/^\[(L\d+)\] (.*)$/gm)].map((match) => ({
    marker: match[1]!,
    text: match[2]!.toLowerCase(),
  }));
  const sections = new Map<string, DraftAnswer['segments']>();
  for (const { phrase, section, text } of script.draft.lines) {
    const line = said.find((each) => each.text.includes(phrase));
    if (!line || !keys.has(section)) continue;
    const segments = sections.get(section) ?? [];
    if (segments.some((segment) => segment.text === text)) continue;
    sections.set(section, [...segments, { text, source: line.marker }]);
  }
  const last = [...sections.keys()].at(-1);
  if (last !== undefined) {
    const home = sections.has('planTratamiento') ? 'planTratamiento' : last;
    sections.get(home)!.push({ text: script.draft.unsaid.text, source: null });
  }
  return [...sections].map(([section, segments]) => ({ section, segments }));
}
