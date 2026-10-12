import { PseudonymizerFailedError } from '../domain/assistant.errors';
import { unshiftDates } from '../domain/date-restore';
import { correctLine, type Lexicon } from '../domain/lexicon';
import {
  conversationOf,
  type DraftSection,
  readDraft,
  type TranscriptLine,
} from '../domain/note-draft';
import { carriesAnIdentifier } from '../domain/problem-coding';

import {
  type LlmClient,
  type LlmRequest,
  type PseudonymizedText,
  withContext,
} from './llm-client.port';
import {
  DRAFT_INSTRUCTIONS,
  DRAFT_MAX_TOKENS,
  DRAFT_PROMPT_VERSION,
  DRAFT_PURPOSE,
  type DraftableSection,
  draftAnswerFor,
  templateBlock,
} from './note-draft.prompts';
import { type Pseudonymizer, restorePlaceholders } from './pseudonymizer.port';

export interface WriterDependencies {
  pseudonymizer: Pseudonymizer;
  llm: LlmClient;
  /** AS-092. `null` when the vocabulary could not be read: nothing is corrected. */
  lexicon: Lexicon | null;
}

export interface WriteInput {
  /** The chart the transcript is about: placeholders stable per patient. */
  subject: string;
  /** AS-025. The people the conversation may name, for the pseudonymizer only. */
  names: string[];
  staff: string[];
  lines: readonly TranscriptLine[];
  template: readonly DraftableSection[];
  encounterId?: string;
  signal?: AbortSignal;
}

export interface WrittenDraft {
  sections: DraftSection[];
  /** The attempt of `ai_run` that answered; null if it was not kept. */
  runId: string | null;
  /** AS-092. How many words the lexicon corrected: a count, never the words. */
  corrected: number;
}

/** AS-088. A note's sections that a draft writes: the prose ones (`TEXT`). */
export function draftableSections(
  sections: readonly { key: string; title: string; help: string; kind: 'TEXT' | 'CHOICE' }[], // prettier-ignore
): DraftableSection[] {
  return sections
    .filter((section) => section.kind === 'TEXT')
    .map(({ key, title, help }) => ({ key, title, help }));
}

/**
 * AS-088 to AS-092, AS-095. One draft of the note, from the transcript to the
 * sections the physician will see: corrected against the CNMB, cleared, sent
 * as data with the template after it, read back with every phrase restored
 * and backed by its line or marked «Nadie lo dijo».
 *
 * The service and the evaluation harness (AS-098) call this same function,
 * so what is measured is what runs.
 */
export async function writeNoteDraft(
  deps: WriterDependencies,
  input: WriteInput,
): Promise<WrittenDraft> {
  const { heard, corrected } = heardLines(input.lines, deps.lexicon);
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
  // AS-025 (P4). An identifier still there means the pseudonymizer missed
  // it: nothing leaves.
  if (carriesAnIdentifier(cleared.cleared)) {
    throw new PseudonymizerFailedError('invalid-answer');
  }

  const answer = await deps.llm.generate(
    draftRequest(cleared.cleared, input.template, {
      signal: input.signal,
      encounterId: input.encounterId,
    }),
  );

  const sections = readDraft({
    sections: answer.value.sections,
    markers: conversation.markers,
    template: input.template,
    restore: (text) =>
      unshiftDates(
        restorePlaceholders(text, cleared.replacements),
        cleared.dateShiftDays,
      ),
    // What was heard, before the lexicon: a date is checked against the
    // words as they were said.
    said: input.lines.map((line) => line.text).join('\n'),
  });
  return { sections, runId: answer.runId, corrected };
}

/** AS-092. The lines as the model will read them, corrected; and how many words changed. */
export function heardLines(
  lines: readonly TranscriptLine[],
  lexicon: Lexicon | null,
): { heard: TranscriptLine[]; corrected: number } {
  let corrected = 0;
  const heard = lines.map((line) => {
    if (!lexicon) return { ...line };
    const { text, changes } = correctLine(line.text, lexicon);
    corrected += changes;
    return { ...line, text };
  });
  return { heard, corrected };
}

/**
 * AS-088, AS-095. The one request of a draft: the cleared conversation with
 * the template after it. The evaluation harness (AS-098) sends this same
 * request.
 */
export function draftRequest(
  cleared: PseudonymizedText,
  template: readonly DraftableSection[],
  extras: { signal?: AbortSignal; encounterId?: string } = {},
) {
  return {
    tier: 'quality',
    purpose: DRAFT_PURPOSE,
    promptVersion: DRAFT_PROMPT_VERSION,
    system: DRAFT_INSTRUCTIONS,
    prompt: withContext(cleared, templateBlock(template)),
    answer: draftAnswerFor(template.map((section) => section.key)),
    maxTokens: DRAFT_MAX_TOKENS,
    cacheable: true,
    ...extras,
  } satisfies LlmRequest<ReturnType<typeof draftAnswerFor>>;
}
