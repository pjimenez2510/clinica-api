import { Inject, Injectable, Logger } from '@nestjs/common';

import { ListeningNotOpenError } from '../domain/assistant.errors';
import {
  frameEndMs,
  unheardPart,
  type AudioFrame,
  type ListeningState,
  type PauseReason,
} from '../domain/listening';

import {
  LISTENING_STORE,
  type ListeningStore,
  type StoredListening,
  type TranscriptLine,
} from './listening.store';
import {
  SPEECH_RECOGNIZER,
  type RecognitionEnd,
  type RecognitionSession,
  type RecognizedSegment,
  type SpeechRecognizer,
} from './speech-recognizer.port';

/**
 * The channel that captures, as the service sees it: the browser on the other
 * end of a socket. Its identity is what tells two devices apart (AS-054).
 */
export interface ListeningChannel {
  /** A segment, after it was kept (AS-052). */
  onSegment(segment: RecognizedSegment): void;
  /** AS-051, AS-055. The listening paused itself, and this is why. */
  onPaused(reason: PauseReason, offsetMs: number): void;
  /** AS-054. Another channel of the same professional took the capture. */
  onTakenOver(): void;
}

/** AS-049. The clock is written down at least this often while listening. */
const PERSIST_EVERY_MS = 5_000;
/** AS-055. Segments the store may refuse in a row before the listening pauses. */
const UNSTORED_LIMIT = 3;

export const LISTENING_CLOCK = Symbol('LISTENING_CLOCK');
export type ListeningClock = () => Date;

interface Live {
  encounterId: string;
  userId: string;
  channel: ListeningChannel;
  recognition: RecognitionSession;
  /** AS-049. The end of the last audio forwarded: what the server received. */
  offsetMs: number;
  persistedMs: number;
  device: string;
  startedAt: Date;
  /** What was handed to the store, in order: ending waits for the last line. */
  keeping: Promise<void>;
  /** Segments the store refused, in order, to go with the next that lands. */
  unstored: RecognizedSegment[];
  /** AS-055. A recognition being reopened after `clinica-ai`'s own limits. */
  reopening: Promise<void> | null;
}

/**
 * AS-049 to AS-056. Listening to a consultation and keeping what was said.
 *
 * Adapted from SigmAI's `TranscriptionService`, which E-031 measured (6/6
 * sentences, 0 duplicated). Two rules run it. **The audio is never written
 * anywhere** (AS-053): a frame arrives, the part not yet heard goes to the
 * recogniser, and the reference is dropped. And the listening has **a clock
 * of its own** (AS-049): a pause, a cut, a reload or a restart continue it,
 * and pausing or stopping wait for the recogniser to hand over what it still
 * holds (AS-050).
 *
 * Who may listen is decided before this service is called (AS-045): it trusts
 * the gateway with the owner of the attention, as a service trusts its
 * controller with the permission.
 *
 * One process holds the live listenings (D-247 §5): the clock written every
 * five seconds is what survives a restart.
 */
@Injectable()
export class ListeningService {
  private readonly logger = new Logger(ListeningService.name);
  private readonly live = new Map<string, Live>();
  /** One command at a time per attention: a stop never overtakes its start. */
  private readonly turns = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(SPEECH_RECOGNIZER) private readonly recognizer: SpeechRecognizer,
    @Inject(LISTENING_STORE) private readonly store: ListeningStore,
    @Inject(LISTENING_CLOCK) private readonly now: ListeningClock,
  ) {}

  /**
   * AS-049, AS-054. Starts, resumes, or takes the capture over. Answers the
   * clock the listening is at: the frames of the browser continue from it.
   */
  start(
    encounterId: string,
    userId: string,
    device: string,
    channel: ListeningChannel,
  ): Promise<{ offsetMs: number }> {
    return this.inTurn(encounterId, async () => {
      const already = this.live.get(encounterId);
      if (already) {
        if (already.channel !== channel) {
          already.channel.onTakenOver();
          already.channel = channel;
          already.device = device;
          await this.write(already, 'LISTENING', null);
        }
        return { offsetMs: already.offsetMs };
      }

      const stored = await this.store.find(encounterId);
      const offsetMs = stored?.offsetMs ?? 0;
      const live: Live = {
        encounterId,
        userId,
        channel,
        recognition: undefined as unknown as RecognitionSession,
        offsetMs,
        persistedMs: offsetMs,
        device,
        startedAt: stored?.startedAt ?? this.now(),
        keeping: Promise.resolve(),
        unstored: [],
        reopening: null,
      };
      // AS-048. Throws `ListeningUnavailableError` and opens nothing.
      live.recognition = await this.recognizer.open(this.eventsOf(live));
      this.live.set(encounterId, live);
      await this.write(live, 'LISTENING', null);
      return { offsetMs };
    });
  }

  /**
   * AS-049, AS-053. One frame: the part not yet heard goes to the recogniser
   * and is forgotten. A frame of a channel that does not hold the capture is
   * refused (AS-054): the gateway drops it.
   */
  async receive(
    encounterId: string,
    channel: ListeningChannel,
    frame: AudioFrame,
  ): Promise<void> {
    const live = this.live.get(encounterId);
    if (live?.channel !== channel) throw new ListeningNotOpenError();
    if (live.reopening) await live.reopening;
    if (this.live.get(encounterId) !== live) throw new ListeningNotOpenError();

    const unheard = unheardPart(frame, live.offsetMs);
    if (!unheard) return;

    try {
      live.recognition.send(unheard);
    } catch {
      this.quietly(
        this.suspend(encounterId, 'recognizer-failed'),
        encounterId,
        'the listening could not be suspended after the recogniser went away',
      );
      return;
    }
    live.offsetMs = Math.max(
      live.offsetMs,
      frameEndMs(unheard.offsetMs, unheard.pcm),
    );

    if (live.offsetMs - live.persistedMs >= PERSIST_EVERY_MS) {
      await this.write(live, 'LISTENING', null);
    }
  }

  /** AS-050. Waits for the recogniser to hand over what it held. */
  pause(
    encounterId: string,
    channel: ListeningChannel,
  ): Promise<{ offsetMs: number }> {
    return this.inTurn(encounterId, async () => {
      const live = this.live.get(encounterId);
      if (live?.channel !== channel) throw new ListeningNotOpenError();
      return this.finish(live, 'PAUSED', null);
    });
  }

  /**
   * AS-050. A pause the physician does not come back from — until they start
   * again, on the same clock. A stop from a channel that never started (the
   * server refused, the page reloaded) still stops what is written down.
   */
  stop(
    encounterId: string,
    channel: ListeningChannel,
  ): Promise<{ offsetMs: number }> {
    return this.inTurn(encounterId, async () => {
      const live = this.live.get(encounterId);
      if (live?.channel === channel) return this.finish(live, 'STOPPED', null);
      if (live) throw new ListeningNotOpenError();

      const stored = await this.store.find(encounterId);
      if (stored && stored.state !== 'STOPPED') {
        await this.store.save({
          ...stored,
          state: 'STOPPED',
          reason: null,
          updatedAt: this.now(),
        });
      }
      return { offsetMs: stored?.offsetMs ?? 0 };
    });
  }

  /**
   * AS-051. The channel went away without pausing: the listening pauses with
   * `device-lost`, after the recogniser handed over what it held — the
   * sentence inside it when the cut came survives (E-031).
   */
  async disconnected(channel: ListeningChannel): Promise<void> {
    const held = [...this.live.values()].filter(
      (live) => live.channel === channel,
    );
    await Promise.all(
      held.map((live) => this.suspend(live.encounterId, 'device-lost')),
    );
  }

  /** AS-056. The listening as the screen shows it: what is live is fresher. */
  async sessionOf(
    encounterId: string,
  ): Promise<(StoredListening & { capturing: boolean }) | null> {
    const stored = await this.store.find(encounterId);
    if (!stored) return null;
    const live = this.live.get(encounterId);
    return live
      ? {
          ...stored,
          state: 'LISTENING',
          offsetMs: live.offsetMs,
          capturing: true,
        }
      : { ...stored, capturing: false };
  }

  transcriptOf(encounterId: string): Promise<TranscriptLine[]> {
    return this.store.transcript(encounterId);
  }

  /** The process is going down: nothing more is heard, the clock is kept. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        live.recognition.abort();
        this.live.delete(live.encounterId);
        await live.keeping;
        await this.write(live, 'PAUSED', 'device-lost').catch(() => undefined);
      }),
    );
  }

  /** AS-051, AS-055. The listening pauses itself and says why. */
  private suspend(
    encounterId: string,
    reason: PauseReason,
  ): Promise<{ offsetMs: number } | null> {
    return this.inTurn(encounterId, async () => {
      const live = this.live.get(encounterId);
      if (!live) return null;
      const answer = await this.finish(live, 'PAUSED', reason);
      live.channel.onPaused(reason, answer.offsetMs);
      return answer;
    });
  }

  private async finish(
    live: Live,
    state: ListeningState,
    reason: PauseReason | null,
  ): Promise<{ offsetMs: number }> {
    if (live.reopening) await live.reopening.catch(() => undefined);
    // Nothing more is accepted: frames that arrive while it ends are refused.
    this.live.delete(live.encounterId);
    try {
      await live.recognition.end();
    } catch {
      // The tail is what could not be recognised; the pause says so.
      if (state === 'PAUSED') reason ??= 'recognizer-failed';
      this.logger.warn(
        { encounter_id: live.encounterId, error_code: 'recognizer-end' },
        'the recogniser did not hand over what it held',
      );
    }
    await live.keeping;
    await this.write(live, state, reason);
    return { offsetMs: live.offsetMs };
  }

  private eventsOf(live: Live) {
    return {
      onSegment: (segment: RecognizedSegment) => this.keep(live, segment),
      onEnded: (how: RecognitionEnd) => this.recognitionEnded(live, how),
    };
  }

  /**
   * AS-055. `clinica-ai` closed the recognition by itself. For its own limits
   * (idle, three hours) a new one continues on the same clock; anything else
   * pauses the listening with its reason.
   */
  private recognitionEnded(live: Live, how: RecognitionEnd): void {
    if (this.live.get(live.encounterId) !== live) return;

    if (how === 'failed') {
      this.quietly(
        this.suspend(live.encounterId, 'recognizer-failed'),
        live.encounterId,
        'the listening could not be suspended after the recogniser failed',
      );
      return;
    }

    live.reopening = this.recognizer
      .open(this.eventsOf(live))
      .then((recognition) => {
        live.recognition = recognition;
      })
      .finally(() => {
        live.reopening = null;
      });
    live.reopening.catch(() => {
      this.quietly(
        this.suspend(live.encounterId, 'recognizer-failed'),
        live.encounterId,
        'the listening could not be suspended after reopening failed',
      );
    });
  }

  /**
   * AS-052, AS-055. Lines are kept one after another, in the order they were
   * confirmed; the channel hears a line only once it is kept. What the store
   * refused goes first with the next one; three refusals in a row pause.
   */
  private keep(live: Live, segment: RecognizedSegment): void {
    live.keeping = live.keeping.then(async () => {
      const pending = [...live.unstored, segment];
      try {
        await this.store.append(live.encounterId, pending, this.now());
        live.unstored = [];
      } catch {
        live.unstored = pending;
        this.logger.warn(
          {
            encounter_id: live.encounterId,
            count: pending.length,
            error_code: 'transcript-store',
          },
          'a transcript segment could not be kept and waits for the next one',
        );
        if (live.unstored.length >= UNSTORED_LIMIT) {
          this.quietly(
            this.suspend(live.encounterId, 'store-failed'),
            live.encounterId,
            'the listening could not be suspended after the store refused',
          );
        }
        return;
      }
      for (const kept of pending) live.channel.onSegment(kept);
    });
  }

  private async write(
    live: Live,
    state: ListeningState,
    reason: PauseReason | null,
  ): Promise<void> {
    live.persistedMs = live.offsetMs;
    await this.store.save({
      encounterId: live.encounterId,
      state,
      offsetMs: live.offsetMs,
      reason,
      device: live.device,
      startedBy: live.userId,
      startedAt: live.startedAt,
      updatedAt: this.now(),
    });
  }

  /** One command at a time per attention, in the order they arrived. */
  private inTurn<T>(encounterId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(encounterId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.turns.set(encounterId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.turns.get(encounterId) === next)
          this.turns.delete(encounterId);
      });
    return next;
  }

  /** For work nobody waits for: the reason is logged, the process goes on. */
  private quietly(
    work: Promise<unknown>,
    encounterId: string,
    what: string,
  ): void {
    work.catch(() => {
      this.logger.warn(
        { encounter_id: encounterId, error_code: 'listening' },
        what,
      );
    });
  }
}
