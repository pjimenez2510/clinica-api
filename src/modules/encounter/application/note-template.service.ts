import { Inject, Injectable } from '@nestjs/common';

import { NoteTemplateInvalidError } from '../domain/encounter.errors';
import {
  builtInTemplate,
  publishableSections,
  type NoteSectionInput,
  type NoteTemplate,
} from '../domain/note-template';
import {
  NOTE_TEMPLATE_REPOSITORY,
  type NoteTemplateRepository,
  type NoteTemplateSummary,
} from '../domain/note-template.repository';

/** A template in the administration list: the built-in one has no author. */
export type ListedNoteTemplate = NoteTemplate &
  Partial<Pick<NoteTemplateSummary, 'specialtyName' | 'publishedAt' | 'publishedByName'>>; // prettier-ignore

/**
 * EN-200 to EN-203, D-124. Administering the consultation-note template.
 *
 * ITS OWN SERVICE AND NOT A METHOD OF THE NOTE'S: it is configuration with a
 * different reason to change, a different permission (`config:manage`) and
 * no dependency in common with signing a note (ADR-008 §2). What the two
 * share is the repository port, which the note only READS.
 *
 * Publishing is not audited apart: the row IS the record — who published it,
 * when, and exactly what — and no patient's data is in it.
 */
@Injectable()
export class NoteTemplateService {
  constructor(
    @Inject(NOTE_TEMPLATE_REPOSITORY)
    private readonly templates: NoteTemplateRepository,
  ) {}

  /**
   * EN-200. The clinic's template first —the built-in one while nobody has
   * published— and then the newest version of each specialty's.
   */
  async list(formCode: string): Promise<ListedNoteTemplate[]> {
    const published = await this.templates.listLatest(formCode);
    const clinic =
      published.find((template) => template.specialtyId === null) ??
      builtInTemplate(formCode);
    const bySpecialty = published
      .filter((template) => template.specialtyId !== null)
      .sort((a, b) =>
        (a.specialtyName ?? '').localeCompare(b.specialtyName ?? '', 'es'),
      );
    return [clinic, ...bySpecialty];
  }

  /**
   * EN-203. The template a new note of that specialty would use today: its
   * own, else the clinic's, else the built-in one. Where a specialty's
   * template starts from when it does not exist yet.
   */
  async current(
    formCode: string,
    specialtyId: string | null,
  ): Promise<NoteTemplate> {
    return (
      (specialtyId
        ? await this.templates.latest(formCode, specialtyId)
        : null) ??
      (await this.templates.latest(formCode, null)) ??
      builtInTemplate(formCode)
    );
  }

  /**
   * EN-200 to EN-202. Validates and publishes the next version over
   * `baseVersion`, the one the screen edited.
   *
   * Validated once here, so a bad template is refused before any lock is
   * taken, and again inside the transaction with the highest own key any
   * version ever used — the only place that number is current.
   */
  async publish(
    request: {
      formCode: string;
      specialtyId: string | null;
      baseVersion: number;
      sections: readonly NoteSectionInput[];
    },
    publishedById: string,
  ): Promise<NoteTemplateSummary> {
    publishableSections(request.formCode, request.sections);
    if (
      request.specialtyId !== null &&
      !(await this.templates.specialtyExists(request.specialtyId))
    ) {
      throw new NoteTemplateInvalidError(
        'specialtyId',
        'La especialidad no existe',
      );
    }

    return this.templates.publish({
      formCode: request.formCode,
      specialtyId: request.specialtyId,
      baseVersion: request.baseVersion,
      sectionsGiven: (highest) =>
        publishableSections(request.formCode, request.sections, highest),
      publishedById,
      publishedAt: new Date(),
    });
  }
}
