import { Injectable } from '@nestjs/common';

import type {
  CodeUse,
  CodingContextReader,
  CodingEncounter,
  CodingPeople,
  NoteSectionText,
} from '../../clinical/coding-context.port';
import { FORM_002_BUILT_IN_SECTIONS } from '../../clinical/form-002';
import { clinicalDateOf } from '../../domain/clinic-time';
import { chartScopeOfSurvivor } from '../prisma/patient-chart-scope';
import { PrismaService } from '../prisma/prisma.service';

/** The consultation note: the one the assistant reads (AS-028). */
const CONSULTATION_FORM = '002';

/**
 * AS-027, AS-028, AS-039. What the assistant reads of an attention, with the
 * site scope of whoever asks (EN-121) and the person's chart scope (PA-055).
 *
 * The person's scope is `chartScopeOfSurvivor`, not `chartScope`: an
 * attention opened on a chart that admissions merged afterwards still points
 * at the absorbed chart, and from there only reading UP finds what the
 * surviving chart was coded with (PR-118).
 */
@Injectable()
export class PrismaCodingContextReader implements CodingContextReader {
  constructor(private readonly prisma: PrismaService) {}

  async encounter(
    encounterId: string,
    sites: 'all' | readonly string[],
  ): Promise<CodingEncounter | null> {
    const row = await this.prisma.encounter.findFirst({
      where: {
        id: encounterId,
        ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }),
      },
      select: {
        id: true,
        patientId: true,
        siteId: true,
        status: true,
        startedAt: true,
        practitioner: { select: { userId: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      patientId: row.patientId,
      siteId: row.siteId,
      practitionerUserId: row.practitioner.userId,
      status: row.status,
      clinicalDate: clinicalDateOf(row.startedAt),
    };
  }

  async noteSections(encounterId: string): Promise<NoteSectionText[]> {
    const note = await this.prisma.clinicalNote.findFirst({
      where: {
        encounterId,
        formCode: CONSULTATION_FORM,
        status: { in: ['DRAFT', 'SIGNED'] },
      },
      orderBy: { version: 'desc' },
      select: { content: true, template: { select: { sections: true } } },
    });
    if (!note) return [];

    const declared = (
      (note.template?.sections as
        { key: string; title: string }[] | undefined) ??
      FORM_002_BUILT_IN_SECTIONS
    ).map(({ key, title }) => ({ key, title }));
    const content = (note.content ?? {}) as Record<string, unknown>;
    const order = [
      ...declared.map(({ key }) => key),
      ...Object.keys(content).filter(
        (key) => !declared.some((section) => section.key === key),
      ),
    ];

    return order.flatMap((key) => {
      const value = content[key];
      if (typeof value !== 'string' || value.trim() === '') return [];
      const label = declared.find((section) => section.key === key)?.title;
      return [{ key, label: label ?? key, text: value }];
    });
  }

  async people(encounterId: string): Promise<CodingPeople> {
    const row = await this.prisma.encounter.findUniqueOrThrow({
      where: { id: encounterId },
      select: {
        patient: {
          select: {
            givenName: true,
            secondGivenName: true,
            familyName: true,
            secondFamilyName: true,
          },
        },
        practitioner: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    const { patient, practitioner } = row;
    return {
      patient: [
        patient.givenName,
        patient.secondGivenName,
        patient.familyName,
        patient.secondFamilyName,
      ].filter((name): name is string => Boolean(name)),
      staff: [practitioner.user.firstName, practitioner.user.lastName],
    };
  }

  async recordedCodes(encounterId: string): Promise<string[]> {
    const rows = await this.prisma.encounterDiagnosis.findMany({
      where: { encounterId },
      select: { cie10Code: true },
    });
    return rows.map((row) => row.cie10Code);
  }

  async patientHistory(
    patientId: string,
    exceptEncounterId: string,
    limit: number,
  ): Promise<CodeUse[]> {
    const rows = await this.prisma.encounterDiagnosis.findMany({
      where: {
        encounter: {
          ...chartScopeOfSurvivor(patientId),
          id: { not: exceptEncounterId },
          status: { not: 'ENTERED_IN_ERROR' },
        },
      },
      select: { cie10Code: true, encounter: { select: { startedAt: true } } },
    });
    return mostUsed(
      rows.map((row) => ({ code: row.cie10Code, at: row.encounter.startedAt })),
      limit,
    );
  }

  async clinicFrequency(since: Date, limit: number): Promise<CodeUse[]> {
    const rows = await this.prisma.encounterDiagnosis.groupBy({
      by: ['cie10Code'],
      where: {
        recordedAt: { gte: since },
        encounter: { status: { not: 'ENTERED_IN_ERROR' } },
      },
      _count: { _all: true },
      _max: { recordedAt: true },
      orderBy: [{ _count: { cie10Code: 'desc' } }, { cie10Code: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      code: row.cie10Code,
      times: row._count._all,
      lastUsedOn: clinicalDateOf(row._max.recordedAt ?? since),
    }));
  }
}

/** Most used first; on a tie the most recent, then the code. */
function mostUsed(
  uses: readonly { code: string; at: Date }[],
  limit: number,
): CodeUse[] {
  const byCode = new Map<string, { times: number; last: Date }>();
  for (const { code, at } of uses) {
    const seen = byCode.get(code);
    byCode.set(code, {
      times: (seen?.times ?? 0) + 1,
      last: seen && seen.last > at ? seen.last : at,
    });
  }
  return [...byCode.entries()]
    .sort(
      ([codeA, a], [codeB, b]) =>
        b.times - a.times ||
        b.last.getTime() - a.last.getTime() ||
        codeA.localeCompare(codeB),
    )
    .slice(0, limit)
    .map(([code, { times, last }]) => ({
      code,
      times,
      lastUsedOn: clinicalDateOf(last),
    }));
}
