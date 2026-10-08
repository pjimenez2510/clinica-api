import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { contentHashOf, type NoteContent } from '../domain/clinical-note';
import {
  EncounterNotFoundError,
  PractitionerProfileRequiredError,
} from '../domain/encounter.errors';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import { assertLicensedOn } from '../domain/practitioner-licence';
import {
  interconsultationFormContent,
  referralFormContent,
  type InterconsultationDraft,
  type ReferralDraft,
} from '../domain/referral';
import {
  REFERRAL_REPOSITORY,
  type FormNoteSignature,
  type InterconsultationView,
  type IssueAuthor,
  type ReferralRepository,
  type ReferralSheet,
  type ReferralView,
} from '../domain/referral.repository';
import type { Requester } from './encounter.service';

/**
 * Referrals and interconsultations (encounter H8, EN-100 to EN-107).
 *
 * A SERVICE OF ITS OWN, as the screening's: it has its own lifecycle —issued,
 * answered, annulled—, its own paper and its own route, and shares with the
 * note service one function: the digest of what is signed (EN-027).
 *
 * WHAT IS ISSUED IS SIGNED (EN-104). The 053 or 007 is written in the same
 * transaction, signed by whoever issues, so the practitioner needs a valid
 * ACESS registration TODAY like any signature (EN-029).
 *
 * THE TRAIL. Reading the sheet leaves one `READ` (a referral says why the
 * patient was sent where); issuing a `CREATE`; annulling an `UPDATE`. The log
 * carries the fact and nothing else (EN-124).
 */
@Injectable()
export class ReferralService {
  constructor(
    @Inject(REFERRAL_REPOSITORY)
    private readonly referrals: ReferralRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReferralService.name);
  }

  /** EN-100 to EN-103. What the attention issued, and what may be answered. */
  async sheetOf(
    encounterId: string,
    requester: Requester,
  ): Promise<ReferralSheet> {
    const sheet = await this.referrals.sheetOf({
      encounterId,
      sites: requester.sites,
    });
    if (!sheet) throw new EncounterNotFoundError();
    await this.trail(requester, 'referral', encounterId, 'READ');
    return sheet;
  }

  /** EN-100 to EN-102, EN-104, EN-106. Issues it with its signed 053. */
  async issueReferral(
    encounterId: string,
    draft: ReferralDraft,
    requester: Requester,
  ): Promise<ReferralView> {
    const author = await this.signer(requester);
    const issued = await this.referrals.issueReferral(
      { encounterId, sites: requester.sites },
      draft,
      author,
      (context) => signed(referralFormContent(draft, context), author),
    );
    await this.trail(requester, 'referral', issued.id, 'CREATE');
    this.logger.info({ action: 'REFERRAL_ISSUED' }, 'referral issued');
    return issued;
  }

  /**
   * EN-103, EN-104, EN-106. A REQUESTED one with its signed 007; a RECEIVED
   * one is documented by the 002 of whoever answers it, and writes none.
   */
  async issueInterconsultation(
    encounterId: string,
    draft: InterconsultationDraft,
    requester: Requester,
  ): Promise<InterconsultationView> {
    const author = await this.signer(requester);
    const issued = await this.referrals.issueInterconsultation(
      { encounterId, sites: requester.sites },
      draft,
      author,
      draft.role === 'REQUESTED'
        ? (context) =>
            signed(interconsultationFormContent(draft, context), author)
        : null,
    );
    await this.trail(requester, 'interconsultation', issued.id, 'CREATE');
    this.logger.info(
      { action: 'INTERCONSULTATION_RECORDED' },
      'interconsultation recorded',
    );
    return issued;
  }

  /**
   * EN-107. Annuls a referral with its reason, also after the discharge: it
   * corrects what was issued, it is not new content. Its 053 goes with it.
   */
  async cancelReferral(
    encounterId: string,
    referralId: string,
    reason: string,
    requester: Requester,
  ): Promise<ReferralView> {
    const by = await this.practitioner(requester);
    const cancelled = await this.referrals.cancelReferral(
      { encounterId, referralId, sites: requester.sites },
      by,
      reason,
    );
    await this.trail(requester, 'referral', referralId, 'UPDATE');
    this.logger.info({ action: 'REFERRAL_CANCELLED' }, 'referral cancelled');
    return cancelled;
  }

  async cancelInterconsultation(
    encounterId: string,
    interconsultationId: string,
    reason: string,
    requester: Requester,
  ): Promise<InterconsultationView> {
    const by = await this.practitioner(requester);
    const cancelled = await this.referrals.cancelInterconsultation(
      { encounterId, interconsultationId, sites: requester.sites },
      by,
      reason,
    );
    await this.trail(requester, 'interconsultation', interconsultationId, 'UPDATE'); // prettier-ignore
    this.logger.info(
      { action: 'INTERCONSULTATION_CANCELLED' },
      'interconsultation cancelled',
    );
    return cancelled;
  }

  /** EN-029. Whoever issues signs the form, so is licensed today. */
  private async signer(requester: Requester): Promise<IssueAuthor> {
    const identity = await this.encounters.findPractitionerByUser(
      requester.userId,
    );
    if (!identity) throw new PractitionerProfileRequiredError();
    const at = new Date();
    assertLicensedOn(identity.acessExpiresOn, at);
    return { practitionerId: identity.practitionerId, at };
  }

  /** Annulling signs nothing: a practitioner, licence or not. */
  private async practitioner(requester: Requester): Promise<IssueAuthor> {
    const identity = await this.encounters.findPractitionerByUser(
      requester.userId,
    );
    if (!identity) throw new PractitionerProfileRequiredError();
    return { practitionerId: identity.practitionerId, at: new Date() };
  }

  private async trail(
    requester: Requester,
    resourceType: 'referral' | 'interconsultation',
    resourceId: string,
    action: 'READ' | 'CREATE' | 'UPDATE',
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType,
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}

/** EN-027. Content, signer and instant inside the digest, as every note. */
function signed(content: NoteContent, author: IssueAuthor): FormNoteSignature {
  return {
    content,
    contentHash: contentHashOf({
      content,
      signedById: author.practitionerId,
      signedAt: author.at,
    }),
  };
}
