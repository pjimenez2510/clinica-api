import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-122. The contract of the questions «Para completar la nota». Responses
 * are schemas so `clinica-web` types them from OpenAPI.
 */
const questionSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  /** The note's section its answer belongs to, or null. */
  section: z.string().nullable(),
  /** The stretch of its line, in the listening's clock. */
  fromMs: z.number().int(),
  toMs: z.number().int(),
  /** AS-122. The line of the conversation that motivates it, read again. */
  quote: z.string(),
  /** AS-127. Asked by the demonstration's script, not by a model. */
  demo: z.boolean(),
});

export const noteQuestionsOverviewSchema = z.object({
  questions: z.array(questionSchema),
  /** When the review on screen was made; null when there was none. */
  checkedAt: z.iso.datetime().nullable(),
  /** How far the transcript goes: 0 means there is nothing to ask from. */
  transcriptUpToMs: z.number().int(),
  /** AS-029. The demonstration mode is on. */
  demo: z.boolean(),
});
/** Response of GET and POST /encounters/:encounterId/assistant/note-questions. */
export class NoteQuestionsOverviewDto extends createZodDto(
  noteQuestionsOverviewSchema,
) {}
