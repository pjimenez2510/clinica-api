import { z } from 'zod';

import { instruction } from '../../src/modules/assistant/application/llm-client.port.ts';
import { caseText } from '../case-text.ts';
import type { NoteCase } from '../cases.ts';
import type { Ask, EvalTask } from '../task.ts';

export const NOTE_PROMPT_VERSIONS = { D: 'nota-v1' } as const;
export const JUDGE_PROMPT_VERSION = 'juez-nota-v1';

/** The sections of the invented cases; a section outside them is invented. */
export const NOTE_SECTIONS = [
  'motivo',
  'enfermedad_actual',
  'antecedentes',
  'examen_fisico',
  'diagnostico',
  'plan',
] as const;

const answer = z.object({
  sections: z
    .array(
      z.object({
        section: z.string().min(1).max(40),
        segments: z
          .array(
            z.object({
              text: z.string().min(1).max(400),
              source: z.number().int().positive().nullable(),
            }),
          )
          .max(20),
      }),
    )
    .max(12),
});
type NoteAnswer = z.infer<typeof answer>;

const SYSTEM = instruction`Eres un médico que redacta la nota de una consulta en Ecuador a partir de la conversación, numerada por líneas. Escribe la nota con estas secciones, en este orden y con estos nombres exactos: motivo, enfermedad_actual, antecedentes, examen_fisico, diagnostico, plan. Cada sección es una lista de frases breves en lenguaje clínico. Cada frase lleva en source el número de la línea de la conversación de la que sale; si una frase no sale de ninguna línea, source es null. No escribas nada que no se haya dicho. Una sección de la que no se habló queda con la lista vacía.`;

/**
 * The judge (SigmAI `relevance-judge.ts`: its instructions are a constant so
 * what it was asked lives in the repository beside the figures it produced).
 * It is NOT validated: until a physician reviews a subsample and its κ is
 * measured (PLAN-ASISTENTE-IA §5), its figures are printed as «juez sin
 * validar» and do not decide anything on their own.
 */
export const JUDGE_SYSTEM = instruction`Eres un médico que revisa la nota de una consulta contra la conversación de la que salió. Recibes la conversación numerada por líneas, una lista numerada de hechos que la conversación contiene, y la nota en frases numeradas.

Para cada hecho decide present: true si la nota lo recoge, aunque sea con otras palabras o abreviado; false si la nota lo omite o lo contradice.

Para cada frase de la nota decide supported: true si lo que dice está en la conversación (paráfrasis y terminología clínica cuentan); false si añade algo que nadie dijo, cambia una cifra, una dosis o un lado, o contradice la conversación.

Reglas:
- Juzga cada hecho y cada frase por separado.
- Si dudas, elige false.
- Devuelve un juicio por cada número de hecho y por cada número de frase, con el número tal como aparece.`;

const judgeAnswer = z.object({
  facts: z.array(z.object({ n: z.number().int(), present: z.boolean() })),
  segments: z.array(z.object({ n: z.number().int(), supported: z.boolean() })),
});

const numbered = (lines: readonly string[]) =>
  lines.map((line, i) => `${i + 1}. ${line}`).join('\n');

/**
 * What the judge reads. The note is the model's answer to invented text, so
 * the whole request is still case text (EV-2).
 */
export function judgeRequest(item: NoteCase, note: NoteAnswer) {
  const segments = note.sections.flatMap((s) =>
    s.segments.map((segment) => `[${s.section}] ${segment.text}`),
  );
  return {
    tier: 'quality' as const,
    purpose: 'eval-juez',
    promptVersion: JUDGE_PROMPT_VERSION,
    system: JUDGE_SYSTEM,
    prompt: caseText(
      [
        'Conversación:',
        numbered(item.lines),
        '',
        'Hechos:',
        numbered(item.facts.map((f) => `[${f.section}] ${f.fact}`)),
        '',
        'Nota:',
        segments.length === 0 ? '(vacía)' : numbered(segments),
      ].join('\n'),
    ),
    answer: judgeAnswer,
    maxTokens: 2_000,
  };
}

/** The judge's verdicts, only if they cover every fact and every segment once. */
export function readVerdicts(
  verdicts: z.infer<typeof judgeAnswer>,
  facts: number,
  segments: number,
): { omitted: number; unsupported: number } | null {
  const complete = (ns: number[], size: number) =>
    ns.length === size &&
    new Set(ns).size === size &&
    ns.every((n) => n >= 1 && n <= size);
  if (
    !complete(
      verdicts.facts.map((v) => v.n),
      facts,
    ) ||
    !complete(
      verdicts.segments.map((v) => v.n),
      segments,
    )
  ) {
    return null;
  }
  return {
    omitted: verdicts.facts.filter((v) => !v.present).length,
    unsupported: verdicts.segments.filter((v) => !v.supported).length,
  };
}

/**
 * The note (D-239 §5): what can be counted without a model — sections outside
 * the template, segments with no line behind them — and what the judge says
 * about omission and invention per fact. One arm: the comparison here is
 * between providers, on the template with provenance that the product uses.
 */
export function noteTask(): EvalTask<NoteCase, NoteAnswer> {
  const known = new Set<string>(NOTE_SECTIONS);
  return {
    name: 'note',
    title: 'Nota de la consulta',
    arms: ['D'],
    promptVersions: NOTE_PROMPT_VERSIONS,
    latencyBudgetMs: 15_000,
    metrics: [
      {
        key: 'inventedSections',
        label: 'Secciones fuera de la plantilla (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
      },
      {
        key: 'unbacked',
        label: 'Frases sin línea de origen (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'omission',
        label: 'Hechos omitidos (juez sin validar)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'invention',
        label: 'Frases sin respaldo (juez sin validar)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
      { key: 'judged', label: 'Notas juzgadas', kind: 'binary' },
    ],
    request(item) {
      return {
        tier: 'quality',
        purpose: 'eval-nota',
        promptVersion: NOTE_PROMPT_VERSIONS.D,
        system: SYSTEM,
        prompt: caseText(`Conversación:\n${numbered(item.lines)}`),
        answer,
        maxTokens: 3_000,
      };
    },
    async evaluate(item, _arm, value, judge: Ask | null) {
      const segments = value.sections.flatMap((s) => s.segments);
      const lines = item.lines.length;
      const deterministic = {
        inventedSections:
          value.sections.length === 0
            ? null
            : value.sections.filter((s) => !known.has(s.section)).length /
              value.sections.length,
        unbacked:
          segments.length === 0
            ? null
            : segments.filter((s) => s.source === null || s.source > lines)
                .length / segments.length,
      };
      let verdict: { omitted: number; unsupported: number } | null = null;
      if (judge !== null) {
        const verdicts = await judge(judgeRequest(item, value));
        // A judge that gave no valid answer leaves the note unjudged; it is counted.
        verdict =
          verdicts === null
            ? null
            : readVerdicts(verdicts, item.facts.length, segments.length);
      }
      return {
        shown: value,
        scores: {
          ...deterministic,
          omission:
            verdict === null ? null : verdict.omitted / item.facts.length,
          invention:
            verdict === null || segments.length === 0
              ? null
              : verdict.unsupported / segments.length,
          judged: verdict === null ? 0 : 1,
        },
      };
    },
  };
}
