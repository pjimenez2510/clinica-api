import { PseudonymizerFailedError } from '../domain/assistant.errors';
import { unshiftDates } from '../domain/date-restore';
import type { Lexicon } from '../domain/lexicon';
import type { TranscriptLine } from '../domain/note-draft';
import {
  type BackedQuestion,
  backedQuestions,
  noteBlock,
  questionsConversation,
} from '../domain/note-questions';
import { carriesAnIdentifier } from '../domain/problem-coding';

import {
  type LlmClient,
  type LlmRequest,
  type PseudonymizedText,
  withContext,
} from './llm-client.port';
import { templateBlock } from './note-draft.prompts';
import {
  QUESTIONS_INSTRUCTIONS,
  QUESTIONS_MAX_TOKENS,
  QUESTIONS_PROMPT_VERSION,
  QUESTIONS_PURPOSE,
  questionsAnswer,
} from './note-questions.prompts';
import { draftableSections, heardLines } from './note-writer';
import { type Pseudonymizer, restorePlaceholders } from './pseudonymizer.port';

export interface QuestionsDependencies {
  pseudonymizer: Pseudonymizer;
  llm: LlmClient;
  /** AS-092. `null` when the vocabulary could not be read: nothing is corrected. */
  lexicon: Lexicon | null;
}

export interface QuestionsInput {
  /** The chart the transcript is about: placeholders stable per patient. */
  subject: string;
  /** AS-025. The people the conversation may name, for the pseudonymizer only. */
  names: string[];
  staff: string[];
  lines: readonly TranscriptLine[];
  template: readonly { key: string; title: string; help: string; kind: 'TEXT' | 'CHOICE' }[]; // prettier-ignore
  /** What the note has written now, by section key. */
  written: Readonly<Record<string, string>>;
  /** AS-120. The text of the questions discarded in this attention. */
  discarded: readonly string[];
  encounterId?: string;
  signal?: AbortSignal;
}

export interface AskedQuestions {
  kept: BackedQuestion[];
  /** AS-120. How many came without a line: a count, never the questions. */
  dropped: number;
  /** The attempt of `ai_run` that answered; null if it was not kept. */
  runId: string | null;
}

/**
 * AS-119, AS-120, AS-124. One review «Para completar la nota»: the
 * conversation corrected against the CNMB and the note's prose sections as
 * written, cleared together so a name is the same placeholder in both, sent
 * as data with the template after them, and read back keeping only the
 * questions backed by a line.
 *
 * The service and the evaluation harness (AS-126) call this same function,
 * so what is measured is what runs.
 */
export async function askNoteQuestions(
  deps: QuestionsDependencies,
  input: QuestionsInput,
): Promise<AskedQuestions> {
  const { heard } = heardLines(input.lines, deps.lexicon);
  const conversation = questionsConversation(heard);
  const sections = draftableSections(input.template);
  const note = noteBlock(
    sections.map((section) => ({
      key: section.key,
      title: section.title,
      text: input.written[section.key] ?? '',
    })),
  );

  const cleared = await deps.pseudonymizer.pseudonymize(
    {
      text: `${conversation.text}\n\n${note}`,
      subject: input.subject,
      names: input.names,
      staff: input.staff,
    },
    input.signal,
  );
  // AS-025 (P4). An identifier still there means the pseudonymizer missed
  // it: nothing leaves.
  if (carriesAnIdentifier(cleared.cleared)) {
    throw new PseudonymizerFailedError('invalid-answer');
  }

  const answer = await deps.llm.generate(
    questionsRequest(cleared.cleared, sections, {
      signal: input.signal,
      encounterId: input.encounterId,
    }),
  );

  const { kept, dropped } = backedQuestions({
    answered: answer.value.questions,
    markers: conversation.markers,
    textSections: sections.map((section) => section.key),
    discarded: input.discarded,
    restore: (text) =>
      unshiftDates(
        restorePlaceholders(text, cleared.replacements),
        cleared.dateShiftDays,
      ),
  });
  return { kept, dropped, runId: answer.runId };
}

/**
 * AS-119, AS-124. The one request of a review: the cleared conversation and
 * note with the template after them. The evaluation harness (AS-126) sends
 * this same request.
 */
export function questionsRequest(
  cleared: PseudonymizedText,
  template: readonly { key: string; title: string; help: string }[],
  extras: { signal?: AbortSignal; encounterId?: string } = {},
) {
  return {
    tier: 'fast',
    purpose: QUESTIONS_PURPOSE,
    promptVersion: QUESTIONS_PROMPT_VERSION,
    system: QUESTIONS_INSTRUCTIONS,
    prompt: withContext(cleared, templateBlock(template)),
    answer: questionsAnswer,
    maxTokens: QUESTIONS_MAX_TOKENS,
    cacheable: true,
    ...extras,
  } satisfies LlmRequest<typeof questionsAnswer>;
}
