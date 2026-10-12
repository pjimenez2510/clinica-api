import type { z } from 'zod';

import { withContext } from '../../src/modules/assistant/application/llm-client.port.ts';
import {
  catalogueContext,
  conversationText,
  EXAMS_INSTRUCTIONS,
  EXAMS_MAX_TOKENS,
  EXAMS_PROMPT_VERSION,
  examsAnswer,
  MOST_EXAMS,
} from '../../src/modules/assistant/application/order-reading.prompts.ts';
import { noteText } from '../../src/modules/assistant/application/problem-coding.prompts.ts';
import {
  backedExams,
  offeredCandidates,
} from '../../src/modules/assistant/domain/order-reading.ts';
import type { OrderableExam } from '../../src/shared/clinical/ordering-context.port.ts';
import { caseText } from '../case-text.ts';
import type { ExamNoteCase } from '../cases.ts';
import type { EvalTask, Scores } from '../task.ts';

type ExamsAnswer = z.infer<typeof examsAnswer>;

/** The conversation of a case, as the product's transcript (one second each). */
function segmentsOf(item: ExamNoteCase) {
  return (item.conversation ?? []).map((text, at) => ({
    startMs: at * 1_000,
    endMs: at * 1_000 + 1_000,
    text,
  }));
}

/**
 * AS-114 (D3). «Proponer exámenes» measured as the product runs it: the
 * prompt over the note and the conversation with the clinic's catalogue
 * numbered, and the barriers of AS-103 and AS-104 — the very functions of
 * `src/`. One arm, D: what the physician sees.
 *
 * The primary metric is the one the physician uses: of the exams the
 * consultation asks for, how many have the RIGHT one among the five
 * candidates of a line shown (umbral ≥ 90 %, D-250 §3). The right one first
 * is counted apart; so are the lines shown that offer exams nobody asked for,
 * and the candidates outside the catalogue — none by construction (a
 * candidate is a number offered), counted to prove it.
 */
export function ordersFromNoteTask(
  catalogue: readonly OrderableExam[],
): EvalTask<ExamNoteCase, ExamsAnswer> {
  const known = new Set(catalogue.map((exam) => exam.code));

  return {
    name: 'examenes-nota',
    title: 'Exámenes propuestos desde la nota y la conversación (D3)',
    arms: ['D'],
    promptVersions: { D: EXAMS_PROMPT_VERSION },
    latencyBudgetMs: 5_000,
    callsPerAnswer: 1,
    metrics: [
      {
        key: 'recall',
        label: 'Exámenes pedidos con el correcto entre los candidatos',
        kind: 'mean',
        primary: true,
      },
      {
        key: 'first',
        label: 'Exámenes pedidos con el correcto en primer lugar',
        kind: 'mean',
      },
      { key: 'all', label: 'Orden entera cubierta, sin líneas de más', kind: 'binary' }, // prettier-ignore
      {
        key: 'extra',
        label: 'Líneas con candidatos que nadie pidió (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
      },
      {
        key: 'outsideCatalogue',
        label: 'Exámenes fuera del catálogo mostrados (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
    ],
    request(item) {
      const consultation = [
        noteText([{ label: 'Plan', text: item.plan }]),
        conversationText(segmentsOf(item)),
      ]
        .filter((part) => part !== '')
        .join('\n\n');
      return {
        tier: 'quality',
        purpose: 'eval-examenes-nota',
        promptVersion: EXAMS_PROMPT_VERSION,
        system: EXAMS_INSTRUCTIONS,
        prompt: withContext(
          caseText(consultation),
          catalogueContext(catalogue),
        ),
        answer: examsAnswer,
        maxTokens: EXAMS_MAX_TOKENS,
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- the task interface is async
    async evaluate(item, _arm, value) {
      const transcript = segmentsOf(item);
      const backed = backedExams({
        read: value.exams.slice(0, MOST_EXAMS),
        cleared: [item.plan, ...transcript.map((each) => each.text)].join('\n'),
        sections: [{ key: 'plan', text: item.plan }],
        transcript,
        restore: (text) => text,
      });
      const shown = backed.kept.map((exam) =>
        offeredCandidates(exam.candidates, catalogue).map((each) => each.code),
      );
      return { shown, scores: scoresOf(item, shown, known) };
    },
  };
}

/**
 * Each exam asked for is matched to one line shown that offers it, the
 * right one first preferred; a line shown with candidates that matches no
 * exam asked for is «de más». A line with no candidate shows only its
 * sentence and adds nothing to the order: it is not counted against it.
 */
export function scoresOf(
  item: ExamNoteCase,
  shown: readonly (readonly string[])[],
  known: ReadonlySet<string>,
): Scores {
  const free = shown.map((codes, at) => ({ codes, at }));
  let found = 0;
  let first = 0;
  for (const code of item.expected) {
    const atTop = free.findIndex((line) => line.codes[0] === code);
    const anywhere = atTop >= 0 ? atTop : free.findIndex((line) => line.codes.includes(code)); // prettier-ignore
    if (anywhere < 0) continue;
    found += 1;
    if (atTop >= 0) first += 1;
    free.splice(anywhere, 1);
  }
  const extra = free.filter((line) => line.codes.length > 0).length;
  const asked = item.expected.length;
  return {
    recall: asked === 0 ? null : found / asked,
    first: asked === 0 ? null : first / asked,
    all: found === asked && extra === 0 ? 1 : 0,
    extra,
    outsideCatalogue: shown.flat().filter((code) => !known.has(code)).length,
  };
}
