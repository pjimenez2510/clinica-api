import { Inject, Injectable } from '@nestjs/common';

import {
  VoiceprintConsentRequiredError,
  VoiceprintMissingError,
} from '../domain/assistant.errors';

import type { ListeningVoiceprint } from './speech-recognizer.port';
import {
  VOICEPRINT_ENROLLER,
  VOICEPRINT_STORE,
  type ListeningVoiceprints,
  type Voiceprint,
  type VoiceprintEnroller,
  type VoiceprintStore,
  type VoiceprintTrail,
} from './voiceprint.port';

export const VOICEPRINT_CLOCK = Symbol('VOICEPRINT_CLOCK');
export type VoiceprintClock = () => Date;

/** Who asks: always the owner, taken from the session (AS-310). */
export interface VoiceprintOwner {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** AS-313. «Mi voz» as the screen shows it. Never the vector (AS-319). */
export interface VoiceprintView {
  registered: {
    phrases: number;
    seconds: number;
    consentedAt: Date;
    updatedAt: Date;
  } | null;
  attribution: boolean;
  /** Whether `clinica-ai` can tell voices apart now, and why not. */
  available: boolean;
  reason: string | null;
}

/**
 * E17 (AS-310 to AS-314). «Mi voz»: register, replace, delete, and the switch
 * that turns attribution on for the listening of whoever owns it.
 */
@Injectable()
export class VoiceprintService implements ListeningVoiceprints {
  constructor(
    @Inject(VOICEPRINT_ENROLLER) private readonly enroller: VoiceprintEnroller,
    @Inject(VOICEPRINT_STORE) private readonly store: VoiceprintStore,
    @Inject(VOICEPRINT_CLOCK) private readonly now: VoiceprintClock,
  ) {}

  /** AS-313. */
  async view(owner: VoiceprintOwner): Promise<VoiceprintView> {
    const [stored, status] = await Promise.all([
      this.store.find(owner.userId),
      this.enroller.attributionStatus(),
    ]);
    return {
      registered: stored
        ? {
            phrases: stored.phrases,
            seconds: stored.seconds,
            consentedAt: stored.consentedAt,
            updatedAt: stored.updatedAt,
          }
        : null,
      attribution: stored?.attribution ?? false,
      available: status.available,
      reason: status.reason,
    };
  }

  /**
   * AS-310, AS-311, AS-312. Without consent nothing is sent; what
   * `clinica-ai` refuses leaves the voiceprint there was as it was.
   */
  async register(
    owner: VoiceprintOwner,
    recording: Buffer,
    consent: boolean,
    signal?: AbortSignal,
  ): Promise<VoiceprintView> {
    if (!consent) throw new VoiceprintConsentRequiredError();
    const voiceprint: Voiceprint = await this.enroller.enrol(recording, signal);
    // The screen gave up while clinica-ai worked (closed, or «Borrar mi voz»
    // in another tab): what it no longer wants is not kept (review).
    signal?.throwIfAborted();
    await this.store.save(owner.userId, voiceprint, this.now(), trailOf(owner));
    return this.view(owner);
  }

  /** AS-313. On needs a voiceprint; off always answers. */
  async setAttribution(
    owner: VoiceprintOwner,
    on: boolean,
  ): Promise<VoiceprintView> {
    const changed = await this.store.setAttribution(
      owner.userId,
      on,
      this.now(),
      trailOf(owner),
    );
    if (!changed && on) throw new VoiceprintMissingError();
    return this.view(owner);
  }

  /** AS-312. The row is gone; deleting nothing is not an error. */
  async remove(owner: VoiceprintOwner): Promise<void> {
    await this.store.remove(owner.userId, trailOf(owner));
  }

  /** AS-314. Read when a recognition is opened. */
  async forListening(userId: string): Promise<ListeningVoiceprint | null> {
    const stored = await this.store.find(userId);
    if (!stored?.attribution) return null;
    return { model: stored.model, vector: stored.vector };
  }
}

function trailOf(owner: VoiceprintOwner): VoiceprintTrail {
  return { ip: owner.ip, userAgent: owner.userAgent };
}
