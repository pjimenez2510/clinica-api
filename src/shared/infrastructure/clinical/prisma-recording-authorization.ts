import { Injectable } from '@nestjs/common';

import type {
  RecordingAuthorization,
  RecordingAuthorizationRecorder,
} from '../../clinical/recording-authorization.port';
import { chartScopeOfSurvivor } from '../prisma/patient-chart-scope';
import { PrismaService } from '../prisma/prisma.service';

const PURPOSE = 'ASSISTANT_RECORDING';

/**
 * AS-164 to AS-168. `patient_authorization` with the purpose
 * `ASSISTANT_RECORDING`, read across the person's charts
 * (`chartScopeOfSurvivor`) and written on the surviving one — where `privacy`
 * shows it and revokes it (PD-072, PD-073).
 */
@Injectable()
export class PrismaRecordingAuthorization implements RecordingAuthorization {
  constructor(private readonly prisma: PrismaService) {}

  async isAuthorized(patientId: string): Promise<boolean> {
    const standing = await this.prisma.patientAuthorization.count({
      where: {
        purpose: PURPOSE,
        revocation: null,
        ...chartScopeOfSurvivor(patientId),
      },
    });
    return standing > 0;
  }

  async grant(
    patientId: string,
    by: RecordingAuthorizationRecorder,
    now: Date,
  ): Promise<void> {
    if (await this.isAuthorized(patientId)) return;
    const chart = await this.prisma.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: { mergedIntoId: true },
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.patientAuthorization.create({
          data: {
            patientId: chart.mergedIntoId ?? patientId,
            purpose: PURPOSE,
            channel: null,
            recordedAt: now,
            recordedBy: by.userId,
          },
          select: { id: true },
        });
        // PD-074, as `privacy` writes it.
        await tx.accessAudit.create({
          data: {
            userId: by.userId,
            resourceType: 'patient_authorization',
            resourceId: created.id,
            action: 'CREATE',
            ip: by.ip,
            userAgent: by.userAgent?.slice(0, 512),
          },
        });
      });
    } catch (error) {
      // PD-071: two at once — `trg_patient_authorization_one_standing` lets
      // one through. The other finds it standing, which is what was asked.
      if (await this.isAuthorized(patientId)) return;
      throw error;
    }
  }
}
