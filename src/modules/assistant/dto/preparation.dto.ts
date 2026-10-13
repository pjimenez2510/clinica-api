import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PREPARATION_FIELDS, SPEAKERS } from '../domain/preparation-reading';

/**
 * AS-245 to AS-251 (B3). The contract of the preparation's reading.
 * Responses are schemas so `clinica-web` types them from OpenAPI.
 */
const field = z.enum(PREPARATION_FIELDS);

const proposed = z.object({
  value: z.number(),
  /** The start of the line it was said in; null when no single line holds it (AS-251). */
  startMs: z.number().int().nullable(),
  /** The phrase of that line that says it, as it was heard. */
  quote: z.string().nullable(),
});

export const preparationReadingSchema = z.object({
  /** AS-251. `rules` when the assistant could not read: «Leído sin asistente». */
  reader: z.enum(['assistant', 'rules']),
  /** AS-254. Read by the demonstration's script. */
  demo: z.boolean(),
  /** AS-250. Each line with who said it; null when the rules read it. */
  lines: z.array(
    z.object({
      startMs: z.number().int(),
      endMs: z.number().int(),
      text: z.string(),
      speaker: z.enum(SPEAKERS).nullable(),
    }),
  ),
  /** AS-246, AS-247. The values proposed, by the name of the taking's field. */
  values: z.partialRecord(field, proposed),
  /** AS-248. How the height was taken. */
  heightPosition: proposed
    .extend({ value: z.enum(['STANDING', 'LYING']) })
    .nullable(),
  /** AS-247, AS-248. Named but not proposed: typed by hand. */
  unclear: z.array(field),
  /** AS-249. The patient's own phrase. */
  complaint: z
    .object({ text: z.string(), startMs: z.number().int() })
    .nullable(),
  /** How far the transcript read goes, in the listening's clock. */
  upToMs: z.number().int(),
});

export class PreparationReadingDto extends createZodDto(
  preparationReadingSchema,
) {}
