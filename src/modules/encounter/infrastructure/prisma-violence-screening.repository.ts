import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { EncounterStatus } from '../domain/encounter';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import type { EncounterQuery } from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import type {
  ScreeningAnswer,
  ScreeningRecord,
} from '../domain/violence-screening';
import type {
  ScreeningSave,
  ScreeningTrail,
  ViolenceScreeningRepository,
} from '../domain/violence-screening.repository';

/**
 * The trail's name for block F. It names the SECTION of the attention, not its
 * content, for the same reason the permission does not say «violence».
 */
const SCREENING_RESOURCE_TYPE = 'encounter_screening';

const SCREENING_SELECT = {
  result: true,
  types: true,
  actionTaken: true,
  screeningTool: true,
  reportedToAuthority: true,
  authorityFormSerial: true,
  injury: true,
  aggressorIdentified: true,
  aggressorRelationship: true,
  screenedById: true,
  screenedAt: true,
} satisfies Prisma.ViolenceScreeningSelect;

type ScreeningRow = Prisma.ViolenceScreeningGetPayload<{
  select: typeof SCREENING_SELECT;
}>;

/**
 * Block F (EN-070 to EN-078). The CHECKs of
 * `20261008170000_violence_screening_block_f` are the guarantee; the DTO only
 * says it earlier, per field.
 */
@Injectable()
export class PrismaViolenceScreeningRepository implements ViolenceScreeningRepository {
  constructor(private readonly prisma: PrismaService) {}

  async readWithTrail(
    query: EncounterQuery,
    trail: ScreeningTrail,
  ): Promise<ScreeningRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.violenceScreening.findFirst({
        where: {
          encounterId: query.encounterId,
          encounter: siteFilter(query.sites),
        },
        select: SCREENING_SELECT,
      });
      if (row === null) return null;
      await writeTrail(tx, query.encounterId, 'READ', trail);
      return toRecord(row);
    });
  }

  async save(
    query: EncounterQuery,
    answer: ScreeningAnswer,
    author: { practitionerId: string; at: Date },
    trail: ScreeningTrail,
  ): Promise<ScreeningSave> {
    return this.prisma.$transaction(async (tx) => {
      const inScope = await tx.encounter.findFirst({
        where: { id: query.encounterId, ...siteFilter(query.sites) },
        select: { id: true },
      });
      if (!inScope) throw new EncounterNotFoundError();

      // EN-130. Under the attention's lock, the same one the signature takes:
      // a discharge that landed after the service's read is refused here, and
      // a signature waiting on this lock sees the answer (EN-240).
      const [locked] = await tx.$queryRaw<{ status: EncounterStatus }[]>`
        SELECT "status"::text AS "status" FROM "encounter"
         WHERE "id" = ${query.encounterId}::uuid
           FOR UPDATE`;
      if (!locked) throw new EncounterNotFoundError();
      if (!acceptsNewClinicalContent(locked.status)) {
        throw new EncounterAlreadyClosedError(locked.status);
      }

      const current = await tx.violenceScreening.findUnique({
        where: { encounterId: query.encounterId },
        select: SCREENING_SELECT,
      });
      const columns = toColumns(answer);

      if (current === null) {
        const created = await tx.violenceScreening.create({
          data: {
            encounterId: query.encounterId,
            ...columns,
            screenedById: author.practitionerId,
            screenedAt: author.at,
          },
          select: SCREENING_SELECT,
        });
        await writeTrail(tx, query.encounterId, 'CREATE', trail);
        return { record: toRecord(created), outcome: 'CREATED' };
      }

      if (sameAnswer(toRecord(current), answer)) {
        // What comes back says who answered and when: that is a read.
        await writeTrail(tx, query.encounterId, 'READ', trail);
        return { record: toRecord(current), outcome: 'UNCHANGED' };
      }

      // EN-076. A correction is a new answer: who gave it and when move with
      // it, and `trg_violence_screening_guard` archives the row it replaces.
      const updated = await tx.violenceScreening.update({
        where: { encounterId: query.encounterId },
        data: {
          ...columns,
          screenedById: author.practitionerId,
          screenedAt: author.at,
        },
        select: SCREENING_SELECT,
      });
      await writeTrail(tx, query.encounterId, 'UPDATE', trail);
      return { record: toRecord(updated), outcome: 'UPDATED' };
    });
  }
}

/**
 * EN-075. The row, inside the caller's transaction: it commits with what it
 * records or not at all. No `before`/`after`: the clinical content never goes
 * to `access_audit`, which is never purged.
 */
async function writeTrail(
  tx: Prisma.TransactionClient,
  encounterId: string,
  action: 'READ' | 'CREATE' | 'UPDATE',
  trail: ScreeningTrail,
): Promise<void> {
  await tx.accessAudit.create({
    data: {
      userId: trail.userId,
      resourceType: SCREENING_RESOURCE_TYPE,
      resourceId: encounterId,
      action,
      ip: trail.ip,
      userAgent: trail.userAgent?.slice(0, 512),
    },
  });
}

function toColumns(answer: ScreeningAnswer) {
  return {
    result: answer.result,
    types: answer.types,
    actionTaken: answer.actionTaken,
    screeningTool: answer.screeningTool,
    reportedToAuthority: answer.notification !== null,
    authorityFormSerial: answer.notification?.formSerial ?? null,
    injury: answer.notification?.injury ?? null,
    aggressorIdentified: answer.notification?.aggressorIdentified ?? null,
    aggressorRelationship: answer.notification?.aggressorRelationship ?? null,
  } satisfies Prisma.ViolenceScreeningUncheckedUpdateInput;
}

function toRecord(row: ScreeningRow): ScreeningRecord {
  const notified =
    row.reportedToAuthority &&
    row.authorityFormSerial !== null &&
    row.injury !== null &&
    row.aggressorIdentified !== null &&
    row.aggressorRelationship !== null;
  return {
    result: row.result,
    types: [...row.types],
    actionTaken: row.actionTaken,
    screeningTool: row.screeningTool,
    notification: notified
      ? {
          formSerial: row.authorityFormSerial!,
          injury: row.injury!,
          aggressorIdentified: row.aggressorIdentified!,
          aggressorRelationship: row.aggressorRelationship!,
        }
      : null,
    screenedById: row.screenedById,
    screenedAt: row.screenedAt,
  };
}

function sameAnswer(current: ScreeningRecord, next: ScreeningAnswer): boolean {
  return (
    current.result === next.result &&
    [...current.types].sort().join() === [...next.types].sort().join() &&
    current.actionTaken === next.actionTaken &&
    current.screeningTool === next.screeningTool &&
    JSON.stringify(current.notification) === JSON.stringify(next.notification)
  );
}

function siteFilter(
  sites: EncounterQuery['sites'],
): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}
