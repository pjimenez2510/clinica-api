import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  AuthorizationRepository,
  ChartContact,
  ChartLookup,
  GrantAuthorizationResult,
  NewAuthorization,
  PatientAuthorizationView,
  Requester,
  RevokeAuthorizationResult,
} from '../domain/privacy.repository';

import {
  isAuthorizationRevocationRace,
  isSecondStandingAuthorization,
} from './privacy-database-errors';
import { chartLookup, nameOf, staffNames, writeTrail } from './privacy-reads';

const AUTHORIZATION_SELECT = {
  id: true,
  patientId: true,
  purpose: true,
  channel: true,
  recordedAt: true,
  recordedBy: true,
  revocation: { select: { revokedAt: true, revokedBy: true } },
} satisfies Prisma.PatientAuthorizationSelect;

type AuthorizationRow = Prisma.PatientAuthorizationGetPayload<{
  select: typeof AUTHORIZATION_SELECT;
}>;

@Injectable()
export class PrismaAuthorizationRepository implements AuthorizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  chartOf(patientId: string): Promise<ChartLookup> {
    return chartLookup(this.prisma, patientId);
  }

  async contactOf(patientId: string): Promise<ChartContact> {
    const chart = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { phone: true, email: true },
    });
    return {
      hasPhone: !!chart?.phone?.trim(),
      hasEmail: !!chart?.email?.trim(),
    };
  }

  async grant(
    authorization: NewAuthorization,
    requester: Requester,
    now: Date,
  ): Promise<GrantAuthorizationResult> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.patientAuthorization.create({
          data: {
            patientId: authorization.patientId,
            purpose: authorization.purpose,
            channel: authorization.channel,
            recordedAt: now,
            recordedBy: requester.userId,
          },
          select: AUTHORIZATION_SELECT,
        });
        await writeTrail(
          tx,
          {
            resourceType: 'patient_authorization',
            resourceId: created.id,
            action: 'CREATE',
          },
          requester,
        );
        return created;
      });
      const [view] = await this.views([row]);
      return { status: 'granted', authorization: view! };
    } catch (error) {
      // PD-071: `patient_authorization_one_standing` decides, under its lock.
      if (isSecondStandingAuthorization(error)) {
        return { status: 'already-granted' };
      }
      throw error;
    }
  }

  async revoke(
    patientId: string,
    authorizationId: string,
    requester: Requester,
    now: Date,
  ): Promise<RevokeAuthorizationResult> {
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const found = await tx.patientAuthorization.findFirst({
          where: { id: authorizationId, ...chartScope(patientId) },
          select: {
            id: true,
            revocation: { select: { authorizationId: true } },
          },
        });
        if (!found) return { status: 'missing' as const };
        if (found.revocation) return { status: 'already-revoked' as const };

        await tx.patientAuthorizationRevocation.create({
          data: {
            authorizationId: found.id,
            revokedAt: now,
            revokedBy: requester.userId,
          },
        });
        await writeTrail(
          tx,
          {
            resourceType: 'patient_authorization_revocation',
            resourceId: found.id,
            action: 'CREATE',
          },
          requester,
        );
        const row = await tx.patientAuthorization.findUniqueOrThrow({
          where: { id: found.id },
          select: AUTHORIZATION_SELECT,
        });
        return { status: 'revoked' as const, row };
      });
      if (outcome.status !== 'revoked') return outcome;
      const [view] = await this.views([outcome.row]);
      return { status: 'revoked', authorization: view! };
    } catch (error) {
      // Two revocations at once: the key of the revocation lets one through.
      if (isAuthorizationRevocationRace(error)) {
        return { status: 'already-revoked' };
      }
      throw error;
    }
  }

  async authorizationsOf(
    patientId: string,
  ): Promise<PatientAuthorizationView[]> {
    const rows = await this.prisma.patientAuthorization.findMany({
      where: chartScope(patientId),
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      select: AUTHORIZATION_SELECT,
    });
    return this.views(rows);
  }

  private async views(
    rows: readonly AuthorizationRow[],
  ): Promise<PatientAuthorizationView[]> {
    const names = await staffNames(
      this.prisma,
      rows.flatMap((row) => [
        row.recordedBy,
        row.revocation?.revokedBy ?? null,
      ]),
    );
    return rows.map((row) => ({
      id: row.id,
      patientId: row.patientId,
      purpose: row.purpose,
      channel: row.channel,
      recordedAt: row.recordedAt,
      recordedBy: nameOf(names, row.recordedBy),
      revokedAt: row.revocation?.revokedAt ?? null,
      revokedBy: row.revocation
        ? nameOf(names, row.revocation.revokedBy)
        : null,
    }));
  }
}
