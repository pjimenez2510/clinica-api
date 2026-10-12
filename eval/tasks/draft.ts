import type { z } from 'zod';

import {
  draftRequest,
  heardLines,
} from '../../src/modules/assistant/application/note-writer.ts';
import {
  buildLexicon,
  type Lexicon,
} from '../../src/modules/assistant/domain/lexicon.ts';
import {
  conversationOf,
  type DraftSection,
  inventedSection,
  readDraft,
  type TranscriptLine,
} from '../../src/modules/assistant/domain/note-draft.ts';
import { DRAFT_PROMPT_VERSION } from '../../src/modules/assistant/application/note-draft.prompts.ts';
import { FORM_002_BUILT_IN_SECTIONS } from '../../src/shared/clinical/form-002.ts';
import { caseText } from '../case-text.ts';
import type { NoteCase } from '../cases.ts';
import type { Catalogues } from '../catalogue.ts';
import type { EvalTask } from '../task.ts';

import { judgeRequest, readVerdicts } from './note.ts';

export const DRAFT_PROMPT_VERSIONS = { D: DRAFT_PROMPT_VERSION } as const;

/**
 * AS-098 (SC-091, SC-092). How long each invented line lasts on the
 * listening's clock: the timing is the transcript's, not the model's.
 */
const LINE_MS = 5_000;

/**
 * SC-091, D-249 §2. The sections of the expected facts that the draft never
 * writes: the diagnosis goes to Diagnósticos and the physician decides it.
 * Their facts are counted apart, so the share says what the draft can keep.
 */
const NOT_DRAFTED = new Set(['diagnostico']);

/** The template the product drafts in when the clinic published none (EN-200). */
export const DRAFT_TEMPLATE = FORM_002_BUILT_IN_SECTIONS.map(({ key, title, help }) => ({ key, title, help })); // prettier-ignore

/**
 * AS-098. The cases of `nota.json` as the listening would hand them over:
 * no speaker (C1 does not tell voices apart) and a clock per line.
 */
export function heardCase(item: NoteCase): TranscriptLine[] {
  return item.lines.map((line, index) => ({
    startMs: index * LINE_MS,
    endMs: (index + 1) * LINE_MS,
    text: line.replace(/^(Médico|Paciente|Acompañante|Madre|Padre):\s*/i, ''),
  }));
}

type DraftAnswer = z.infer<ReturnType<typeof draftRequest>['answer']>;

/**
 * SC-091. What a person needs to check the judge by hand: each phrase of the
 * draft and each expected fact with its verdict. It is case text, so it never
 * goes into the result (EV-7): `--revision` writes it outside the repository.
 */
export interface DraftReview {
  caseId: string;
  phrases: { section: string; text: string; unsaid: boolean; supported: boolean | null }[]; // prettier-ignore
  facts: { section: string; fact: string; present: boolean | null }[];
}

/**
 * AS-098. The draft of the note (C2) measured with the product's own code:
 * the lexicon, the request, the reading of the answer with its line or
 * «Nadie lo dijo». No pseudonymizer: the cases are invented (EV-2).
 *
 * - **invented**: the draft has a section none of whose phrases anybody said
 *   (SC-091: 0 of 10). A section outside the template cannot happen: the
 *   schema refuses the whole answer.
 * - **facts**: the share of the expected facts the judge finds among those
 *   of the sections the draft writes (SC-091: ≥ 95 %); the diagnoses, which
 *   it never writes (D-249 §2), go in **factsWithDiagnosis**. The judge is
 *   the one of the note task, unvalidated.
 * - the p90 of the latency is the runner's (SC-092: ≤ 15 s).
 */
export function draftTask(
  catalogues: Catalogues,
  options: { review?: (entry: DraftReview) => void } = {},
): EvalTask<NoteCase, DraftAnswer> {
  const lexicon: Lexicon = buildLexicon({
    targets: catalogues.cnmb.map((medicine) => medicine.display),
    protectedWords: [...catalogues.cie10.values()],
  });
  const prepared = (item: NoteCase) => {
    const said = heardCase(item);
    const { heard, corrected } = heardLines(said, lexicon);
    return { said, corrected, conversation: conversationOf(heard) };
  };
  return {
    name: 'draft',
    title: 'Borrador de la nota (C2)',
    arms: ['D'],
    promptVersions: DRAFT_PROMPT_VERSIONS,
    latencyBudgetMs: 15_000,
    metrics: [
      {
        key: 'invented',
        label:
          'Con alguna sección inventada (todas sus frases «Nadie lo dijo»)',
        kind: 'binary',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'facts',
        label: 'Hechos esperados presentes, sin los diagnósticos que el borrador no escribe (D-249 §2; juez sin validar)', // prettier-ignore
        kind: 'mean',
        primary: true,
      },
      {
        key: 'factsWithDiagnosis',
        label: 'Hechos esperados presentes, con los diagnósticos (juez sin validar)', // prettier-ignore
        kind: 'mean',
      },
      {
        key: 'unsaid',
        label: 'Frases «Nadie lo dijo» (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
      },
      { key: 'judged', label: 'Borradores juzgados', kind: 'binary' },
    ],
    request(item) {
      return draftRequest(caseText(prepared(item).conversation.text), DRAFT_TEMPLATE); // prettier-ignore
    },
    async evaluate(item, _arm, value, judge) {
      const { said, corrected, conversation } = prepared(item);
      const sections: DraftSection[] = readDraft({
        sections: value.sections,
        markers: conversation.markers,
        template: DRAFT_TEMPLATE,
        restore: (text) => text,
        said: said.map((line) => line.text).join('\n'),
      });
      const phrases = sections.flatMap((section) => section.phrases);
      const invented = sections.filter(inventedSection).length;
      let judgedFacts: boolean[] | null = null;
      if (judge !== null) {
        const note = {
          sections: sections.map((section) => ({
            section: section.section,
            segments: section.phrases.map((phrase) => ({ text: phrase.text, source: null })), // prettier-ignore
          })),
        };
        const verdicts = await judge(judgeRequest(item, note));
        const verdict =
          verdicts === null
            ? null
            : readVerdicts(verdicts, item.facts.length, phrases.length);
        judgedFacts =
          verdict === null
            ? null
            : item.facts.map((_, i) => verdicts?.facts.find((v) => v.n === i + 1)?.present ?? false); // prettier-ignore
        options.review?.({
          caseId: item.id,
          phrases: sections.flatMap((section) =>
            section.phrases.map((phrase) => ({
              section: section.section,
              text: phrase.text,
              unsaid: phrase.unsaid,
              supported: verdict === null ? null : (verdicts?.segments.find((v) => v.n === phrases.indexOf(phrase) + 1)?.supported ?? null), // prettier-ignore
            })),
          ),
          facts: item.facts.map((fact, i) => ({
            ...fact,
            present: judgedFacts?.[i] ?? null,
          })),
        });
      }
      const count = (drafted: boolean) => {
        const indexes = item.facts
          .map((fact, i) => ({ fact, i }))
          .filter(({ fact }) => NOT_DRAFTED.has(fact.section) !== drafted)
          .map(({ i }) => i);
        return {
          present: judgedFacts === null ? null : indexes.filter((i) => judgedFacts[i]).length, // prettier-ignore
          expected: indexes.length,
        };
      };
      const facts = count(true);
      const diagnosis = count(false);
      const share = (present: number | null, expected: number) =>
        present === null || expected === 0 ? null : present / expected;
      return {
        // Counts only: what the result keeps is never the case's text (EV-7).
        shown: {
          sections: sections.length,
          invented,
          phrases: phrases.length,
          unsaid: phrases.filter((phrase) => phrase.unsaid).length,
          corrected,
          facts,
          diagnosis,
        },
        scores: {
          invented: invented > 0 ? 1 : 0,
          facts: share(facts.present, facts.expected),
          factsWithDiagnosis: share(
            facts.present === null
              ? null
              : facts.present + (diagnosis.present ?? 0),
            item.facts.length,
          ),
          unsaid:
            phrases.length === 0
              ? null
              : phrases.filter((phrase) => phrase.unsaid).length /
                phrases.length,
          judged: judgedFacts === null ? 0 : 1,
        },
      };
    },
  };
}
