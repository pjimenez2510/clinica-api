import { PseudonymizerFailedError } from '../domain/assistant.errors';
import { backedChart, type ChartProposal } from '../domain/chart-background';
import { unshiftDates } from '../domain/date-restore';
import type { Lexicon } from '../domain/lexicon';
import { conversationOf, type TranscriptLine } from '../domain/note-draft';
import { carriesAnIdentifier } from '../domain/problem-coding';

import {
  CHART_INSTRUCTIONS,
  CHART_MAX_TOKENS,
  CHART_PROMPT_VERSION,
  CHART_PURPOSE,
  chartAnswer,
} from './chart-background.prompts';
import type {
  LlmClient,
  LlmRequest,
  PseudonymizedText,
} from './llm-client.port';
import { heardLines } from './note-writer';
import { type Pseudonymizer, restorePlaceholders } from './pseudonymizer.port';

export interface ChartReaderDependencies {
  pseudonymizer: Pseudonymizer;
  llm: LlmClient;
  /** AS-092. `null` when the vocabulary could not be read: nothing is corrected. */
  lexicon: Lexicon | null;
}

export interface ChartReadingInput {
  /** The chart the transcript is about: placeholders stable per patient. */
  subject: string;
  /** AS-025. The people the conversation may name, for the pseudonymizer only. */
  names: string[];
  staff: string[];
  lines: readonly TranscriptLine[];
  encounterId?: string;
  signal?: AbortSignal;
}

export interface ChartReading {
  kept: ChartProposal[];
  /** AS-262. How many had nothing behind them: a count, never the entries. */
  dropped: number;
  /** The attempt of `ai_run` that answered; null if it was not kept. */
  runId: string | null;
}

/**
 * AS-260, AS-262. One reading of the chart out of the conversation: the
 * lines corrected and cleared as the draft's (AS-092, P4), one call, and the
 * answer read back with every text restored and checked against its line.
 * The service and the evaluation harness (AS-277) call this same function,
 * so what is measured is what runs.
 */
export async function readChart(
  deps: ChartReaderDependencies,
  input: ChartReadingInput,
): Promise<ChartReading> {
  const { heard } = heardLines(input.lines, deps.lexicon);
  const conversation = conversationOf(heard);
  const cleared = await deps.pseudonymizer.pseudonymize(
    {
      text: conversation.text,
      subject: input.subject,
      names: input.names,
      staff: input.staff,
    },
    input.signal,
  );
  // AS-025 (P4). An identifier still there: nothing leaves.
  if (carriesAnIdentifier(cleared.cleared)) {
    throw new PseudonymizerFailedError('invalid-answer');
  }
  const answer = await deps.llm.generate(
    chartRequest(cleared.cleared, {
      signal: input.signal,
      encounterId: input.encounterId,
    }),
  );
  const backed = backedChart({
    answer: answer.value,
    // As the model read them: a substance the lexicon joined («para
    // acetamol») is said in its line. The quote shown is read again from
    // the transcript as it was heard (AS-263).
    markers: conversation.markers,
    restore: (text) =>
      unshiftDates(
        restorePlaceholders(text, cleared.replacements),
        cleared.dateShiftDays,
      ),
  });
  return { ...backed, runId: answer.runId };
}

/** AS-260. The one request of a reading of the chart; the harness sends this same one. */
export function chartRequest(
  cleared: PseudonymizedText,
  extras: { signal?: AbortSignal; encounterId?: string } = {},
) {
  return {
    tier: 'quality',
    purpose: CHART_PURPOSE,
    promptVersion: CHART_PROMPT_VERSION,
    system: CHART_INSTRUCTIONS,
    prompt: cleared,
    answer: chartAnswer,
    maxTokens: CHART_MAX_TOKENS,
    ...extras,
  } satisfies LlmRequest<typeof chartAnswer>;
}
