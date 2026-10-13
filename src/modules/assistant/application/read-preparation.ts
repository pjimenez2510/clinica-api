import { PseudonymizerFailedError } from '../domain/assistant.errors';
import { unshiftDates } from '../domain/date-restore';
import { conversationOf, type TranscriptLine } from '../domain/note-draft';
import {
  readPreparationAnswer,
  sentencesOf,
  type PreparationProposal,
} from '../domain/preparation-reading';
import { carriesAnIdentifier } from '../domain/problem-coding';

import type {
  LlmClient,
  LlmRequest,
  PseudonymizedText,
} from './llm-client.port';
import {
  PREPARATION_INSTRUCTIONS,
  PREPARATION_MAX_TOKENS,
  PREPARATION_PROMPT_VERSION,
  PREPARATION_PURPOSE,
  preparationAnswer,
} from './preparation-reading.prompts';
import { type Pseudonymizer, restorePlaceholders } from './pseudonymizer.port';

export interface PreparationReadingDependencies {
  pseudonymizer: Pseudonymizer;
  llm: LlmClient;
}

export interface PreparationReadingInput {
  /** The chart the transcript is about: placeholders stable per patient. */
  subject: string;
  /** AS-025. The people the conversation may name, for the pseudonymizer only. */
  names: string[];
  staff: string[];
  /** The preparation's lines with something said, in order. */
  lines: readonly TranscriptLine[];
  encounterId?: string;
  signal?: AbortSignal;
}

/**
 * AS-245 to AS-250. One reading of a preparation: its sentences marked and
 * cleared, sent as data, and the answer believed only where the transcript as
 * kept backs it (AS-247). What is answered, by sentence, is in `lines`.
 *
 * The service and the evaluation harness (AS-255) call this same function, so
 * what is measured is what runs.
 */
export async function readPreparation(
  deps: PreparationReadingDependencies,
  input: PreparationReadingInput,
): Promise<{
  proposal: PreparationProposal;
  lines: TranscriptLine[];
  runId: string | null;
}> {
  const lines = sentencesOf(input.lines);
  const { text, markers } = conversationOf(lines);
  const cleared = await deps.pseudonymizer.pseudonymize(
    { text, subject: input.subject, names: input.names, staff: input.staff },
    input.signal,
  );
  // AS-025 (P4). An identifier still there means the pseudonymizer missed
  // it: nothing leaves.
  if (carriesAnIdentifier(cleared.cleared)) {
    throw new PseudonymizerFailedError('invalid-answer');
  }

  const answer = await deps.llm.generate(
    preparationRequest(cleared.cleared, {
      signal: input.signal,
      encounterId: input.encounterId,
    }),
  );

  return {
    proposal: readPreparationAnswer({
      answer: answer.value,
      lines,
      markers,
      restore: (phrase) =>
        unshiftDates(
          restorePlaceholders(phrase, cleared.replacements),
          cleared.dateShiftDays,
        ),
    }),
    lines,
    runId: answer.runId,
  };
}

/** AS-245. The one request of a reading; the harness sends this same one. */
export function preparationRequest(
  cleared: PseudonymizedText,
  extras: { signal?: AbortSignal; encounterId?: string } = {},
) {
  return {
    tier: 'fast',
    purpose: PREPARATION_PURPOSE,
    promptVersion: PREPARATION_PROMPT_VERSION,
    system: PREPARATION_INSTRUCTIONS,
    prompt: cleared,
    answer: preparationAnswer,
    maxTokens: PREPARATION_MAX_TOKENS,
    ...extras,
  } satisfies LlmRequest<typeof preparationAnswer>;
}
