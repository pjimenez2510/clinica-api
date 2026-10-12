import { SuggestionOrderMismatchError } from '../domain/assistant.errors';

/**
 * AS-109. Two links of the same exam of the same order at once: the second
 * hits `ai_suggestion_one_per_ordered_exam`, and the client hears the
 * contracted code instead of a generic duplicate (code review of
 * 12-10-2026, 11).
 *
 * Only the CONSTRAINT NAME is read, from where Prisma's driver adapter puts
 * it — the offending row rides in its detail and never leaves (as
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

export function suggestionErrorFrom(error: unknown): Error | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as PrismaErrorLike).meta?.driverAdapterError?.cause;
  if ((cause?.code ?? cause?.originalCode) !== '23505') return undefined;
  const index = cause?.constraint?.index;
  const message = cause?.originalMessage;
  const named =
    index === ONE_PER_ORDERED_EXAM ||
    (typeof message === 'string' &&
      message.includes(`constraint "${ONE_PER_ORDERED_EXAM}"`));
  return named ? new SuggestionOrderMismatchError() : undefined;
}
