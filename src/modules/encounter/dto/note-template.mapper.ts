import type { NoteTemplate } from '../domain/note-template';
import type { NoteTemplateSummary } from '../domain/note-template.repository';
import type {
  NoteTemplateResponse,
  NoteTemplateSummaryResponse,
} from './note-template.dto';

/** EN-204. One template on the wire, built-in or published. */
export function toTemplateResponse(
  template: NoteTemplate,
): NoteTemplateResponse {
  return {
    id: template.id,
    formCode: template.formCode,
    specialtyId: template.specialtyId,
    version: template.version,
    sections: template.sections.map((section) => ({
      key: section.key,
      title: section.title,
      help: section.help,
      kind: section.kind,
      options: [...section.options],
      required: section.required,
      minimum: section.minimum,
    })),
  };
}

/** EN-200. A row of the administration list. The built-in one has no author. */
export function toTemplateSummaryResponse(
  template: NoteTemplate &
    Partial<Omit<NoteTemplateSummary, keyof NoteTemplate>>,
): NoteTemplateSummaryResponse {
  return {
    ...toTemplateResponse(template),
    specialtyName: template.specialtyName ?? null,
    publishedAt: template.publishedAt?.toISOString() ?? null,
    publishedByName: template.publishedByName ?? null,
  };
}
