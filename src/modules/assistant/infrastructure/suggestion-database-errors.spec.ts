import { describe, expect, it } from 'vitest';

import {
  AssistantNoteNotOpenError,
  SuggestionOrderMismatchError,
} from '../domain/assistant.errors';

import { suggestionErrorFrom } from './suggestion-database-errors';

/** The shape Prisma's driver adapter gives a PostgreSQL refusal. */
const refusal = (code: string, originalMessage: string) => ({
  code: 'P2010',
  meta: { driverAdapterError: { cause: { code, originalMessage } } },
});

describe('suggestionErrorFrom', () => {
  it('AS-109 translates the unique index of an ordered exam to its code', () => {
    expect(
      suggestionErrorFrom(refusal('23505', 'duplicate key value violates unique constraint "ai_suggestion_one_per_ordered_exam"')), // prettier-ignore
    ).toBeInstanceOf(SuggestionOrderMismatchError);
  });

  it('AS-124 translates the refusal of a question of a signed note to ASSISTANT_NOTE_NOT_OPEN', () => {
    expect(
      suggestionErrorFrom(refusal('23514', 'note_question_of_a_draft: the consultation note of this attention is not a draft')), // prettier-ignore
    ).toBeInstanceOf(AssistantNoteNotOpenError);
  });

  it('AS-109 AS-124 leaves any other refusal as it came', () => {
    expect(suggestionErrorFrom(refusal('23505', 'duplicate key value violates unique constraint "ai_suggestion_pkey"'))).toBeUndefined(); // prettier-ignore
    expect(suggestionErrorFrom(refusal('23514', 'note_question_check_run_of_its_encounter: the attempt is not an answer'))).toBeUndefined(); // prettier-ignore
    expect(suggestionErrorFrom(refusal('23514', 'new row violates check constraint "x" — note_question_of_a_draft: in a detail'))).toBeUndefined(); // prettier-ignore
    expect(suggestionErrorFrom(refusal('23505', 'note_question_of_a_draft: wrong state'))).toBeUndefined(); // prettier-ignore
    expect(suggestionErrorFrom(new Error('boom'))).toBeUndefined();
    expect(suggestionErrorFrom(null)).toBeUndefined();
  });
});
