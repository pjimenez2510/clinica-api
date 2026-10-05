import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * EN-200 to EN-205. The note template on the wire.
 *
 * The DTO checks the SHAPE — strings, a known kind, a list of strings — and
 * the domain (`publishableSections`) checks the RULES: which sections are the
 * minimum, how many options a list needs, that no title repeats. Two places
 * stating the same rule would end up disagreeing on it.
 */

const SECTION_KIND = z.enum(['TEXT', 'CHOICE']);

export const noteSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  help: z.string(),
  kind: SECTION_KIND,
  options: z.array(z.string()),
  required: z.boolean(),
  /** EN-201. One of the six of EN-020: cannot be removed nor made optional. */
  minimum: z.boolean(),
});

export const noteTemplateSchema = z.object({
  /** `null` for the built-in template, which no clinic has published. */
  id: z.uuid().nullable(),
  formCode: z.string(),
  specialtyId: z.uuid().nullable(),
  /** `0` for the built-in template. */
  version: z.number().int(),
  sections: z.array(noteSectionSchema),
});
export class NoteTemplateDto extends createZodDto(noteTemplateSchema) {}

export const noteTemplateSummarySchema = noteTemplateSchema.extend({
  specialtyName: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  publishedByName: z.string().nullable(),
});
export class NoteTemplateSummaryDto extends createZodDto(
  noteTemplateSummarySchema,
) {}

export const noteTemplateListSchema = z.object({
  /** The clinic's template first —the built-in one if never published—, then one per specialty. */
  items: z.array(noteTemplateSummarySchema),
});
export class NoteTemplateListDto extends createZodDto(noteTemplateListSchema) {}

/** Body of POST /note-templates: publishes the next version. */
export const publishNoteTemplateSchema = z.object({
  formCode: z.string().trim().default('002'),
  /**
   * EN-200. The version the screen edited: 0 when the template did not exist
   * yet. Publishing over an older one is refused (`NOTE_TEMPLATE_STALE`).
   */
  baseVersion: z.number().int().min(0),
  /** Absent or `null`: the clinic's template (D-124). */
  specialtyId: z
    .uuid({ error: 'Especialidad no válida' })
    .nullable()
    .default(null),
  sections: z
    .array(
      z.object({
        key: z.string().trim().max(32).optional(),
        title: z.string({ error: 'El título es texto' }),
        help: z.string().default(''),
        kind: SECTION_KIND,
        options: z.array(z.string()).optional(),
        required: z.boolean(),
      }),
    )
    .min(1, 'La nota lleva al menos las secciones del contenido mínimo'),
});
export class PublishNoteTemplateDto extends createZodDto(
  publishNoteTemplateSchema,
) {}

/** Query of GET /note-templates/current. Absent: the clinic's. */
export const currentNoteTemplateQuerySchema = z.object({
  specialtyId: z.uuid({ error: 'Especialidad no válida' }).optional(),
});
export class CurrentNoteTemplateQueryDto extends createZodDto(
  currentNoteTemplateQuerySchema,
) {}

export type NoteTemplateResponse = z.infer<typeof noteTemplateSchema>;
export type NoteTemplateSummaryResponse = z.infer<
  typeof noteTemplateSummarySchema
>;
export type NoteTemplateListResponse = z.infer<typeof noteTemplateListSchema>;
