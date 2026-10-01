import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { ConsentTextVersionConflictError } from '../domain/privacy.errors';
import type {
  ChartLookup,
  ConsentRepository,
  ConsentTextView,
  NewConsent,
  PatientConsentView,
  RecordConsentResult,
  Requester,
} from '../domain/privacy.repository';

import { isConsentTextRace } from './privacy-database-errors';
import {
  CONSENT_TEXT_SELECT,
  chartLookup,
  nameOf,
  staffNames,
  toTextView,
  writeTrail,
} from './privacy-reads';

const CONSENT_SELECT = {
  id: true,
  patientId: true,
  medium: true,
  grantedBy: true,
  recordedAt: true,
  recordedBy: true,
  textVersion: { select: CONSENT_TEXT_SELECT },
} satisfies Prisma.PatientConsentSelect;

type ConsentRow = Prisma.PatientConsentGetPayload<{
  select: typeof CONSENT_SELECT;
}>;

@Injectable()
export class PrismaConsentRepository implements ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  chartOf(patientId: string): Promise<ChartLookup> {
    return chartLookup(this.prisma, patientId);
  }

  async currentText(): Promise<ConsentTextView | null> {
    const row = await this.prisma.consentTextVersion.findFirst({
      orderBy: { version: 'desc' },
      select: CONSENT_TEXT_SELECT,
    });
    if (!row) return null;
    return toTextView(row, await staffNames(this.prisma, [row.publishedBy]));
  }

  async texts(): Promise<ConsentTextView[]> {
    const rows = await this.prisma.consentTextVersion.findMany({
      orderBy: { version: 'desc' },
      select: CONSENT_TEXT_SELECT,
    });
    const names = await staffNames(
      this.prisma,
      rows.map((row) => row.publishedBy),
    );
    return rows.map((row) => toTextView(row, names));
  }

  async publish(body: string, requester: Requester): Promise<ConsentTextView> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const last = await tx.consentTextVersion.findFirst({
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await tx.consentTextVersion.create({
          data: {
            version: (last?.version ?? 0) + 1,
            body,
            publishedBy: requester.userId,
          },
          select: CONSENT_TEXT_SELECT,
        });
        await writeTrail(
          tx,
          {
            resourceType: 'consent_text_version',
            resourceId: created.id,
            action: 'CREATE',
          },
          requester,
        );
        return created;
      });
      return toTextView(row, await staffNames(this.prisma, [row.publishedBy]));
    } catch (error) {
      if (isConsentTextRace(error)) throw new ConsentTextVersionConflictError();
      throw error;
    }
  }

  async record(
    consent: NewConsent,
    requester: Requester,
  ): Promise<RecordConsentResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await tx.consentTextVersion.findFirst({
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      });
      if (current?.id !== consent.textVersionId) {
        const sent = await tx.consentTextVersion.findUnique({
          where: { id: consent.textVersionId },
          select: { id: true },
        });
        if (!sent || !current) return { status: 'unknown-version' as const };
        return { status: 'outdated' as const, currentVersion: current.version };
      }

      const row = await tx.patientConsent.create({
        data: {
          patientId: consent.patientId,
          textVersionId: consent.textVersionId,
          medium: consent.medium,
          grantedBy: consent.grantedBy,
          recordedBy: requester.userId,
        },
        select: CONSENT_SELECT,
      });
      await writeTrail(
        tx,
        {
          resourceType: 'patient_consent',
          resourceId: row.id,
          action: 'CREATE',
        },
        requester,
      );
      return { status: 'recorded' as const, row };
    });

    if (outcome.status !== 'recorded') return outcome;
    const [consentView] = await this.views([outcome.row]);
    return { status: 'recorded', consent: consentView! };
  }

  async consentsOf(patientId: string): Promise<PatientConsentView[]> {
    const rows = await this.prisma.patientConsent.findMany({
      where: chartScope(patientId),
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      select: CONSENT_SELECT,
    });
    return this.views(rows);
  }

  private async views(rows: ConsentRow[]): Promise<PatientConsentView[]> {
    const names = await staffNames(
      this.prisma,
      rows.flatMap((row) => [row.recordedBy, row.textVersion.publishedBy]),
    );
    return rows.map((row) => ({
      id: row.id,
      patientId: row.patientId,
      textVersion: toTextView(row.textVersion, names),
      medium: row.medium,
      grantedBy: row.grantedBy,
      recordedAt: row.recordedAt,
      recordedBy: nameOf(names, row.recordedBy),
    }));
  }
}
