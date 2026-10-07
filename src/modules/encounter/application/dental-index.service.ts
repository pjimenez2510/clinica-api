import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  dentalIndexOf,
  type DentalIndex,
  type DentalIndexCounts,
  type DentalIndexReading,
} from '../domain/dental-index';
import {
  DENTAL_INDEX_REPOSITORY,
  type DentalIndexRepository,
} from '../domain/dental-index.repository';
import {
  DentalIndexNotApplicableError,
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import type { Requester } from './encounter.service';

/** Its own type in the trail: an odontological finding of a person. */
const DENTAL_INDEX_RESOURCE_TYPE = 'encounter_dental_index';

/** EN-052. Which index the attention takes, and what was recorded of it. */
export interface DentalIndexSheet {
  /** `null`: not odontology, or a frozen age in neither band (D-160). */
  index: DentalIndex | null;
  reading: DentalIndexReading | null;
}

/**
 * EN-052. The counts of the index the screen is filling. Each index has its
 * own: the CEO-D has no `missing` and the CPO-D no `extracted` — sending the
 * other one is refused as not applicable.
 */
export interface RecordDentalIndexRequest {
  index: DentalIndex;
  decayed: number;
  filled: number;
  extracted?: number;
  missing?: number;
}

/**
 * EN-052. The CEO-D / CPO-D of an odontology attention.
 *
 * A SERVICE OF ITS OWN: two use cases with a reason to change none of the
 * others has — the instructivo's bands and which specialties count (D-160).
 * The specialty is the attention's by EN-203's rule (`specialtyCodeOf`), and
 * the age is the one frozen on the attention, never today's.
 */
@Injectable()
export class DentalIndexService {
  constructor(
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(DENTAL_INDEX_REPOSITORY)
    private readonly dental: DentalIndexRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /** EN-052. Which index applies, and the counts recorded, if any. Audited. */
  async dentalIndexOf(
    encounterId: string,
    requester: Requester,
  ): Promise<DentalIndexSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);
    const index = await this.indexOf(encounter);
    const reading = await this.dental.find({
      encounterId: encounter.id,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: DENTAL_INDEX_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return { index, reading };
  }

  /**
   * EN-052. Records or corrects the counts of the index that applies, while
   * the attention admits new content (as the first taking of signs, EN-130).
   * Outside odontology, outside the bands of the frozen age, or naming the
   * other index: `DENTAL_INDEX_NOT_APPLICABLE`, before anything is written.
   */
  async recordDentalIndex(
    encounterId: string,
    request: RecordDentalIndexRequest,
    requester: Requester,
  ): Promise<DentalIndexSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!acceptsNewClinicalContent(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
    const index = await this.indexOf(encounter);
    // The other index's count: extracted primary teeth in a CPO-D, missing
    // permanent ones in a CEO-D. The database refuses it too.
    const otherCount =
      request.index === 'CEO_D'
        ? request.missing !== undefined
        : request.extracted !== undefined;
    if (index === null || index !== request.index || otherCount) {
      throw new DentalIndexNotApplicableError();
    }

    const query = { encounterId: encounter.id, sites: requester.sites };
    const existed = (await this.dental.find(query)) !== null;
    const counts: DentalIndexCounts =
      request.index === 'CEO_D'
        ? {
            decayed: request.decayed,
            extracted: request.extracted ?? null,
            filled: request.filled,
            missing: null,
          }
        : {
            decayed: request.decayed,
            extracted: null,
            filled: request.filled,
            missing: request.missing ?? null,
          };
    const reading = await this.dental.save(query, counts, requester.userId);

    await this.audit.record({
      userId: requester.userId,
      resourceType: DENTAL_INDEX_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: existed ? 'UPDATE' : 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return { index, reading };
  }

  private async indexOf(encounter: EncounterView): Promise<DentalIndex | null> {
    return dentalIndexOf(
      await this.dental.specialtyCodeOf(encounter.id),
      encounter,
    );
  }

  private async requireEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.encounters.findById({
      encounterId,
      sites: requester.sites,
    });
    if (!encounter) throw new EncounterNotFoundError();
    return encounter;
  }
}
