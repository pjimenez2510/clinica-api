import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-086, AS-094, AS-096. The contract of the draft of the note. Responses
 * are schemas so `clinica-web` types them from OpenAPI.
 */

const phraseSchema = z.object({
  text: z.string(),
  /** The stretch of the conversation that says it; null when nothing does. */
  fromMs: z.number().int().nullable(),
  toMs: z.number().int().nullable(),
  /** AS-089. «Nadie lo dijo». */
  unsaid: z.boolean(),
});

const sectionSchema = z.object({
  id: z.uuid(),
  /** The key of the note's section (`clinical_note.content`). */
  section: z.string(),
  title: z.string(),
  /** What «Aceptar» writes into the section. */
  text: z.string(),
  phrases: z.array(phraseSchema),
  status: z.enum([
    'PROPOSED',
    'ACCEPTED',
    'ACCEPTED_WITH_CHANGES',
    'DISCARDED',
  ]),
  /** AS-029, AS-099. Written by the demonstration's script, not by a model. */
  demo: z.boolean(),
});

export const noteDraftOverviewSchema = z.object({
  /** The newest draft asked for; null when none was. */
  draft: z
    .object({
      id: z.uuid(),
      status: z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']),
      upToMs: z.number().int(),
      /** AS-093. The error code of a failed draft. */
      failureCode: z.string().nullable(),
      requestedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** How far the sections shown go, in the listening's clock. */
  coveredUpToMs: z.number().int(),
  transcriptUpToMs: z.number().int(),
  sections: z.array(sectionSchema),
  /** AS-029. The demonstration mode is on. */
  demo: z.boolean(),
});
/** Response of GET and POST /encounters/:encounterId/assistant/note-draft. */
export class NoteDraftOverviewDto extends createZodDto(
  noteDraftOverviewSchema,
) {}

export const acceptDraftSectionSchema = z.object({
  /** The note the screen saved the section into, with `If-Match` (EN-281). */
  noteId: z.uuid({ message: 'Indique la nota en que se guardó la sección' }),
});
/** Body of POST …/note-draft/sections/:suggestionId/accept. */
export class AcceptDraftSectionDto extends createZodDto(
  acceptDraftSectionSchema,
) {}
