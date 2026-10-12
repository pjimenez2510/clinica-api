import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  CODING_CONTEXT_READER,
  acceptsNewContent,
  type CodingContextReader,
} from '../../../shared/clinical/coding-context.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNotEncounterOwnerError,
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
 */
@Injectable()
export class ListeningAccess {
  private readonly pending = new Map<string, Pending>();

  constructor(
    @Inject(CODING_CONTEXT_READER)
    private readonly context: CodingContextReader,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(LISTENING_CLOCK) private readonly now: ListeningClock,
  ) {}

  /** AS-045. A ticket for the attention's own professional, while it is live. */
  async issue(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<{ ticket: string; expiresAt: Date }> {
    await this.ownEncounter(encounterId, requester, true);
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
    const { expiresAt: _expiresAt, ...grant } = pending;
    return grant;
  }

  /**
   * AS-045. Asked again when the channel starts or resumes: the attention may
   * have been signed, or moved, since the ticket was issued.
   */
  async confirm(grant: ListeningGrant): Promise<void> {
    await this.ownEncounter(grant.encounterId, grant, true);
  }

  /** AS-056. Reading the transcript: its professional only, and it is trailed. */
  async read(
    encounterId: string,
    requester: ListeningRequester,
  ): Promise<void> {
    await this.ownEncounter(encounterId, requester, false);
    await this.audit.record({
      userId: requester.userId,
      resourceType: AUDIT_RESOURCE,
      resourceId: encounterId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  private async ownEncounter(
    encounterId: string,
    who: { userId: string; writeSites: 'all' | readonly string[] },
    live: boolean,
  ): Promise<void> {
    const encounter = await this.context.encounter(encounterId, who.writeSites);
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (encounter.practitionerUserId !== who.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    if (live && !acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [ticket, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(ticket);
    }
  }
}
