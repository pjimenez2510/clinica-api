import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../../shared/clinical/assistant-site-switch.port';
import {
  CODING_CONTEXT_READER,
  acceptsNewContent,
  type CodingContextReader,
  type CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import {
  RECORDING_AUTHORIZATION,
  type RecordingAuthorization,
} from '../../../shared/clinical/recording-authorization.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNotEncounterOwnerError,
  AssistantRecordingNotAuthorizedError,
} from '../domain/assistant.errors';

import { LISTENING_CLOCK, type ListeningClock } from './listening.service';

/** AS-045. How long a ticket waits for its channel. */
export const TICKET_TTL_MS = 30_000;

/** Who asks, as the controller resolved it from the session (AS-026, AS-045). */
export interface ListeningRequester {
  userId: string;
  /** Where they may write the history AND use the assistant. */
  writeSites: 'all' | readonly string[];
  /** When the access token they asked with expires (AS-047). */
  tokenExpiresAt: Date;
  ip?: string;
  userAgent?: string;
}

/** What a redeemed ticket stands for: this person, this attention, until then. */
export interface ListeningGrant {
  encounterId: string;
  userId: string;
  writeSites: 'all' | readonly string[];
  tokenExpiresAt: Date;
}

interface Pending extends ListeningGrant {
  expiresAt: Date;
}

const AUDIT_RESOURCE = 'assistant_listening';

/**
 * AS-045, AS-046, AS-056 (M-02). Who may listen to an attention, and the
 * ticket that carries that answer to the audio channel.
 *
 * The ticket is asked for over HTTP so the guards of every route decide —
 * session, `assistant:use`, the switch — and not a copy of them in the
 * socket. It is 32 random bytes, used once, alive for 30 s, and lives in
 * memory: it never reaches a URL, a log or the database (D-247 §5).
 *
 * AS-163, AS-165, AS-166 (A3). Listening also needs the site switched on and
 * the patient's authorization to record. Both are asked again on every
 * confirmation —start, resume and the live check— so switching the site off
 * or revoking stops a listening already open.
 */
@Injectable()
export class ListeningAccess {
  private readonly pending = new Map<string, Pending>();

  constructor(
    @Inject(CODING_CONTEXT_READER)
    private readonly context: CodingContextReader,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(LISTENING_CLOCK) private readonly now: ListeningClock,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
    @Inject(RECORDING_AUTHORIZATION)
    private readonly recording: RecordingAuthorization,
  ) {}

  /** AS-045. A ticket for the attention's own professional, while it is live. */
  async issue(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ ticket: string; expiresAt: Date }> {
    const encounter = await this.ownEncounter(encounterId, requester, true);
    await this.requireAuthorized(encounter);
    this.forgetExpired();

    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + TICKET_TTL_MS);
    this.pending.set(ticket, {
      encounterId,
      userId: requester.userId,
      writeSites: requester.writeSites,
      tokenExpiresAt: requester.tokenExpiresAt,
      expiresAt,
    });
    await this.audit.record({
      userId: requester.userId,
      resourceType: AUDIT_RESOURCE,
      resourceId: encounterId,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    return { ticket, expiresAt };
  }

  /** AS-046. The grant of a ticket, once; `null` when unknown, used or expired. */
  redeem(ticket: string): ListeningGrant | null {
    const pending = this.pending.get(ticket);
    if (!pending) return null;
    this.pending.delete(ticket);
    if (pending.expiresAt <= this.now()) return null;
    return {
      encounterId: pending.encounterId,
      userId: pending.userId,
      writeSites: pending.writeSites,
      tokenExpiresAt: pending.tokenExpiresAt,
    };
  }

  /**
   * AS-045. Asked again when the channel starts or resumes: the attention may
   * have been signed, or moved, since the ticket was issued. AS-163, AS-166:
   * and its site switched off, or the authorization revoked — the sites the
   * ticket carried are narrowed by the ones on NOW.
   */
  async confirm(grant: ListeningGrant): Promise<void> {
    const enabled = await this.siteSwitch.enabledSites();
    const encounter = await this.ownEncounter(
      grant.encounterId,
      { userId: grant.userId, writeSites: narrow(grant.writeSites, enabled) },
      true,
    );
    await this.requireAuthorized(encounter);
  }

  /**
   * AS-056, AS-167. Reading the transcript: its professional only, and it is
   * trailed. Says whether the patient has the authorization standing, so the
   * screen can say why it does not offer «Escuchar».
   */
  async read(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ recordingAuthorized: boolean }> {
    const encounter = await this.ownEncounter(encounterId, requester, false);
    await this.audit.record({
      userId: requester.userId,
      resourceType: AUDIT_RESOURCE,
      resourceId: encounterId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    return {
      recordingAuthorized: await this.recording.isAuthorized(encounter.patientId), // prettier-ignore
    };
  }

  /**
   * AS-168 (D-254 §3). The authorization the patient gives in the
   * consultation room, recorded by the attention's own professional while it
   * takes content; nothing when one is already standing.
   */
  async authorize(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ recordingAuthorized: boolean }> {
    const encounter = await this.ownEncounter(encounterId, requester, true);
    await this.recording.grant(
      encounter.patientId,
      {
        userId: requester.userId,
        ip: requester.ip,
        userAgent: requester.userAgent,
      },
      this.now(),
    );
    return { recordingAuthorized: true };
  }

  /** AS-165, AS-166. Answered after the attention's own refusals. */
  private async requireAuthorized(encounter: CodingEncounter): Promise<void> {
    if (!(await this.recording.isAuthorized(encounter.patientId))) {
      throw new AssistantRecordingNotAuthorizedError();
    }
  }

  private async ownEncounter(
    encounterId: string,
    who: { userId: string; writeSites: 'all' | readonly string[] },
    live: boolean,
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, who.writeSites);
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (encounter.practitionerUserId !== who.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    if (live && !acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [ticket, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(ticket);
    }
  }
}

/** AS-163. What the ticket admitted, less the sites switched off since. */
function narrow(
  sites: 'all' | readonly string[],
  enabled: readonly string[],
): readonly string[] {
  return sites === 'all'
    ? enabled
    : sites.filter((site) => enabled.includes(site));
}
