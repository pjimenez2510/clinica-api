import { Injectable } from '@nestjs/common';

import { FORM_002_BUILT_IN_SECTIONS } from '../../clinical/form-002';
import type {
  ClinicalVocabulary,
  DraftNote,
  DraftNoteSection,
  NoteDraftContextReader,
} from '../../clinical/note-draft-context.port';
import { PrismaService } from '../prisma/prisma.service';

const CONSULTATION_FORM = '002';
/** AS-092. How many signed notes lend their words to the protected set. */
const NOTES_READ = 2_000;

/**
 * AS-086, AS-088, AS-092. The consultation note in draft with its own
 * template, and the vocabulary of the lexicon. No site scope: whoever calls
 * already holds the attention through `CodingContextReader.encounter()`.
 */
@Injectable()
export class PrismaNoteDraftContextReader implements NoteDraftContextReader {
  constructor(private readonly prisma: PrismaService) {}

  async consultationDraft(encounterId: string): Promise<DraftNote | null> {
    const note = await this.prisma.clinicalNote.findFirst({
      where: { encounterId, formCode: CONSULTATION_FORM, status: 'DRAFT' },
      orderBy: { version: 'desc' },
      select: { id: true, template: { select: { sections: true } } },
    });
    if (!note) return null;
    // EN-204. The template the note was opened with; the built-in one when
    // it was opened without a published template.
    const declared =
      (note.template?.sections as Partial<DraftNoteSection>[] | undefined) ??
      FORM_002_BUILT_IN_SECTIONS.map((section) => ({ ...section, kind: 'TEXT' as const })); // prettier-ignore
    return {
      id: note.id,
      sections: declared.map((section) => ({
        key: String(section.key),
        title: String(section.title ?? section.key),
        help: String(section.help ?? ''),
        kind: section.kind === 'CHOICE' ? 'CHOICE' : 'TEXT',
      })),
    };
  }

  async vocabulary(): Promise<ClinicalVocabulary> {
    const [principles, cie10, notes] = await Promise.all([
      this.prisma.catalogConcept.findMany({
        where: { system: { code: 'CNMB' } },
        select: { display: true },
      }),
      this.prisma.catalogConcept.findMany({
        where: { system: { code: 'CIE10' } },
        select: { display: true },
      }),
      this.prisma.clinicalNote.findMany({
        where: { status: 'SIGNED' },
        orderBy: { signedAt: 'desc' },
        take: NOTES_READ,
        select: { content: true },
      }),
    ]);
    const written = notes.flatMap(({ content }) =>
      Object.values((content ?? {}) as Record<string, unknown>).filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    return {
      principles: principles.map(({ display }) => display),
      protectedWords: [...cie10.map(({ display }) => display), ...written],
    };
  }
}
