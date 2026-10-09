import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import type { HivTestAnswer, HivTestRecord } from '../domain/hiv-test';
import {
  HIV_TEST_REPOSITORY,
  type HivTestRepository,
} from '../domain/hiv-test.repository';
import type { Requester } from './encounter.service';

/**
 * What a read gives back. `visible: false` is the OMISSION of EN-095: the
 * caller lacks the second key at this attention's site, and the answer says
 * nothing about whether a test is there.
 */
export type HivTestSheet =
  { visible: false } | { visible: true; test: HivTestRecord | null };

/**
 * Block J of the RDACAA: the HIV test (EN-094, EN-095).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REGIME OF THE VIOLENCE SCREENING, AND NOT A SECOND ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REQ-115 names three data that need additional control —HIV, mental health
 * and violence— and two are this module's. They are resolved with the same
 * mechanism (`ViolenceScreeningService`): reading asks for `record:read` and
 * then for the second key AT THE ATTENTION'S SITE, and without it the answer
 * is the omission, never a 403; writing asks for both keys up front; one
 * trail row per read that disclosed something, written by the adapter inside
 * its transaction; the log carries the fact and nothing else.
 */
@Injectable()
export class HivTestService {
  constructor(
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(HIV_TEST_REPOSITORY)
    private readonly tests: HivTestRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HivTestService.name);
  }

  /** EN-095. The test of one attention for a key holder; the omission otherwise. */
  async testOf(
    encounterId: string,
    requester: Requester,
    holdsKeyAt: (siteId: string) => boolean,
  ): Promise<HivTestSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!holdsKeyAt(encounter.siteId)) return { visible: false };
    const test = await this.tests.readWithTrail(
      { encounterId: encounter.id, sites: requester.sites },
      trailOf(requester),
    );
    return { visible: true, test };
  }

  /**
   * EN-094, EN-249. Records or corrects it while the attention is live. The
   * `requester.sites` are where the caller holds BOTH keys.
   */
  async record(
    encounterId: string,
    answer: HivTestAnswer,
    requester: Requester,
  ): Promise<HivTestRecord> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!acceptsNewClinicalContent(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
    const saved = await this.tests.save(
      { encounterId: encounter.id, sites: requester.sites },
      answer,
      requester.userId,
      trailOf(requester),
    );
    if (saved.outcome !== 'UNCHANGED') {
      // EN-095. The fact only: no result, no reason, no patient.
      this.logger.info(
        { action: 'ENCOUNTER_RESTRICTED_PROGRAM_RECORDED' },
        'encounter restricted program recorded',
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
