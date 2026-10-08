import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { EncounterStatus } from '../domain/encounter';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  ScreeningLockedAfterDischargeError,
} from '../domain/encounter.errors';
import type { EncounterQuery } from '../domain/encounter.repository';
import {
  acceptsNewClinicalContent,
  hasDischarge,
} from '../domain/encounter-state';
import {
  admitsAfterDischarge,
  sameTypes,
  type ScreeningAnswer,
  type ScreeningRecord,
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
  notifiedById: true,
  notifiedAt: true,
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
      const live = acceptsNewClinicalContent(locked.status);
      if (!live && !hasDischarge(locked.status)) {
        throw new EncounterAlreadyClosedError(locked.status);
      }

      const found = await tx.violenceScreening.findUnique({
        where: { encounterId: query.encounterId },
        select: SCREENING_SELECT,
      });
      const current = found && toRecord(found);

      if (!live) {
        return completeNotification(tx, query.encounterId, current, answer, author, trail); // prettier-ignore
      }

      const columns = {
        ...toColumns(answer),
        ...notifiedStamp(current, answer, author),
      };

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

      if (sameAnswer(current, answer)) {
        // What comes back says who answered and when: that is a read.
        await writeTrail(tx, query.encounterId, 'READ', trail);
        return { record: current, outcome: 'UNCHANGED' };
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
 * EN-242 (D-188 §5). With the discharge given, only the notification of a
 * screening with signs is completed or corrected; who applied the screening
 * and when stay, and who recorded the notification moves with it.
 * `trg_violence_screening_guard` refuses anything else and archives the row
 * it replaces.
 */
async function completeNotification(
  tx: Prisma.TransactionClient,
  encounterId: string,
  current: ScreeningRecord | null,
  answer: ScreeningAnswer,
  author: { practitionerId: string; at: Date },
  trail: ScreeningTrail,
): Promise<ScreeningSave> {
  if (!admitsAfterDischarge(current, answer) || current === null) {
    throw new ScreeningLockedAfterDischargeError();
  }
  if (sameNotification(current, answer)) {
    await writeTrail(tx, encounterId, 'READ', trail);
    return { record: current, outcome: 'UNCHANGED' };
  }
  const updated = await tx.violenceScreening.update({
    where: { encounterId },
    data: {
      ...notificationColumns(answer),
      notifiedById: author.practitionerId,
      notifiedAt: author.at,
    },
    select: SCREENING_SELECT,
  });
  await writeTrail(tx, encounterId, 'UPDATE', trail);
  return { record: toRecord(updated), outcome: 'UPDATED' };
}

/**
 * EN-074. Who recorded the notification: kept when it did not change, the
 * author when it did, and none when there is none.
 */
function notifiedStamp(
  current: ScreeningRecord | null,
  answer: ScreeningAnswer,
  author: { practitionerId: string; at: Date },
) {
  if (answer.notification === null) {
    return { notifiedById: null, notifiedAt: null };
  }
  if (current !== null && sameNotification(current, answer)) {
    return { notifiedById: current.notifiedById, notifiedAt: current.notifiedAt }; // prettier-ignore
  }
  return { notifiedById: author.practitionerId, notifiedAt: author.at };
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
    ...notificationColumns(answer),
  } satisfies Prisma.ViolenceScreeningUncheckedUpdateInput;
}

/** EN-074. The block copied from the official form, all or nothing. */
function notificationColumns(answer: ScreeningAnswer) {
  return {
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
    notifiedById: notified ? row.notifiedById : null,
    notifiedAt: notified ? row.notifiedAt : null,
  };
}

function sameAnswer(current: ScreeningRecord, next: ScreeningAnswer): boolean {
  return (
    current.result === next.result &&
    sameTypes(current.types, next.types) &&
    current.actionTaken === next.actionTaken &&
    current.screeningTool === next.screeningTool &&
    sameNotification(current, next)
  );
}

function sameNotification(
  current: ScreeningRecord,
  next: ScreeningAnswer,
): boolean {
  const a = current.notification;
  const b = next.notification;
  if (a === null || b === null) return a === b;
  return (
    a.formSerial === b.formSerial &&
    a.injury === b.injury &&
    a.aggressorIdentified === b.aggressorIdentified &&
    a.aggressorRelationship === b.aggressorRelationship
  );
}

function siteFilter(
  sites: EncounterQuery['sites'],
): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}
