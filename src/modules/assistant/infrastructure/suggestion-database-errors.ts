import {
  AssistantNoteNotOpenError,
  SuggestionChartMismatchError,
  SuggestionOrderMismatchError,
} from '../domain/assistant.errors';

/**
 * AS-124. A question, or its review, kept after the 002 was signed: the
 * trigger `note_question_of_a_draft` refuses it, and the client hears the
 * same code as asking on a signed note (AS-119).
 *
 * AS-109. Two links of the same exam of the same order at once: the second
 * hits `ai_suggestion_one_per_ordered_exam`, and the client hears the
 * contracted code instead of a generic duplicate (code review of
 * 12-10-2026, 11).
 *
 * Only the CONSTRAINT NAME is read, from where Prisma's driver adapter puts
 * it, or from the head of the trigger's RAISE (`<name>: …`) — the offending row rides in its detail and never leaves (as
 * `specialties-database-errors.ts`).
 */
interface PrismaErrorLike {
  code?: unknown;
  meta?: {
    driverAdapterError?: {
      cause?: {
        code?: unknown;
        originalCode?: unknown;
        originalMessage?: unknown;
        constraint?: { index?: unknown };
      };
    };
  };
}

const ONE_PER_ORDERED_EXAM = 'ai_suggestion_one_per_ordered_exam';
const QUESTION_OF_A_DRAFT = 'note_question_of_a_draft';
/** AS-265, AS-266. A chart record answers one proposal, the one it was made for. */
const ONE_PER_CHART_RECORD = [
  'ai_suggestion_one_per_patient_allergy',
  'ai_suggestion_one_per_patient_allergy_absence',
  'ai_suggestion_one_per_patient_history',
];
const CHART_RECORD_IS_THE_ANSWER = 'ai_suggestion_chart_record_is_the_answer';

export function suggestionErrorFrom(error: unknown): Error | undefined {
  if (
    refusedBy(
      error,
      '23505',
      (message) => message.includes(`constraint "${ONE_PER_ORDERED_EXAM}"`),
      ONE_PER_ORDERED_EXAM,
    )
  ) {
    return new SuggestionOrderMismatchError();
  }
  if (
    refusedBy(
      error,
      '23514',
      (message) => message.startsWith(`${QUESTION_OF_A_DRAFT}:`),
      QUESTION_OF_A_DRAFT,
    )
  ) {
    return new AssistantNoteNotOpenError();
  }
  for (const index of ONE_PER_CHART_RECORD) {
    if (
      refusedBy(
        error,
        '23505',
        (message) => message.includes(`constraint "${index}"`),
        index,
      )
    ) {
      // prettier-ignore
      return new SuggestionChartMismatchError();
    }
  }
  if (
    refusedBy(
      error,
      '23514',
      (message) => message.startsWith(`${CHART_RECORD_IS_THE_ANSWER}:`),
      CHART_RECORD_IS_THE_ANSWER,
    )
  ) {
    return new SuggestionChartMismatchError();
  }
  return undefined;
}

function refusedBy(
  error: unknown,
  sqlState: string,
  names: (message: string) => boolean,
  constraint: string,
): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const cause = (error as PrismaErrorLike).meta?.driverAdapterError?.cause;
  if ((cause?.code ?? cause?.originalCode) !== sqlState) return false;
  const message = cause?.originalMessage;
  return (
    cause?.constraint?.index === constraint ||
    (typeof message === 'string' && names(message))
  );
}
