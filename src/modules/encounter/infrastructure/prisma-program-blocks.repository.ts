import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { EncounterStatus } from '../domain/encounter';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  ProtectedSectionRequiredError,
} from '../domain/encounter.errors';
import type { EncounterQuery } from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import {
  keepProtectedRiskGroup,
  sameVaccination,
  type NutritionAnswer,
  type NutritionRecord,
  type ObstetricAnswer,
  type ObstetricRecord,
  type VaccinationAnswer,
  type VaccinationRecord,
  type VaccineDoseGiven,
} from '../domain/program-blocks';
import type {
  ProgramBlockSave,
  ProgramBlocksRepository,
  VaccineOption,
} from '../domain/program-blocks.repository';

const STAMP = { recordedAt: true, editedAt: true } as const;

const OBSTETRIC_SELECT = {
  risk: true,
  birthPlan: true,
  transportPlan: true,
  plannedPregnancy: true,
  gestationalAgeMethod: true,
  lastMenstrualPeriod: true,
  gestationalWeeks: true,
  nonTreponemalTest: true,
  treponemalTest: true,
  syphilisTreatment: true,
  partnerTreatment: true,
  bacteriuria: true,
  ...STAMP,
} satisfies Prisma.EncounterObstetricSelect;

const NUTRITION_SELECT = {
  motherBreastfeeding: true,
  exclusiveBreastfeeding: true,
  complementaryFeeding: true,
  ...STAMP,
} satisfies Prisma.EncounterNutritionSelect;

const VACCINATION_SELECT = {
  doses: true,
  ...STAMP,
} satisfies Prisma.EncounterVaccinationSelect;

type ObstetricRow = Prisma.EncounterObstetricGetPayload<{
  select: typeof OBSTETRIC_SELECT;
}>;
type VaccinationRow = Prisma.EncounterVaccinationGetPayload<{
  select: typeof VACCINATION_SELECT;
}>;

/**
 * EN-090 to EN-093, EN-249 over PostgreSQL. Who may have each block, the
 * catalogues and the coherence of vaccine and risk group are the triggers of
 * `20261009100000_encounter_program_block_g` and the two after it; the
 * previous version is `record_version_archive`'s. What this adds is the lock,
 * the stamp, and «the same answer is no write».
 */
@Injectable()
export class PrismaProgramBlocksRepository implements ProgramBlocksRepository {
  constructor(private readonly prisma: PrismaService) {}

  async isPregnant(encounterId: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<{ pregnant: boolean }[]>`
      SELECT encounter_is_pregnant(${encounterId}::uuid) AS "pregnant"`;
    return row?.pregnant ?? false;
  }

  async patientSexOf(encounterId: string): Promise<string> {
    const encounter = await this.prisma.encounter.findUniqueOrThrow({
      where: { id: encounterId },
      select: { patient: { select: { sex: true } } },
    });
    return encounter.patient.sex;
  }

  async vaccinesInForce(encounterId: string): Promise<VaccineOption[]> {
    // The clinical date of the attention, the same `valid_period @>` the
    // trigger checks: a vaccine offered here is one the save accepts.
    return this.prisma.$queryRaw<VaccineOption[]>`
      SELECT cc.code AS "code", cc.display AS "display"
        FROM catalog_concept cc
        JOIN catalog_system cs ON cs.id = cc.system_id
        JOIN encounter e ON e.id = ${encounterId}::uuid
       WHERE cs.code = 'VACCINE'
         AND cc.valid_period @> (e.started_at AT TIME ZONE 'America/Guayaquil')::date
       ORDER BY length(cc.code), cc.code`;
  }

  async findObstetric(query: EncounterQuery): Promise<ObstetricRecord | null> {
    const row = await this.prisma.encounterObstetric.findFirst({
      where: { encounterId: query.encounterId, encounter: siteFilter(query.sites) }, // prettier-ignore
      select: OBSTETRIC_SELECT,
    });
    return row && toObstetric(row);
  }

  async findNutrition(query: EncounterQuery): Promise<NutritionRecord | null> {
    return this.prisma.encounterNutrition.findFirst({
      where: { encounterId: query.encounterId, encounter: siteFilter(query.sites) }, // prettier-ignore
      select: NUTRITION_SELECT,
    });
  }

  async findVaccination(
    query: EncounterQuery,
  ): Promise<VaccinationRecord | null> {
    const row = await this.prisma.encounterVaccination.findFirst({
      where: { encounterId: query.encounterId, encounter: siteFilter(query.sites) }, // prettier-ignore
      select: VACCINATION_SELECT,
    });
    return row && toVaccination(row);
  }

  async saveObstetric(
    query: EncounterQuery,
    answer: ObstetricAnswer,
    authorId: string,
  ): Promise<ProgramBlockSave<ObstetricRecord>> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await lockLiveEncounter(tx, query);
      const found = await tx.encounterObstetric.findUnique({
        where: { encounterId: query.encounterId },
        select: OBSTETRIC_SELECT,
      });
      const columns = obstetricColumns(answer);
      if (found === null) {
        const created = await tx.encounterObstetric.create({
          data: { encounterId: query.encounterId, ...columns, recordedById: authorId, recordedAt: now }, // prettier-ignore
          select: OBSTETRIC_SELECT,
        });
        return { record: toObstetric(created), outcome: 'CREATED' };
      }
      const current = toObstetric(found);
      if (sameObstetric(current, answer)) {
        return { record: current, outcome: 'UNCHANGED' };
      }
      const updated = await tx.encounterObstetric.update({
        where: { encounterId: query.encounterId },
        data: { ...columns, editedById: authorId, editedAt: nextStamp(current, now) }, // prettier-ignore
        select: OBSTETRIC_SELECT,
      });
      return { record: toObstetric(updated), outcome: 'UPDATED' };
    });
  }

  async saveNutrition(
    query: EncounterQuery,
    answer: NutritionAnswer,
    authorId: string,
  ): Promise<ProgramBlockSave<NutritionRecord>> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await lockLiveEncounter(tx, query);
      const current = await tx.encounterNutrition.findUnique({
        where: { encounterId: query.encounterId },
        select: NUTRITION_SELECT,
      });
      if (current === null) {
        const created = await tx.encounterNutrition.create({
          data: { encounterId: query.encounterId, ...answer, recordedById: authorId, recordedAt: now }, // prettier-ignore
          select: NUTRITION_SELECT,
        });
        return { record: created, outcome: 'CREATED' };
      }
      if (
        current.motherBreastfeeding === answer.motherBreastfeeding &&
        current.exclusiveBreastfeeding === answer.exclusiveBreastfeeding &&
        current.complementaryFeeding === answer.complementaryFeeding
      ) {
        return { record: current, outcome: 'UNCHANGED' };
      }
      const updated = await tx.encounterNutrition.update({
        where: { encounterId: query.encounterId },
        data: { ...answer, editedById: authorId, editedAt: nextStamp(current, now) }, // prettier-ignore
        select: NUTRITION_SELECT,
      });
      return { record: updated, outcome: 'UPDATED' };
    });
  }

  async saveVaccination(
    query: EncounterQuery,
    answer: VaccinationAnswer,
    authorId: string,
    canWriteProtected: boolean,
  ): Promise<ProgramBlockSave<VaccinationRecord>> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await lockLiveEncounter(tx, query);
      const found = await tx.encounterVaccination.findUnique({
        where: { encounterId: query.encounterId },
        select: VACCINATION_SELECT,
      });
      const current = found && toVaccination(found);

      // REQ-115, EN-261. Without the second key nobody writes the risk group
      // of an adult hepatitis B: the one already recorded, sent back as it
      // was shown, keeps its group; removing it, another dose, a group or a
      // new one is refused. Decided here, under the lock, against the row as
      // it is now.
      const effective = canWriteProtected
        ? answer
        : keepProtectedRiskGroup(answer, current);
      if (effective === null) throw new ProtectedSectionRequiredError();

      const columns = {
        // The three keys always, in this order: what the trigger admits.
        doses: effective.doses.map(({ code, dose, riskGroup }) => ({ code, dose, riskGroup })), // prettier-ignore
      };
      if (current === null) {
        const created = await tx.encounterVaccination.create({
          data: { encounterId: query.encounterId, ...columns, recordedById: authorId, recordedAt: now }, // prettier-ignore
          select: VACCINATION_SELECT,
        });
        return { record: toVaccination(created), outcome: 'CREATED' };
      }
      if (sameVaccination(current, effective)) {
        return { record: current, outcome: 'UNCHANGED' };
      }
      const updated = await tx.encounterVaccination.update({
        where: { encounterId: query.encounterId },
        data: { ...columns, editedById: authorId, editedAt: nextStamp(current, now) }, // prettier-ignore
        select: VACCINATION_SELECT,
      });
      return { record: toVaccination(updated), outcome: 'UPDATED' };
    });
  }
}

/**
 * EN-130, EN-121. The attention in scope, locked FOR UPDATE — the lock the
 * signature takes — and still admitting new content: a discharge that landed
 * after the service's read is refused here. A first save that waited for
 * another reads its row afterwards and corrects it instead of colliding.
 */
async function lockLiveEncounter(
  tx: Prisma.TransactionClient,
  query: EncounterQuery,
): Promise<void> {
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
}

/**
 * EN-249. `record_version_archive` refuses an edit whose stamp did not move:
 * a second correction in the same millisecond moves past it.
 */
function nextStamp(
  current: { recordedAt: Date; editedAt: Date | null },
  now: Date,
): Date {
  const previous = current.editedAt ?? current.recordedAt;
  return previous >= now ? new Date(previous.getTime() + 1) : now;
}

/** A calendar date travels as `YYYY-MM-DD` and is stored at UTC midnight. */
function toDateColumn(day: string | null): Date | null {
  return day === null ? null : new Date(`${day}T00:00:00Z`);
}

function obstetricColumns(answer: ObstetricAnswer) {
  return {
    ...answer,
    lastMenstrualPeriod: toDateColumn(answer.lastMenstrualPeriod),
  } satisfies Prisma.EncounterObstetricUncheckedUpdateInput;
}

function toObstetric(row: ObstetricRow): ObstetricRecord {
  const { lastMenstrualPeriod, ...rest } = row;
  return {
    ...rest,
    lastMenstrualPeriod:
      lastMenstrualPeriod?.toISOString().slice(0, 10) ?? null,
  };
}

function sameObstetric(current: ObstetricRecord, next: ObstetricAnswer) {
  return (Object.keys(next) as (keyof ObstetricAnswer)[]).every(
    (key) => current[key] === next[key],
  );
}

/** The doses as the trigger admitted them: a list of `{ code, dose }`. */
function toVaccination(row: VaccinationRow): VaccinationRecord {
  return {
    doses: row.doses as unknown as VaccineDoseGiven[],
    recordedAt: row.recordedAt,
    editedAt: row.editedAt,
  };
}

/** EN-121. The caller's resolved scope as a `where` fragment on the attention. */
function siteFilter(
  sites: EncounterQuery['sites'],
): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}
