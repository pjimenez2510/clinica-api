import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
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
import { acceptsNewClinicalContent } from '../domain/encounter-state';
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
 * The trail's name for block F. It names the SECTION of the attention, not
 * its content, for the same reason the permission does not say «violence».
 */
const SCREENING_RESOURCE_TYPE = 'encounter_screening';

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
 * none; neither does «not answered yet».
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
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
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

    const screening = await this.screenings.find({
      encounterId: encounter.id,
      sites: requester.sites,
    });

    if (screening !== null) {
      await this.audit.record({
        userId: requester.userId,
        resourceType: SCREENING_RESOURCE_TYPE,
        resourceId: encounter.id,
        action: 'READ',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
    }

    return { visible: true, screening };
  }

  /**
   * EN-070, EN-076. Answers or corrects the screening while the attention is
   * live. The `requester.sites` are where the caller holds BOTH keys.
   */
  async record(
    encounterId: string,
    answer: ScreeningAnswer,
    requester: Requester,
  ): Promise<ScreeningRecord> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!acceptsNewClinicalContent(encounter.status)) {
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
    );

    if (saved.outcome !== 'UNCHANGED') {
      await this.audit.record({
        userId: requester.userId,
        resourceType: SCREENING_RESOURCE_TYPE,
        resourceId: encounter.id,
        action: saved.outcome === 'CREATED' ? 'CREATE' : 'UPDATE',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
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
