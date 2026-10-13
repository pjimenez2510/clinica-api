import type { z } from 'zod';

import type {
  LlmProvider,
  LlmRequest,
  ProviderAnswer,
} from '../../application/llm-client.port';
import { CHART_PURPOSE } from '../../application/chart-background.prompts';
import { DRAFT_PURPOSE } from '../../application/note-draft.prompts';
import { QUESTIONS_PURPOSE } from '../../application/note-questions.prompts';
import { EXAMS_PURPOSE } from '../../application/order-reading.prompts';
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
    if (purpose === DRAFT_PURPOSE) return { sections: draftOf(prompt) };
    if (purpose === CODES_PURPOSE) {
      const problem = /«(.+)»/.exec(prompt)?.[1] ?? '';
      const codes = (script.codes as Record<string, string[]>)[problem] ?? [];
      return { codes };
    }
    if (purpose === LINES_PURPOSE) return { lines: linesIn(noteOf(prompt)) };
    if (purpose === MAPPING_PURPOSE) return { choices: choicesIn(prompt) };
    if (purpose === EXAMS_PURPOSE) return { exams: examsIn(prompt) };
    if (purpose === QUESTIONS_PURPOSE) return { questions: questionsOf(prompt) }; // prettier-ignore
    if (purpose === CHART_PURPOSE) return chartOf(prompt);
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
  for (const { phrase, problem, unless } of script.problems as {
    phrase: string;
    problem: string;
    unless?: string;
  }[]) {
    const at = lower.indexOf(phrase.toLowerCase());
    if (at < 0 || named.has(problem)) continue;
    // AS-278. A diagnosis the text names more precisely is not named.
    if (unless !== undefined && lower.includes(unless.toLowerCase())) continue;
    // To the end of its sentence, whole words only: a cut word, or a quote
    // of one word, is no phrase of the note (AS-028), so the barrier drops it.
    const rest = text.slice(at);
    const end = rest.search(/[.;\n]/);
    let quote = (end > 0 ? rest.slice(0, end) : rest).trim();
    if (quote.split(/\s+/).length < 2) {
      const start = text.slice(0, at).search(/[^.;\n]*$/);
      quote = text.slice(start, at + quote.length).replace(/^#+\s*[^\n]*\n/, '').trim(); // prettier-ignore
    }
    named.set(problem, quote);
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

/**
 * AS-127. The questions of the script: each one whose phrase a line of the
 * conversation says, with that line's marker, unless what the note has
 * written already holds one of its answers; and one with a marker it was
 * never given, so the screen shows the barrier keeps it out.
 */
function questionsOf(prompt: string) {
  const said = [...prompt.matchAll(/^\[(L\d+)\] (.*)$/gm)].map((match) => ({
    marker: match[1]!,
    text: match[2]!.toLowerCase(),
  }));
  const written = noteOf(prompt).toLowerCase();
  return (
    script.questions as {
      phrase: string | null;
      text: string;
      section: string | null;
      answeredBy: string[];
    }[]
  ).flatMap(
    // prettier-ignore
    ({ phrase, text, section, answeredBy }) => {
      if (answeredBy.some((words) => written.includes(words))) return [];
      if (phrase === null) return [{ text, source: 'L99', section }];
      const line = said.find((each) => each.text.includes(phrase));
      return line ? [{ text, source: line.marker, section }] : [];
    },
  );
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
    // The plan is the last section: what the patient already took comes before.
    const at = lower.lastIndexOf(phrase.toLowerCase());
    if (at < 0 || seen.has(drug)) continue;
    seen.add(drug);
    const rest = text.slice(at, at + QUOTE_REACH * 2);
    const end = rest.search(/[.;\n]/);
    const quote = (end > 0 ? rest.slice(0, end) : rest).trim();
    const folded = quote.toLowerCase();
    const strength = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|g)\b/.exec(folded);
    const hours = /cada\s+(4|6|8|12)\s+horas/.exec(folded)?.[1];
    const days = /por\s+(\d+)\s+d[ií]as/.exec(folded)?.[1];
    const units = /\b(una|1|dos|2)\s+(tableta|c[aá]psula)s?\b/.exec(folded);
    const capsule = /c[aá]psula/.test(folded);
    const condition = /\bsi\s+(?:tiene|presenta|hay)\s+[^.;]+/.exec(quote)?.[0];
    lines.push({
      drug,
      strength: strength ? `${strength[1]} ${strength[2]}` : null,
      form: capsule ? 'CAPSULE' : /tableta/.test(folded) ? 'TABLET' : null,
      doseAmount: units ? (/(dos|2)/.test(units[1]!) ? 2 : 1) : null,
      doseUnit: units ? (/^t/.test(units[2]!) ? 'TABLET' : 'CAPSULE') : null,
      route: null,
      frequency: hours
        ? `EVERY_${hours}_HOURS`
        : /una vez al d[ií]a|cada d[ií]a/.test(folded)
          ? 'ONCE_DAILY'
          : null,
      frequencyText: null,
      durationDays: days ? Number(days) : null,
      instructions: condition?.trim() ?? null,
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

/**
 * AS-029, AS-103. The exams of the script: each one whose phrase the note
 * or the conversation says —in its own sentence, as a physician would
 * underline it—, with the numbers its names have in the catalogue the
 * prompt brought. A name the catalogue does not have gives no number.
 */
function examsIn(prompt: string) {
  const [consultation = '', catalogue = ''] = prompt.split('<catalogo>');
  const numbers = new Map(
    [...catalogue.matchAll(/^(\d+)\. (.+) · \S+$/gm)].map(
      ([, number, name]) => [name!.trim(), Number(number)] as const,
    ),
  );
  const lower = consultation.toLowerCase();
  const seen = new Set<string>();
  const exams = [];
  for (const { phrase, requested, names, invented } of script.exams as {
    phrase: string;
    requested: string;
    names: string[];
    invented?: number;
  }[]) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = new RegExp(`(^|[^\\p{L}])${escaped}(?![\\p{L}])`, 'u').exec(
      lower,
    );
    if (!at || seen.has(requested)) continue;
    seen.add(requested);
    const start = at.index + at[1]!.length;
    const rest = consultation.slice(start, start + QUOTE_REACH * 2);
    const end = rest.search(/[.;\n]/);
    exams.push({
      requested,
      quote: (end > 0 ? rest.slice(0, end) : rest).trim(),
      candidates: [
        ...names.flatMap((name) => numbers.get(name) ?? []),
        ...(invented ? [invented] : []),
      ],
    });
  }
  return exams;
}

const folded = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * AS-260, AS-278. The chart of the script: each entry whose phrase a line of
 * the conversation says, without accents nor case, with that line's marker.
 */
function chartOf(prompt: string) {
  const said = [...prompt.matchAll(/^\[(L\d+)\] (.*)$/gm)].map((match) => ({
    marker: match[1]!,
    text: folded(match[2]!),
  }));
  const answer = {
    noKnownAllergies: null as { source: string } | null,
    allergies: [] as { substance: string; reaction: string | null; source: string }[], // prettier-ignore
    history: [] as { kind: string; description: string; relative: string | null; source: string }[], // prettier-ignore
  };
  for (const entry of script.chart as {
    phrase: string;
    kind: 'none' | 'allergy' | 'history';
    substance?: string;
    reaction?: string;
    history?: string;
    description?: string;
    relative?: string | null;
  }[]) {
    const line = said.find((each) => each.text.includes(folded(entry.phrase)));
    if (!line) continue;
    if (entry.kind === 'none') answer.noKnownAllergies ??= { source: line.marker }; // prettier-ignore
    if (entry.kind === 'allergy') {
      answer.allergies.push({ substance: entry.substance!, reaction: entry.reaction ?? null, source: line.marker }); // prettier-ignore
    }
    if (entry.kind === 'history') {
      answer.history.push({ kind: entry.history!, description: entry.description!, relative: entry.relative ?? null, source: line.marker }); // prettier-ignore
    }
  }
  return answer;
}
