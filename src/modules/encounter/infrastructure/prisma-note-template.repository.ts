import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { NoteTemplateStaleError } from '../domain/encounter.errors';
import {
  ownKeyIndex,
  type NoteSection,
  type NoteTemplate,
} from '../domain/note-template';
import type {
  NoteTemplateRepository,
  NoteTemplateSummary,
  PublishNoteTemplate,
} from '../domain/note-template.repository';

const TEMPLATE_SELECT = {
  id: true,
  formCode: true,
  specialtyId: true,
  version: true,
  sections: true,
  publishedAt: true,
  publishedBy: { select: { firstName: true, lastName: true } },
  specialty: { select: { name: true } },
} satisfies Prisma.ClinicalNoteTemplateSelect;

type TemplateRow = Prisma.ClinicalNoteTemplateGetPayload<{
  select: typeof TEMPLATE_SELECT;
}>;

const toTemplate = (row: TemplateRow): NoteTemplate => ({
  id: row.id,
  formCode: row.formCode,
  specialtyId: row.specialtyId,
  version: row.version,
  // Written only by `publish`, from sections the domain already validated.
  sections: row.sections as unknown as NoteSection[],
});

const toSummary = (row: TemplateRow): NoteTemplateSummary => ({
  ...toTemplate(row),
  specialtyName: row.specialty?.name ?? null,
  publishedAt: row.publishedAt,
  publishedByName: `${row.publishedBy.firstName} ${row.publishedBy.lastName}`,
});

@Injectable()
export class PrismaNoteTemplateRepository implements NoteTemplateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async latest(
    formCode: string,
    specialtyId: string | null,
  ): Promise<NoteTemplate | null> {
    const row = await this.prisma.clinicalNoteTemplate.findFirst({
      where: { formCode, specialtyId },
      orderBy: { version: 'desc' },
      select: TEMPLATE_SELECT,
    });
    return row ? toTemplate(row) : null;
  }

  async findById(id: string): Promise<NoteTemplate | null> {
    const row = await this.prisma.clinicalNoteTemplate.findUnique({
      where: { id },
      select: TEMPLATE_SELECT,
    });
    return row ? toTemplate(row) : null;
  }

  /**
   * The newest version per template, chosen in SQL: Prisma's `distinct`
   * would fetch every version ever published and discard them in memory.
   */
  async listLatest(formCode: string): Promise<NoteTemplateSummary[]> {
    const newest = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (specialty_id) id::text AS id
        FROM clinical_note_template
       WHERE form_code = ${formCode}
       ORDER BY specialty_id, version DESC
    `;
    if (newest.length === 0) return [];
    const rows = await this.prisma.clinicalNoteTemplate.findMany({
      where: { id: { in: newest.map((row) => row.id) } },
      select: TEMPLATE_SELECT,
    });
    return rows.map(toSummary);
  }

  async publish(input: PublishNoteTemplate): Promise<NoteTemplateSummary> {
    return this.prisma.$transaction(async (tx) => {
      // One publication at a time per template: the advisory lock is keyed by
      // form and specialty, so the clinic's and a specialty's do not wait on
      // each other. The unique index refuses what a lock-free race would do.
      const lockKey = `clinical_note_template:${input.formCode}:${input.specialtyId ?? 'clinic'}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const versions = await tx.clinicalNoteTemplate.findMany({
        where: { formCode: input.formCode, specialtyId: input.specialtyId },
        orderBy: { version: 'desc' },
        select: { version: true, sections: true },
      });
      const current = versions[0]?.version ?? 0;
      // EN-200. Somebody published while this screen edited an older one.
      if (current !== input.baseVersion) {
        throw new NoteTemplateStaleError(input.baseVersion, current);
      }
      // EN-202. No key a removed section ever had is handed out again.
      const highestOwnKeyEverUsed = Math.max(
        0,
        ...versions.flatMap((version) =>
          (version.sections as unknown as NoteSection[]).map((section) =>
            ownKeyIndex(section.key),
          ),
        ),
      );
      const sections = input.sectionsGiven(highestOwnKeyEverUsed);

      const row = await tx.clinicalNoteTemplate.create({
        data: {
          formCode: input.formCode,
          specialtyId: input.specialtyId,
          version: current + 1,
          sections: sections as unknown as Prisma.InputJsonValue,
          publishedAt: input.publishedAt,
          publishedById: input.publishedById,
        },
        select: TEMPLATE_SELECT,
      });
      return toSummary(row);
    });
  }

  async specialtyOfEncounter(encounterId: string): Promise<string | null> {
    const encounter = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: {
        agendaEntry: { select: { serviceType: { select: { specialtyId: true } } } }, // prettier-ignore
        practitioner: {
          select: {
            specialties: {
              where: { isPrimary: true },
              select: { specialtyId: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!encounter) return null;
    return (
      encounter.agendaEntry?.serviceType?.specialtyId ??
      encounter.practitioner.specialties[0]?.specialtyId ??
      null
    );
  }

  async specialtyExists(specialtyId: string): Promise<boolean> {
    const found = await this.prisma.specialty.count({
      where: { id: specialtyId },
    });
    return found > 0;
  }
}
