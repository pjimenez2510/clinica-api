import type { z } from 'zod';

import { chartRequest } from '../../src/modules/assistant/application/chart-reader.ts';
import { CHART_PROMPT_VERSION } from '../../src/modules/assistant/application/chart-background.prompts.ts';
import { withContext } from '../../src/modules/assistant/application/llm-client.port.ts';
import {
  candidatesContext,
  LINES_INSTRUCTIONS,
  LINES_PROMPT_VERSION,
  linesAnswer,
  MAPPING_INSTRUCTIONS,
  MAPPING_PROMPT_VERSION,
  mappingAnswer,
  vocabularyContext,
  writtenLines,
} from '../../src/modules/assistant/application/prescription-reading.prompts.ts';
import {
  CODES_INSTRUCTIONS,
  CODES_PROMPT_VERSION,
  codesAnswer,
  noteText,
  PROBLEMS_INSTRUCTIONS,
  PROBLEMS_PROMPT_VERSION,
  problemLine,
  problemsAnswer,
} from '../../src/modules/assistant/application/problem-coding.prompts.ts';
import {
  backedChart,
  type ChartProposal,
} from '../../src/modules/assistant/domain/chart-background.ts';
import { conversationOf } from '../../src/modules/assistant/domain/note-draft.ts';
import {
  backedLines,
  choosePresentation,
  chosenIsWritten,
  cnmbSearchName,
  knownCodes,
  proposedFields,
  strengthIn,
} from '../../src/modules/assistant/domain/prescription-reading.ts';
import {
  backedProblems,
  PROPOSED,
  withoutSymptoms,
  type DiagnosisProposal,
} from '../../src/modules/assistant/domain/problem-coding.ts';
import { candidateCodes } from '../../src/shared/clinical/cie10-lookup.port.ts';
import { caseText } from '../case-text.ts';
import type {
  ChartCase,
  ChartEntry,
  PrescriptionFieldsCase,
  SymptomsCase,
} from '../cases.ts';
import type { Catalogues } from '../catalogue.ts';
import type { EvalTask, Scores } from '../task.ts';

import { heardCase } from './draft.ts';
import { searchLikeTheProduct } from './prescription-from-note.ts';

/**
 * AS-277. What the author asked of the assistant on 13-10-2026, measured as
 * the product runs it — the same prompts and the same functions of `src/` —
 * on invented cases (EV-1):
 *
 * - `receta-campos` (SC-102): each field of each line, said or deducible;
 * - `sintomas` (SC-103): no chapter XVIII code beside a definite diagnosis;
 * - `ficha` (SC-104): the allergies and history said, proposed as records.
 */

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** The fields SC-102 counts, as the receta writes them. */
const FIELDS = ['form', 'concentration', 'route', 'dose'] as const;

type LinesAnswer = z.infer<typeof linesAnswer>;

/** AS-277, SC-102. The receta of the note, field by field. */
export function prescriptionFieldsTask(
  catalogues: Catalogues,
): EvalTask<PrescriptionFieldsCase, LinesAnswer> {
  return {
    name: 'receta-campos',
    title: 'Receta completa desde la nota, campo por campo (SC-102)',
    arms: ['D'],
    promptVersions: { D: `${LINES_PROMPT_VERSION}+${MAPPING_PROMPT_VERSION}` },
    latencyBudgetMs: 5_000,
    callsPerAnswer: 2,
    metrics: [
      {
        key: 'fields',
        label: 'Campos dichos o deducibles llenos y correctos',
        kind: 'mean',
        primary: true,
      },
      {
        key: 'wrong',
        label: 'Campos llenos con otro valor o en una línea de más (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'unmarked',
        label: 'Campos deducidos sin la marca «Nadie lo dijo» (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
      },
    ],
    request(item) {
      return {
        tier: 'quality',
        purpose: 'eval-receta-campos',
        promptVersion: LINES_PROMPT_VERSION,
        system: LINES_INSTRUCTIONS,
        prompt: withContext(
          caseText(noteText([{ label: 'Plan', text: item.plan }])),
          vocabularyContext(),
        ),
        answer: linesAnswer,
        maxTokens: 2_000,
      };
    },
    async evaluate(item, _arm, value, _judge, followUp) {
      const sections = [{ key: 'plan', text: item.plan }];
      const backed = backedLines({
        read: value.lines.map(knownCodes),
        cleared: item.plan,
        sections,
        restore: (text) => text,
      });
      const candidates = backed.kept.map((line) =>
        searchLikeTheProduct(cnmbSearchName(line.drug), catalogues.cnmb),
      );
      let choices: z.infer<typeof mappingAnswer>['choices'] = [];
      if (candidates.some((each) => each.length > 0)) {
        if (!followUp) throw new Error('receta-campos pregunta dos veces al mismo proveedor'); // prettier-ignore
        const answer = await followUp({
          tier: 'quality',
          purpose: 'eval-receta-campos-mapeo',
          promptVersion: MAPPING_PROMPT_VERSION,
          system: MAPPING_INSTRUCTIONS,
          prompt: withContext(caseText(writtenLines(backed.kept)), candidatesContext(candidates)), // prettier-ignore
          answer: mappingAnswer,
          maxTokens: 1_000,
        });
        if (answer === null) return { shown: null, scores: {}, unanswered: true }; // prettier-ignore
        choices = answer.choices;
      }
      // The service's own steps (`PrescriptionProposalService.readNote`).
      const shown = backed.kept.flatMap((line, at) => {
        const choice = choices.find((each) => each.line === at + 1);
        const medicine =
          choice?.medicine == null ? undefined : candidates[at]?.[choice.medicine - 1]; // prettier-ignore
        if (!medicine || !chosenIsWritten(medicine.display, line.quote)) return []; // prettier-ignore
        const presentation = choosePresentation(
          medicine.presentations,
          choice?.presentation == null ? undefined : medicine.presentations[choice.presentation - 1], // prettier-ignore
          { form: line.form, strength: line.strength ?? strengthIn(line.quote, line.drug) }, // prettier-ignore
        );
        const { fields, unsaid } = proposedFields(
          { ...line, strength: presentation.strength },
          presentation.chosen,
          item.plan,
          { strengthDeduced: presentation.strengthDeduced },
        );
        return [{ code: medicine.code, fields, unsaid, said: { form: line.form, route: line.route, dose: line.doseAmount !== null } }]; // prettier-ignore
      });
      return { shown, scores: fieldScores(item, shown) };
    },
  };
}

type ShownLine = {
  code: string;
  fields: ReturnType<typeof proposedFields>['fields'];
  unsaid: string[];
  said: { form: string | null; route: string | null; dose: boolean };
};

function fieldScores(
  item: PrescriptionFieldsCase,
  shown: readonly ShownLine[],
): Scores {
  // prettier-ignore
  const left = [...shown];
  let right = 0;
  let wrong = 0;
  let unmarked = 0;
  for (const expected of item.expected) {
    const at = left.findIndex((each) => each.code === expected.cnmbCode);
    const line = at < 0 ? undefined : left.splice(at, 1)[0];
    for (const field of FIELDS) {
      const got =
        field === 'dose'
          ? line?.fields.doseAmount == null ? null : `${line.fields.doseAmount} ${line.fields.doseUnit ?? ''}` // prettier-ignore
          : (line?.fields[field] ?? null);
      const want =
        field === 'dose'
          ? `${expected.doseAmount} ${expected.doseUnit}`
          : expected[field];
      if (got === null) continue;
      if (
        fold(String(got)).replace(/\s+/g, '') === fold(want).replace(/\s+/g, '')
      )
        right += 1; // prettier-ignore
      else wrong += 1;
    }
    // SC-102. What was deduced has to say so: the route and the dose nobody said.
    if (line) {
      if (line.said.route === null && line.fields.route !== null && !line.unsaid.includes('route')) unmarked += 1; // prettier-ignore
      if (!line.said.dose && line.fields.doseAmount !== null && !line.unsaid.includes('dose')) unmarked += 1; // prettier-ignore
    }
  }
  // A line nobody prescribed fills fields nobody said.
  for (const extra of left) {
    wrong += FIELDS.filter((field) =>
      field === 'dose'
        ? extra.fields.doseAmount !== null
        : extra.fields[field] !== null,
    ).length;
  }
  const total = item.expected.length * FIELDS.length;
  return { fields: total === 0 ? null : right / total, wrong, unmarked };
}

type ProblemsAnswer = z.infer<typeof problemsAnswer>;

/** AS-277, SC-103. The problems of the note, coded, after the barrier of AS-267. */
export function symptomsTask(
  catalogues: Catalogues,
): EvalTask<SymptomsCase, ProblemsAnswer> {
  const inForce = (written: string) =>
    candidateCodes(written).find((code) => catalogues.cie10.has(code)) ?? null;
  return {
    name: 'sintomas',
    title: 'Sin códigos de síntoma junto a un diagnóstico (SC-103)',
    arms: ['D'],
    promptVersions: { D: `${PROBLEMS_PROMPT_VERSION}+${CODES_PROMPT_VERSION}` },
    latencyBudgetMs: 5_000,
    callsPerAnswer: 4,
    metrics: [
      {
        key: 'symptomCodes',
        label: 'Códigos R00–R99 mostrados junto a un diagnóstico (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'diagnosis',
        label: 'El diagnóstico entre los códigos mostrados',
        kind: 'binary',
        primary: true,
      },
      {
        key: 'symptomProblems',
        label: 'Síntomas que el modelo nombró como problema (por caso, antes de la barrera)', // prettier-ignore
        kind: 'mean',
        lowerIsBetter: true,
      },
    ],
    request(item) {
      return {
        tier: 'quality',
        purpose: 'eval-sintomas',
        promptVersion: PROBLEMS_PROMPT_VERSION,
        system: PROBLEMS_INSTRUCTIONS,
        prompt: caseText(noteText(item.sections)),
        answer: problemsAnswer,
        maxTokens: 800,
      };
    },
    async evaluate(
      item,
      _arm,
      value,
      _judge,
      followUp,
    ): Promise<{ shown: unknown; scores: Scores; unanswered?: true }> {
      const cleared = noteText(item.sections);
      const backed = backedProblems({
        named: value.problems.map((each) => ({ ...each, codes: [] })),
        cleared,
        sections: item.sections,
        restore: (text) => text,
      });
      const proposals: DiagnosisProposal[] = [];
      for (const problem of backed.kept) {
        if (!followUp) throw new Error('sintomas pregunta a cada problema');
        const answer = await followUp({
          tier: 'quality',
          purpose: 'eval-sintomas-codigos',
          promptVersion: CODES_PROMPT_VERSION,
          system: CODES_INSTRUCTIONS,
          prompt: caseText(problemLine(problem.problem)),
          answer: codesAnswer,
          maxTokens: 1_500,
        });
        if (answer === null) return { shown: null, scores: {}, unanswered: true }; // prettier-ignore
        const codes = [...new Set(answer.codes.slice(0, PROPOSED).flatMap((code) => inForce(code) ?? []))]; // prettier-ignore
        proposals.push({
          problem: problem.problem,
          quote: problem.quote,
          section: problem.section,
          codes,
          candidates: codes.map((code) => ({ conceptId: code, code, display: catalogues.cie10.get(code) ?? code })), // prettier-ignore
          demo: false,
        });
      }
      const before = proposals.filter((each) => /^R/.test(each.candidates[0]?.code ?? '')).length; // prettier-ignore
      const shown = withoutSymptoms(proposals);
      const codes = shown.flatMap((each) => each.candidates.slice(0, 2).map(({ code }) => code)); // prettier-ignore
      const definite = shown.some((each) => each.candidates.length > 0 && !/^R/.test(each.candidates[0]!.code)); // prettier-ignore
      return {
        shown: shown.map((each) => ({ problem: each.problem, codes: each.codes, symptoms: each.symptoms ?? [] })), // prettier-ignore
        scores: {
          symptomCodes: definite ? codes.filter((code) => /^R/.test(code)).length : null, // prettier-ignore
          diagnosis: codes.some((code) => item.diagnosis.includes(code.slice(0, 3))) ? 1 : 0, // prettier-ignore
          symptomProblems: before,
        },
      };
    },
  };
}

type ChartAnswerValue = z.infer<ReturnType<typeof chartRequest>['answer']>;

/** AS-277, SC-104. The chart read out of the conversation. */
export function chartTask(): EvalTask<ChartCase, ChartAnswerValue> {
  return {
    name: 'ficha',
    title: 'Alergias y antecedentes dichos, propuestos como registro (SC-104)',
    arms: ['D'],
    promptVersions: { D: CHART_PROMPT_VERSION },
    latencyBudgetMs: 5_000,
    metrics: [
      {
        key: 'recall',
        label: 'Alergias y antecedentes dichos, propuestos con su línea',
        kind: 'mean',
        primary: true,
      },
      {
        key: 'invented',
        label: 'Propuestos que no se dijeron (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
    ],
    request(item) {
      return {
        ...chartRequest(caseText(conversationOf(heardCase({ ...item, facts: [] })).text)), // prettier-ignore
        purpose: 'eval-ficha',
      };
    },
    evaluate(item, _arm, value) {
      const { kept } = backedChart({
        answer: value,
        markers: conversationOf(heardCase({ ...item, facts: [] })).markers,
        restore: (text) => text,
      });
      const left = [...kept];
      let found = 0;
      for (const expected of item.expected) {
        const at = left.findIndex((each) => matches(each, expected));
        if (at >= 0) {
          found += 1;
          left.splice(at, 1);
        }
      }
      const invented = left.filter(
        (each) =>
          !(item.optional ?? []).some((optional) => matches(each, optional)),
      ).length;
      return Promise.resolve({
        shown: kept.map((each) => each.text),
        scores: {
          recall:
            item.expected.length === 0 ? null : found / item.expected.length,
          invented,
        },
      });
    },
  };
}

function matches(proposal: ChartProposal, entry: ChartEntry): boolean {
  if (entry.kind === 'none') return proposal.kind === 'chart-no-allergy';
  if (entry.kind === 'allergy') {
    return proposal.kind === 'chart-allergy' && fold(proposal.substance).includes(fold(entry.key ?? '')); // prettier-ignore
  }
  return (
    proposal.kind === 'chart-history' &&
    proposal.history === entry.history &&
    fold(proposal.description).includes(fold(entry.key ?? '')) &&
    (entry.relative === undefined || proposal.relative === entry.relative)
  );
}
