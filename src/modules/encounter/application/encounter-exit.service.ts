import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { contentHashOf, type NoteContent } from '../domain/clinical-note';
import type { DiscontinuedOrigin } from '../domain/encounter';
import { PractitionerProfileRequiredError } from '../domain/encounter.errors';
import { assertLicensedOn } from '../domain/practitioner-licence';
import {
  ENCOUNTER_EXIT_REPOSITORY,
  type EncounterExitRepository,
} from '../domain/encounter-exit.repository';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import { planAnnulment, planInterruption } from '../domain/encounter-state';
import { assertAnnullable, planExitActor } from '../domain/encounter-exit';
import type { Requester } from './encounter.service';

/** Same resource as the attention's own use cases: it is the attention that changes. */
const RESOURCE_TYPE = 'encounter';
/** The note's own resource, as `ClinicalNoteService` audits a signature. */
const NOTE_RESOURCE_TYPE = 'clinical_note';

/** EN-166. Annulling an attention opened by mistake. */
export interface AnnulEncounterRequest {
  encounterId: string;
  reason?: string;
  /** EN-147 applied to the exits (D-085 §2): why somebody else does it. */
  substituteReason?: string;
  /**
   * Where the caller holds `record:sign`, resolved by the controller from the
   * session. A substitute must sign AT THE ATTENTION'S SITE: signing at
   * another one is not the authority D-085 §2 grants.
   */
  signSites: 'all' | readonly string[];
}

/** EN-167. Interrupting an attention that cannot be finished. */
export interface DiscontinueEncounterRequest {
  encounterId: string;
  reason?: string;
  origin?: DiscontinuedOrigin;
  /** EN-147 applied to the exits (D-085 §2): why somebody else does it. */
  substituteReason?: string;
  /** `record:sign`, resolved by the controller from the session. */
  canSignRecords: boolean;
}

/**
 * EN-166, EN-167 (D-076, D-077, D-080, D-082). The two exits of an attention
 * that are not the discharge: annulling it and interrupting it.
 *
 * A SERVICE OF ITS OWN and not two more methods on `EncounterService`: the
 * attention module is worked on by other deliveries at the same time, and
 * these two acts have a reason to change of their own — they are the only use
 * cases of the attention that also move the appointment.
 */
@Injectable()
export class EncounterExitService {
  constructor(
    @Inject(ENCOUNTER_EXIT_REPOSITORY)
    private readonly exits: EncounterExitRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EncounterExitService.name);
  }

  /**
   * EN-166, AG-147 (D-077, D-080). Annuls an attention opened by mistake —the
   * note opened on the wrong patient— and gives its appointment back to the
   * waiting room, in one transaction.
   *
   * A PRACTITIONER, behind `record:write` (D-080 §2): it is an act on the
   * clinical record, not on the agenda — the attending one, or a substitute
   * who signs records and says why (D-085 §2), and only while the attention
   * is in progress (D-085 §1). Nothing written in it is deleted or changed.
   */
  async annul(
    request: AnnulEncounterRequest,
    requester: Requester,
  ): Promise<EncounterView> {
    const identity = await this.encounters.findPractitionerByUser(
      requester.userId,
    );
    if (!identity) throw new PractitionerProfileRequiredError();
    const now = new Date();

    const annulled = await this.exits.annul(
      { encounterId: request.encounterId, sites: requester.sites },
      (encounter) => {
        // D-085 §2 first —who— and §1 next —from where—, the order of the
        // closure: «esto no le toca a usted» is the answer whatever else.
        const substituteReason = planExitActor(encounter.practitionerId, {
          practitionerId: identity.practitionerId,
          canSignRecords:
            request.signSites === 'all' ||
            request.signSites.includes(encounter.siteId),
          substituteReason: request.substituteReason,
        });
        assertAnnullable(encounter.status);
        return {
          ...planAnnulment({
            from: encounter.status,
            endedAt: encounter.endedAt,
            reason: request.reason,
            now,
          }),
          substituteReason,
        };
      },
      requester.userId,
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: annulled.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    // The fact only: no reason, no patient — the reason is clinical text.
    this.logger.info(
      { site_id: annulled.siteId, action: 'ENCOUNTER_ENTERED_IN_ERROR' },
      'encounter annulled',
    );

    return annulled;
  }

  /**
   * EN-167, AG-149 (D-076, D-082). Interrupts an attention that cannot be
   * finished: signs the caller's drafts «con lo hecho», marks the attention
   * `DISCONTINUED` with its reason and origin, and the appointment attended.
   *
   * THE SIGNATURE IS THE SAME AS EVER (EN-027): content, signer and instant in
   * the hash, and a registration in force on the day (EN-029) — an
   * interrupted consultation is still signed by somebody entitled to sign.
   * What it does NOT demand is the minimum content of a finished one (D-082):
   * asking for a diagnosis would make the doctor write something that did not
   * happen.
   */
  async discontinue(
    request: DiscontinueEncounterRequest,
    requester: Requester,
  ): Promise<EncounterView> {
    const signer = await this.encounters.findPractitionerByUser(
      requester.userId,
    );
    if (!signer) throw new PractitionerProfileRequiredError();
    const now = new Date();

    const {
      encounter: discontinued,
      signedNoteIds,
      unsignedEmptyNoteIds,
    } = await this.exits.discontinue(
      { encounterId: request.encounterId, sites: requester.sites },
      (encounter) => ({
        substituteReason: planExitActor(encounter.practitionerId, {
          practitionerId: signer.practitionerId,
          canSignRecords: request.canSignRecords,
          substituteReason: request.substituteReason,
        }),
        ...planInterruption({
          from: encounter.status,
          reason: request.reason,
          origin: request.origin,
          now,
        }),
      }),
      {
        authorId: signer.practitionerId,
        sign: (draft) => {
          assertLicensedOn(signer.acessExpiresOn, now);
          return {
            signedById: signer.practitionerId,
            signedAt: now,
            contentHash: contentHashOf({
              content: (draft.content ?? {}) as NoteContent,
              signedById: signer.practitionerId,
              signedAt: now,
            }),
          };
        },
      },
      requester.userId,
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: discontinued.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    this.logger.info(
      { site_id: discontinued.siteId, action: 'ENCOUNTER_DISCONTINUED' },
      'encounter discontinued',
    );
    /**
     * EN-122, EN-027. Each note the interruption signed leaves the SAME trail
     * as a note signed one by one: a row of the access log on the note and the
     * `CLINICAL_NOTE_SIGNED` fact. Auditing only the attention would make
     * these signatures the one kind nobody can find in the log.
     */
    for (const noteId of signedNoteIds) {
      await this.audit.record({
        userId: requester.userId,
        resourceType: NOTE_RESOURCE_TYPE,
        resourceId: noteId,
        action: 'UPDATE',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
      this.logger.info({ action: 'CLINICAL_NOTE_SIGNED' }, 'clinical note signed'); // prettier-ignore
    }
    // D-099 §4. The constancia of D-085 §5: which drafts were left unsigned
    // because nothing was written in them, by whom and when.
    for (const noteId of unsignedEmptyNoteIds) {
      await this.audit.record({
        userId: requester.userId,
        resourceType: NOTE_RESOURCE_TYPE,
        resourceId: noteId,
        action: 'DRAFT_LEFT_UNSIGNED',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
    }

    return discontinued;
  }
}
