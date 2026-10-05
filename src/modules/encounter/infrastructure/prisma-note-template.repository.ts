import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { NoteSection, NoteTemplate } from '../domain/note-template';
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

  async listLatest(formCode: string): Promise<NoteTemplateSummary[]> {
    const rows = await this.prisma.clinicalNoteTemplate.findMany({
      where: { formCode },
      distinct: ['specialtyId'],
      orderBy: [{ specialtyId: 'asc' }, { version: 'desc' }],
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

      const newest = await tx.clinicalNoteTemplate.findFirst({
        where: { formCode: input.formCode, specialtyId: input.specialtyId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const row = await tx.clinicalNoteTemplate.create({
        data: {
          formCode: input.formCode,
          specialtyId: input.specialtyId,
          version: (newest?.version ?? 0) + 1,
          sections: input.sections as unknown as Prisma.InputJsonValue,
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
