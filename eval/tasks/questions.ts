import type { z } from 'zod';

import { questionsRequest } from '../../src/modules/assistant/application/note-questions.ts';
import { QUESTIONS_PROMPT_VERSION } from '../../src/modules/assistant/application/note-questions.prompts.ts';
import { heardLines } from '../../src/modules/assistant/application/note-writer.ts';
import {
  buildLexicon,
  type Lexicon,
} from '../../src/modules/assistant/domain/lexicon.ts';
import {
  backedQuestions,
  noteBlock,
  questionsConversation,
} from '../../src/modules/assistant/domain/note-questions.ts';
import { caseText } from '../case-text.ts';
import type { NoteCase } from '../cases.ts';
import type { Catalogues } from '../catalogue.ts';
import type { EvalTask } from '../task.ts';

import { DRAFT_TEMPLATE, heardCase } from './draft.ts';

export const QUESTIONS_PROMPT_VERSIONS = { D: QUESTIONS_PROMPT_VERSION } as const; // prettier-ignore

/** AS-126. Each case twice: with nothing written, and with its reference note. */
export type QuestionsVariant = 'vacia' | 'escrita';

export interface QuestionsCase extends NoteCase {
  variant: QuestionsVariant;
}

/**
 * AS-126. Where each expected fact of `nota.json` is written in the
 * reference note: the 002's sections. The diagnosis has no section of its
 * own in this note (D-249 §2); it goes with the plan, as a physician writes it.
 */
const INTO: Readonly<Record<string, string>> = {
  motivo: 'motivoConsulta',
  enfermedad_actual: 'enfermedadActual',
  antecedentes: 'antecedentes',
  examen_fisico: 'examenFisico',
  diagnostico: 'planTratamiento',
  plan: 'planTratamiento',
};

/** AS-126. The cases of the draft set, each with the note empty and written. */
export function questionsCases(cases: readonly NoteCase[]): QuestionsCase[] {
  return cases.flatMap((item) => [
    { ...item, id: `${item.id}-vacia`, variant: 'vacia' as const },
    { ...item, id: `${item.id}-escrita`, variant: 'escrita' as const },
  ]);
}

/** AS-126. The reference note: every expected fact in its section. */
export function referenceNote(item: QuestionsCase): Record<string, string> {
  if (item.variant === 'vacia') return {};
  const written: Record<string, string[]> = {};
  for (const { section, fact } of item.facts) {
    const key = INTO[section] ?? 'planTratamiento';
    written[key] = [...(written[key] ?? []), `${fact.charAt(0).toUpperCase()}${fact.slice(1)}.`]; // prettier-ignore
  }
  return Object.fromEntries(Object.entries(written).map(([key, facts]) => [key, facts.join(' ')])); // prettier-ignore
}

type QuestionsAnswer = z.infer<ReturnType<typeof questionsRequest>['answer']>;

/**
 * SC-093. What a person reads to judge each question by hand: whether it
 * asks what the conversation or the note already answer. It is case text, so
 * it never goes into the result (EV-7): `--revision` writes it outside the
 * repository.
 */
export interface QuestionsReview {
  caseId: string;
  variant: QuestionsVariant;
  questions: { text: string; section: string | null; line: string }[];
  dropped: number;
}

/**
 * AS-126 (SC-093, SC-094). The questions «Para completar la nota» (C3)
 * measured with the product's own code: the lexicon, the request with the
 * note as it is written, the barrier that keeps only a question with its
 * line. No pseudonymizer: the cases are invented (EV-2).
 *
 * - **shown**: how many questions reach the screen, per case;
 * - **withoutLine**: a shown question without its line (SC-093: 0) — the
 *   barrier makes it impossible, and this says so on every run;
 * - **dropped**: the share the model asked that had no line;
 * - whether a shown question asks what was already answered is judged by
 *   hand from `--revision` (SC-093: ≤ 10 % in each variant);
 * - the p90 of the latency is the runner's (SC-094: ≤ 5 s).
 */
export function questionsTask(
  catalogues: Catalogues,
  options: { review?: (entry: QuestionsReview) => void } = {},
): EvalTask<QuestionsCase, QuestionsAnswer> {
  const lexicon: Lexicon = buildLexicon({
    targets: catalogues.cnmb.map((medicine) => medicine.display),
    protectedWords: [...catalogues.cie10.values()],
  });
  const sections = DRAFT_TEMPLATE;
  const prepared = (item: QuestionsCase) => {
    const said = heardCase(item);
    const { heard } = heardLines(said, lexicon);
    const written = referenceNote(item);
    const conversation = questionsConversation(heard);
    const note = noteBlock(
      sections.map((section) => ({ ...section, text: written[section.key] ?? '' })), // prettier-ignore
    );
    return { said, conversation, text: `${conversation.text}\n\n${note}` };
  };
  return {
    name: 'questions',
    title: 'Preguntas para completar la nota (C3)',
    arms: ['D'],
    promptVersions: QUESTIONS_PROMPT_VERSIONS,
    latencyBudgetMs: 5_000,
    metrics: [
      {
        key: 'withoutLine',
        label: 'Con alguna pregunta mostrada sin su línea',
        kind: 'binary',
        lowerIsBetter: true,
        primary: true,
      },
      { key: 'shown', label: 'Preguntas mostradas (por caso)', kind: 'mean' },
      {
        key: 'dropped',
        label: 'Preguntas descartadas por no tener línea (fracción)',
        kind: 'mean',
        lowerIsBetter: true,
      },
    ],
    request(item) {
      return questionsRequest(caseText(prepared(item).text), sections);
    },
    evaluate(item, _arm, value) {
      const { said, conversation } = prepared(item);
      const { kept, dropped } = backedQuestions({
        answered: value.questions,
        markers: conversation.markers,
        textSections: sections.map((section) => section.key),
        discarded: [],
        restore: (text) => text,
      });
      const lineOf = (fromMs: number) =>
        said.find((line) => line.startMs === fromMs)?.text ?? '';
      options.review?.({
        caseId: item.id,
        variant: item.variant,
        questions: kept.map((question) => ({
          text: question.text,
          section: question.section,
          line: lineOf(question.fromMs),
        })),
        dropped,
      });
      const asked = value.questions.length;
      return Promise.resolve({
        // Counts only: what the result keeps is never the case's text (EV-7).
        shown: { variant: item.variant, shown: kept.length, dropped },
        scores: {
          withoutLine: kept.some((question) => lineOf(question.fromMs) === '') ? 1 : 0, // prettier-ignore
          shown: kept.length,
          dropped: asked === 0 ? null : dropped / asked,
        },
      });
    },
  };
}
