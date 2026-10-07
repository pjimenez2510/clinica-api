import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  DentalIndexCounts,
  DentalIndexReading,
} from '../domain/dental-index';
import type { DentalIndexRepository } from '../domain/dental-index.repository';
import type { EncounterStatus } from '../domain/encounter';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import type { EncounterQuery } from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';

import { encounterSpecialty } from './encounter-specialty';

const READING_SELECT = {
  decayed: true,
  extracted: true,
  filled: true,
  missing: true,
  recordedAt: true,
  editedAt: true,
} satisfies Prisma.EncounterDentalIndexSelect;

/**
 * EN-052 over PostgreSQL. The bands of age and the counts of each index are
 * `trg_encounter_dental_index_applies`'s; the correction's previous version
 * is `record_version_archive`'s. What this adds is the lock and the stamp.
 */
@Injectable()
export class PrismaDentalIndexRepository implements DentalIndexRepository {
  constructor(private readonly prisma: PrismaService) {}

  async specialtyCodeOf(encounterId: string): Promise<string | null> {
    return (await encounterSpecialty(this.prisma, encounterId))?.code ?? null;
  }

  async find(query: EncounterQuery): Promise<DentalIndexReading | null> {
    return this.prisma.encounterDentalIndex.findFirst({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      select: READING_SELECT,
    });
  }

  async save(
    query: EncounterQuery,
    counts: DentalIndexCounts,
    authorId: string,
  ): Promise<DentalIndexReading> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const inScope = await tx.encounter.findFirst({
        where: { id: query.encounterId, ...siteFilter(query.sites) },
        select: { id: true },
      });
      if (!inScope) throw new EncounterNotFoundError();

      // EN-130. Under the attention's lock: a discharge that landed after the
      // service's read is refused here too, as on the first taking of signs.
      const [locked] = await tx.$queryRaw<{ status: EncounterStatus }[]>`
        SELECT "status"::text AS "status" FROM "encounter"
         WHERE "id" = ${query.encounterId}::uuid
           FOR UPDATE`;
      if (!locked) throw new EncounterNotFoundError();
      if (!acceptsNewClinicalContent(locked.status)) {
        throw new EncounterAlreadyClosedError(locked.status);
      }

      const current = await tx.encounterDentalIndex.findUnique({
        where: { encounterId: query.encounterId },
        select: { ...READING_SELECT },
      });
      if (current === null) {
        return tx.encounterDentalIndex.create({
          data: {
            encounterId: query.encounterId,
            ...counts,
            recordedById: authorId,
            recordedAt: now,
          },
          select: READING_SELECT,
        });
      }

      // The same counts are not an edit: no version of an identical row.
      if (
        current.decayed === counts.decayed &&
        current.extracted === counts.extracted &&
        current.filled === counts.filled &&
        current.missing === counts.missing
      ) {
        return current;
      }

      // EN-210. `record_version_archive` refuses an edit whose stamp did not
      // move: a second correction in the same millisecond moves past it.
      const previous = current.editedAt ?? current.recordedAt;
      return tx.encounterDentalIndex.update({
        where: { encounterId: query.encounterId },
        data: {
          ...counts,
          editedById: authorId,
          editedAt: previous >= now ? new Date(previous.getTime() + 1) : now,
        },
        select: READING_SELECT,
      });
    });
  }
}

/** EN-121. The caller's resolved scope as a `where` fragment on the attention. */
function siteFilter(
  sites: EncounterQuery['sites'],
): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}
