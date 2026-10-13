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
  AssistantPreparationOverError,
  AssistantRecordingNotAuthorizedError,
} from '../domain/assistant.errors';
import type { ListeningScope } from '../domain/listening';

import { LISTENING_CLOCK, type ListeningClock } from './listening.service';
import { LISTENING_STORE, type ListeningStore } from './listening.store';

/** AS-045. How long a ticket waits for its channel. */
export const TICKET_TTL_MS = 30_000;

/** Who asks, as the controller resolved it from the session (AS-026, AS-045). */
export interface ListeningRequester {
  userId: string;
  /**
   * Where they may write the history AND use the assistant; for the
   * preparation, where they may take and dictate the vitals (AS-240).
   */
  writeSites: 'all' | readonly string[];
  /** When the access token they asked with expires (AS-047). */
  tokenExpiresAt: Date;
  ip?: string;
  userAgent?: string;
}

/** What a redeemed ticket stands for: this person, this attention, until then. */
export interface ListeningGrant {
  encounterId: string;
  /** AS-241. Whose conversation: the consultation's, or the preparation's. */
  scope: ListeningScope;
  userId: string;
  writeSites: 'all' | readonly string[];
  tokenExpiresAt: Date;
}

interface Pending extends ListeningGrant {
  expiresAt: Date;
}

const AUDIT_RESOURCE: Record<ListeningScope, string> = {
  CONSULTATION: 'assistant_listening',
  PREPARATION: 'assistant_preparation_listening',
};

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
    /** AS-240. The consultation's listening: once it exists, the preparation is over. */
    @Inject(LISTENING_STORE) private readonly consultation: ListeningStore,
  ) {}

  /** AS-045. A ticket for the attention's own professional, while it is live. */
  async issue(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ ticket: string; expiresAt: Date }> {
    const encounter = await this.ownEncounter(encounterId, requester, true);
    await this.requireAuthorized(encounter);
    return this.ticketFor(encounterId, 'CONSULTATION', requester);
  }

  /**
   * AS-240 (B3). A ticket for listening to the preparation: whoever takes the
   * vitals at the attention's site, not only its professional, while it is
   * live and the patient authorized recording.
   */
  async issuePreparation(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ ticket: string; expiresAt: Date }> {
    const encounter = await this.reachableEncounter(encounterId, requester.writeSites, true); // prettier-ignore
    await this.requirePreparing(encounter);
    await this.requireAuthorized(encounter);
    return this.ticketFor(encounterId, 'PREPARATION', requester);
  }

  private async ticketFor(
    encounterId: string,
    scope: ListeningScope,
    requester: ListeningRequester,
  ): Promise<{ ticket: string; expiresAt: Date }> {
    this.forgetExpired();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + TICKET_TTL_MS);
    this.pending.set(ticket, {
      encounterId,
      scope,
      userId: requester.userId,
      writeSites: requester.writeSites,
      tokenExpiresAt: requester.tokenExpiresAt,
      expiresAt,
    });
    await this.audit.record({
      userId: requester.userId,
      resourceType: AUDIT_RESOURCE[scope],
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
      scope: pending.scope,
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
    const writeSites = narrow(grant.writeSites, enabled);
    // AS-244. The preparation is anyone's who takes the vitals there.
    const encounter =
      grant.scope === 'PREPARATION'
        ? await this.reachableEncounter(grant.encounterId, writeSites, true)
        : await this.ownEncounter(grant.encounterId, { userId: grant.userId, writeSites }, true); // prettier-ignore
    if (grant.scope === 'PREPARATION') await this.requirePreparing(encounter);
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
    return this.readOf(encounter, 'CONSULTATION', requester);
  }

  /**
   * AS-243 (B3, D-260 §2). Reading the preparation's transcript: whoever
   * takes the vitals at the attention's site, trailed like the consultation's.
   */
  async readPreparation(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ recordingAuthorized: boolean }> {
    const encounter = await this.reachableEncounter(encounterId, requester.writeSites, false); // prettier-ignore
    // Revisión (seguridad): once the attention is closed, only its own
    // professional reads what was said in the room, until it is purged.
    if (
      !acceptsNewContent(encounter.status) &&
      encounter.practitionerUserId !== requester.userId
    ) {
      // prettier-ignore
      throw new AssistantEncounterClosedError();
    }
    return this.readOf(encounter, 'PREPARATION', requester);
  }

  private async readOf(
    encounter: CodingEncounter,
    scope: ListeningScope,
    requester: ListeningRequester,
  ): Promise<{ recordingAuthorized: boolean }> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: AUDIT_RESOURCE[scope],
      resourceId: encounter.id,
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

  /**
   * AS-240, AS-244 (revisión). The preparation ends where the consultation's
   * listening begins: what the physician's consultation says is never kept
   * where everyone who prepares reads it.
   */
  private async requirePreparing(encounter: CodingEncounter): Promise<void> {
    if (await this.consultation.find(encounter.id)) {
      throw new AssistantPreparationOverError();
    }
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

  /** AS-240, AS-243. At a site of the requester's; whose it is does not matter. */
  private async reachableEncounter(
    encounterId: string,
    sites: 'all' | readonly string[],
    live: boolean,
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, sites);
    if (!encounter) throw new AssistantEncounterNotFoundError();
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
