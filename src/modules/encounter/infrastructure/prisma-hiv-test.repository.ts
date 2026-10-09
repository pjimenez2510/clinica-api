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
import {
  sameHivTest,
  type HivTestAnswer,
  type HivTestRecord,
} from '../domain/hiv-test';
import type {
  HivTestRepository,
  HivTestSave,
  HivTestTrail,
} from '../domain/hiv-test.repository';

/**
 * The trail's name for block J. It names the SECTION, not its content, for
 * the same reason the permission does not say «HIV».
 */
const RESTRICTED_PROGRAM_RESOURCE_TYPE = 'encounter_restricted_program';

const HIV_TEST_SELECT = {
  reason: true,
  screeningDevice: true,
  screeningResult: true,
  confirmationDevice: true,
  confirmationResult: true,
  transmissionRoute: true,
  viralLoad: true,
  cd4: true,
  recordedAt: true,
  editedAt: true,
} satisfies Prisma.EncounterHivTestSelect;

type HivTestRow = Prisma.EncounterHivTestGetPayload<{
  select: typeof HIV_TEST_SELECT;
}>;

/**
 * Block J (EN-094, EN-095). The CHECKs and triggers of
 * `20261009100300_encounter_program_block_j` are the guarantee; this adds the
 * lock, the stamp and the trail row inside the same transaction.
 */
@Injectable()
export class PrismaHivTestRepository implements HivTestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async readWithTrail(
    query: EncounterQuery,
    trail: HivTestTrail,
  ): Promise<HivTestRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.encounterHivTest.findFirst({
        where: { encounterId: query.encounterId, encounter: siteFilter(query.sites) }, // prettier-ignore
        select: HIV_TEST_SELECT,
      });
      if (row === null) return null;
      await writeTrail(tx, query.encounterId, 'READ', trail);
      return toRecord(row);
    });
  }

  async save(
    query: EncounterQuery,
    answer: HivTestAnswer,
    authorId: string,
    trail: HivTestTrail,
  ): Promise<HivTestSave> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const inScope = await tx.encounter.findFirst({
        where: { id: query.encounterId, ...siteFilter(query.sites) },
        select: { id: true },
      });
      if (!inScope) throw new EncounterNotFoundError();
      const [locked] = await tx.$queryRaw<{ status: EncounterStatus }[]>`
        SELECT "status"::text AS "status" FROM "encounter"
         WHERE "id" = ${query.encounterId}::uuid
           FOR UPDATE`;
      if (!locked) throw new EncounterNotFoundError();
      if (!acceptsNewClinicalContent(locked.status)) {
        throw new EncounterAlreadyClosedError(locked.status);
      }

      const found = await tx.encounterHivTest.findUnique({
        where: { encounterId: query.encounterId },
        select: HIV_TEST_SELECT,
      });
      const columns = toColumns(answer);
      if (found === null) {
        const created = await tx.encounterHivTest.create({
          data: { encounterId: query.encounterId, ...columns, recordedById: authorId, recordedAt: now }, // prettier-ignore
          select: HIV_TEST_SELECT,
        });
        await writeTrail(tx, query.encounterId, 'CREATE', trail);
        return { record: toRecord(created), outcome: 'CREATED' };
      }
      const current = toRecord(found);
      if (sameHivTest(current, answer)) {
        // What comes back discloses what was there: that is a read.
        await writeTrail(tx, query.encounterId, 'READ', trail);
        return { record: current, outcome: 'UNCHANGED' };
      }
      // EN-249. `trg_encounter_hiv_test_archive` refuses an edit whose stamp
      // did not move: a second correction in the same millisecond moves past.
      const previous = current.editedAt ?? current.recordedAt;
      const updated = await tx.encounterHivTest.update({
        where: { encounterId: query.encounterId },
        data: {
          ...columns,
          editedById: authorId,
          editedAt: previous >= now ? new Date(previous.getTime() + 1) : now,
        },
        select: HIV_TEST_SELECT,
      });
      await writeTrail(tx, query.encounterId, 'UPDATE', trail);
      return { record: toRecord(updated), outcome: 'UPDATED' };
    });
  }
}

/**
 * EN-095. The row, inside the caller's transaction: it commits with what it
 * records or not at all. No `before`/`after`: the clinical content never goes
 * to `access_audit`, which is never purged.
 */
async function writeTrail(
  tx: Prisma.TransactionClient,
  encounterId: string,
  action: 'READ' | 'CREATE' | 'UPDATE',
  trail: HivTestTrail,
): Promise<void> {
  await tx.accessAudit.create({
    data: {
      userId: trail.userId,
      resourceType: RESTRICTED_PROGRAM_RESOURCE_TYPE,
      resourceId: encounterId,
      action,
      ip: trail.ip,
      userAgent: trail.userAgent?.slice(0, 512),
    },
  });
}

function toColumns(answer: HivTestAnswer) {
  return {
    reason: answer.reason,
    screeningDevice: answer.screening.device,
    screeningResult: answer.screening.result,
    confirmationDevice: answer.confirmation?.device ?? null,
    confirmationResult: answer.confirmation?.result ?? null,
    transmissionRoute: answer.transmissionRoute,
    viralLoad: answer.viralLoad,
    cd4: answer.cd4,
  } satisfies Prisma.EncounterHivTestUncheckedUpdateInput;
}

function toRecord(row: HivTestRow): HivTestRecord {
  return {
    reason: row.reason,
    screening: { device: row.screeningDevice, result: row.screeningResult },
    confirmation:
      row.confirmationDevice !== null && row.confirmationResult !== null
        ? { device: row.confirmationDevice, result: row.confirmationResult }
        : null,
    transmissionRoute: row.transmissionRoute,
    viralLoad: row.viralLoad,
    cd4: row.cd4,
    recordedAt: row.recordedAt,
    editedAt: row.editedAt,
  };
}

function siteFilter(
  sites: EncounterQuery['sites'],
): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}
