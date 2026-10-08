import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  PractitionerProfileRequiredError,
} from '../domain/encounter.errors';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import {
  acceptsNewClinicalContent,
  hasDischarge,
} from '../domain/encounter-state';
import type {
  ScreeningAnswer,
  ScreeningRecord,
} from '../domain/violence-screening';
import {
  VIOLENCE_SCREENING_REPOSITORY,
  type ViolenceScreeningRepository,
} from '../domain/violence-screening.repository';
import type { Requester } from './encounter.service';

/**
 * What a read gives back. `visible: false` is the OMISSION of EN-072: the
 * caller lacks the second key at this attention's site, and the answer says
 * nothing about whether a screening is there.
 */
export type ScreeningSheet =
  { visible: false } | { visible: true; screening: ScreeningRecord | null };

/**
 * Block F of form 002: the violence screening (EN-070 to EN-078).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OMITTED ON READ, REFUSED ON WRITE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reading asks for `record:read`, like the attention, and then for the second
 * key AT THE ATTENTION'S SITE. Without it the answer is the omission, never a
 * 403: a refusal would confirm for that attention that there is something
 * behind the door (PA-034). Writing asks for both keys up front — the caller
 * named the data, so refusing reveals nothing.
 *
 * ONE AUDIT ROW PER READ THAT DISCLOSED SOMETHING (EN-075): a recorded
 * screening shown to a key holder. The omission discloses nothing and leaves
 * none; neither does «not answered yet». WRITTEN BY THE ADAPTER INSIDE ITS
 * TRANSACTION, never through the shared recorder, which logs and carries on
 * when it cannot write: here no row means no answer.
 *
 * THE LOG CARRIES THE FACT AND NOTHING ELSE (EN-073): no result, no type, no
 * patient, nothing interpolated.
 */
@Injectable()
export class ViolenceScreeningService {
  constructor(
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(VIOLENCE_SCREENING_REPOSITORY)
    private readonly screenings: ViolenceScreeningRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ViolenceScreeningService.name);
  }

  /**
   * EN-072, EN-075. The screening of one attention, for whoever holds the
   * second key at its site; the omission for everybody else.
   *
   * The attention is resolved FIRST, with `record:read`'s scope: out of scope
   * is the same 404 as opening it (EN-121), key or no key.
   */
  async screeningOf(
    encounterId: string,
    requester: Requester,
    holdsKeyAt: (siteId: string) => boolean,
  ): Promise<ScreeningSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!holdsKeyAt(encounter.siteId)) return { visible: false };

    const screening = await this.screenings.readWithTrail(
      { encounterId: encounter.id, sites: requester.sites },
      trailOf(requester),
    );

    return { visible: true, screening };
  }

  /**
   * EN-070, EN-076. Answers or corrects the screening while the attention is
   * live; with the discharge given, completes only its notification to the
   * authority (EN-242) — the adapter decides which under the attention's
   * lock. The `requester.sites` are where the caller holds BOTH keys.
   */
  async record(
    encounterId: string,
    answer: ScreeningAnswer,
    requester: Requester,
  ): Promise<ScreeningRecord> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (
      !acceptsNewClinicalContent(encounter.status) &&
      !hasDischarge(encounter.status)
    ) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
    const practitioner = await this.encounters.findPractitionerByUser(
      requester.userId,
    );
    if (!practitioner) throw new PractitionerProfileRequiredError();

    const saved = await this.screenings.save(
      { encounterId: encounter.id, sites: requester.sites },
      answer,
      { practitionerId: practitioner.practitionerId, at: new Date() },
      trailOf(requester),
    );

    if (saved.outcome !== 'UNCHANGED') {
      // EN-073. The fact only.
      this.logger.info(
        { action: 'ENCOUNTER_SCREENING_RECORDED' },
        'encounter screening recorded',
      );
    }

    return saved.record;
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

function trailOf(requester: Requester) {
  return {
    userId: requester.userId,
    ip: requester.ip,
    userAgent: requester.userAgent,
  };
}
