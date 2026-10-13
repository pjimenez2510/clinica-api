import { Injectable } from '@nestjs/common';

import {
  chartRecordText,
  type ChartBackgroundReader,
  type ChartHistoryEntry,
  type ChartRecord,
  type ChartRecordKind,
} from '../../clinical/chart-background.port';
import { chartScope } from '../prisma/patient-chart-scope';
import { PrismaService } from '../prisma/prisma.service';

/** AS-263, AS-265 over PostgreSQL. Reads the chart; writes nothing. */
@Injectable()
export class PrismaChartBackgroundReader implements ChartBackgroundReader {
  constructor(private readonly prisma: PrismaService) {}

  async activeHistory(chartId: string): Promise<ChartHistoryEntry[]> {
    const rows = await this.prisma.patientHistory.findMany({
      // PA-055. The chart and those it absorbed, as the history panel reads it.
      where: { ...chartScope(chartId), refutedAt: null },
      select: { kind: true, description: true, relative: true },
    });
    return rows.map((row) => ({
      kind: row.kind,
      description: row.description,
      relative: row.relative,
    }));
  }

  async record(kind: ChartRecordKind, id: string): Promise<ChartRecord | null> {
    if (kind === 'allergy') {
      const row = await this.prisma.patientAllergy.findUnique({
        where: { id },
        select: { patientId: true, recordedById: true, recordedAt: true, substanceText: true, reaction: true, refutedAt: true }, // prettier-ignore
      });
      return row
        ? {
            patientId: row.patientId,
            authorId: row.recordedById,
            recordedAt: row.recordedAt,
            withdrawn: row.refutedAt !== null,
            text: chartRecordText({ kind, substance: row.substanceText, reaction: row.reaction }), // prettier-ignore
          }
        : null;
    }
    if (kind === 'absence') {
      const row = await this.prisma.patientAllergyAbsence.findUnique({
        where: { id },
        select: {
          patientId: true,
          assertedById: true,
          assertedAt: true,
          retractedAt: true,
        },
      });
      return row
        ? {
            patientId: row.patientId,
            authorId: row.assertedById,
            recordedAt: row.assertedAt,
            withdrawn: row.retractedAt !== null,
            text: chartRecordText({ kind }),
          }
        : null;
    }
    const row = await this.prisma.patientHistory.findUnique({
      where: { id },
      select: { patientId: true, recordedById: true, recordedAt: true, description: true, relative: true, refutedAt: true }, // prettier-ignore
    });
    return row
      ? {
          patientId: row.patientId,
          authorId: row.recordedById,
          recordedAt: row.recordedAt,
          withdrawn: row.refutedAt !== null,
          text: chartRecordText({ kind, description: row.description, relative: row.relative }), // prettier-ignore
        }
      : null;
  }
}
