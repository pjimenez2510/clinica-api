import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ListeningNotOpenError } from '../domain/assistant.errors';
import { BYTES_PER_MS, type PauseReason } from '../domain/listening';

import type { ListeningChannel } from './listening.service';
import { ListeningService } from './listening.service';
import type {
  ListeningStore,
  StoredListening,
  TranscriptLine,
} from './listening.store';
import type {
  RecognitionEnd,
  RecognitionSession,
  RecognizedSegment,
  RecognizerEvents,
  SpeechRecognizer,
} from './speech-recognizer.port';

const ENCOUNTER = '0199a000-0000-7000-8000-000000000001';
const USER = '0199a000-0000-7000-8000-0000000000aa';

/**
 * A recogniser that confirms, as one segment, everything it holds when told
 * to (`confirm`) or when asked to end — the way a window of whisper closes.
 */
class FakeRecognizer implements SpeechRecognizer {
  readonly sessions: FakeRecognition[] = [];
  failOpen: Error | null = null;

  open(events: RecognizerEvents): Promise<RecognitionSession> {
    if (this.failOpen) return Promise.reject(this.failOpen);
    const session = new FakeRecognition(events);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  get current(): FakeRecognition {
    const session = this.sessions.at(-1);
    if (!session) throw new Error('no recognition was opened');
    return session;
  }
}

class FakeRecognition implements RecognitionSession {
  readonly frames: { offsetMs: number; ms: number }[] = [];
  private held: { startMs: number; endMs: number } | null = null;
  closed = false;
  endFails = false;

  constructor(private readonly events: RecognizerEvents) {}

  closing = false;

  send(frame: { offsetMs: number; pcm: Buffer }): boolean {
    if (this.closed || this.closing) return false;
    const ms = frame.pcm.length / BYTES_PER_MS;
    this.frames.push({ offsetMs: frame.offsetMs, ms });
    this.held = {
      startMs: this.held?.startMs ?? frame.offsetMs,
      endMs: frame.offsetMs + ms,
    };
    return true;
  }

  /** The window closes: what it held is one confirmed segment. */
  confirm(text = `frase en ${this.held?.startMs}`): void {
    if (!this.held) return;
    this.events.onSegment({ ...this.held, text });
    this.held = null;
  }

  end(): Promise<void> {
    if (this.endFails) return Promise.reject(new Error('did not finish'));
    this.confirm();
    this.closed = true;
    return Promise.resolve();
  }

  abort(): void {
    this.closed = true;
  }

  endByItself(how: RecognitionEnd): void {
    this.closed = true;
    this.events.onEnded(how);
  }
}

class MemoryStore implements ListeningStore {
  session: StoredListening | null = null;
  readonly segments: TranscriptLine[] = [];
  refuse = 0;
  readonly saves: StoredListening[] = [];
  refuseSave = false;

  advance(_e: string, offsetMs: number): Promise<void> {
    if (
      this.session?.state === 'LISTENING' &&
      this.session.offsetMs < offsetMs
    ) {
      this.session = { ...this.session, offsetMs };
    }
    return Promise.resolve();
  }

  find(): Promise<StoredListening | null> {
    return Promise.resolve(this.session);
  }

  save(listening: StoredListening): Promise<void> {
    if (this.refuseSave) return Promise.reject(new Error('database down'));
    this.session = listening;
    this.saves.push(listening);
    return Promise.resolve();
  }

  append(_e: string, segments: readonly RecognizedSegment[]): Promise<void> {
    if (this.refuse > 0) {
      this.refuse -= 1;
      return Promise.reject(new Error('database down'));
    }
    // AS-052: the database keeps one segment per start.
    for (const segment of segments) {
      if (!this.segments.some((s) => s.startMs === segment.startMs)) {
        this.segments.push(segment);
      }
    }
    return Promise.resolve();
  }

  transcript(): Promise<TranscriptLine[]> {
    return Promise.resolve(
      [...this.segments].sort((a, b) => a.startMs - b.startMs),
    );
  }

  purge(): Promise<number> {
    return Promise.resolve(0);
  }
}

function channel() {
  const heard: RecognizedSegment[] = [];
  const paused: PauseReason[] = [];
  let takenOver = 0;
  const events: ListeningChannel = {
    onSegment: (segment) => heard.push(segment),
    onPaused: (reason) => paused.push(reason),
    onTakenOver: () => {
      takenOver += 1;
    },
  };
  return { events, heard, paused, takenOver: () => takenOver };
}

function setup() {
  const recognizer = new FakeRecognizer();
  const store = new MemoryStore();
  let clock = Date.parse('2026-10-12T15:00:00Z'); // fecha-fija: reloj falso inyectado
  const service = new ListeningService(
    recognizer,
    store,
    () => new Date(clock),
  );
  return {
    recognizer,
    store,
    service,
    now: () => new Date(clock),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const frame = (offsetMs: number, ms = 100) => ({
  offsetMs,
  pcm: Buffer.alloc(ms * BYTES_PER_MS, 3),
});

/** `ms` of audio from `fromMs`, in frames of a tenth of a second. */
async function speak(
  service: ListeningService,
  ch: ListeningChannel,
  fromMs: number,
  ms: number,
) {
  for (let at = fromMs; at < fromMs + ms; at += 100) {
    await service.receive(ENCOUNTER, ch, frame(at));
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ListeningService', () => {
  it('AS-049: starts on the clock written down, never from zero', async () => {
    const { service, store, now } = setup();
    store.session = {
      encounterId: ENCOUNTER,
      state: 'PAUSED',
      offsetMs: 22_230,
      reason: 'device-lost',
      device: 'computador',
      startedBy: USER,
      startedAt: now(),
      updatedAt: now(),
    };

    const answer = await service.start(
      ENCOUNTER,
      USER,
      'computador',
      channel().events,
    );

    expect(answer).toEqual({ offsetMs: 22_230 });
    expect(store.session).toMatchObject({ state: 'LISTENING', reason: null });
  });

  it('AS-049: forwards only what was not heard, and writes the clock every five seconds', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    const savesAtStart = store.saves.length;

    await speak(service, ch.events, 0, 5_000);
    // The browser resends what it was not sure arrived (AS-060).
    await service.receive(ENCOUNTER, ch.events, frame(4_900));
    await service.receive(ENCOUNTER, ch.events, frame(4_950));

    const forwarded = recognizer.current.frames;
    expect(forwarded).toHaveLength(51);
    expect(forwarded.at(-1)).toEqual({ offsetMs: 5_000, ms: 50 });
    // The clock moves by `advance`, which never overwrites a pause.
    expect(store.saves.length - savesAtStart).toBe(0);
    expect(store.session?.offsetMs).toBe(5_000);
  });

  it('AS-050: pausing waits for the recogniser and keeps its last sentence before answering', async () => {
    const { service, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    await speak(service, ch.events, 0, 1_200);

    const answer = await service.pause(ENCOUNTER, ch.events);

    expect(answer).toEqual({ offsetMs: 1_200 });
    expect(store.segments).toEqual([
      { startMs: 0, endMs: 1_200, text: 'frase en 0' },
    ]);
    expect(ch.heard).toHaveLength(1);
    expect(store.session).toMatchObject({ state: 'PAUSED', reason: null });
  });

  it('AS-050: stopping leaves it STOPPED, and starting again continues the clock', async () => {
    const { service, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    await speak(service, ch.events, 0, 800);

    await service.stop(ENCOUNTER, ch.events);
    expect(store.session?.state).toBe('STOPPED');

    expect(
      await service.start(ENCOUNTER, USER, 'computador', ch.events),
    ).toEqual({ offsetMs: 800 });
  });

  it('AS-051: a cut channel pauses with device-lost and keeps the sentence inside the recogniser', async () => {
    const { service, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    await speak(service, ch.events, 0, 2_000);

    await service.disconnected(ch.events);

    expect(store.session).toMatchObject({
      state: 'PAUSED',
      reason: 'device-lost',
      offsetMs: 2_000,
    });
    expect(store.segments.map((s) => s.startMs)).toEqual([0]);
    expect(ch.paused).toEqual(['device-lost']);
  });

  it('AS-051: E-031 — six sentences with a pause, a cut mid-sentence, a reconnection that resends, and a stop: six segments, in order, none repeated', async () => {
    const { service, recognizer, store } = setup();
    const first = channel();
    const sentences = [0, 4_100, 10_300, 16_700, 22_300, 28_000];
    const lengthOf = (i: number) =>
      (sentences[i + 1] ?? 32_300) - sentences[i]!;

    await service.start(ENCOUNTER, USER, 'computador', first.events);
    for (const [i, at] of sentences.slice(0, 2).entries()) {
      await speak(service, first.events, at, lengthOf(i));
      recognizer.current.confirm();
    }
    await flush();
    // A pause without silence before it.
    await speak(service, first.events, 10_300, lengthOf(2));
    await service.pause(ENCOUNTER, first.events);
    await service.start(ENCOUNTER, USER, 'computador', first.events);
    // The fourth sentence is inside the recogniser when the channel dies.
    await speak(service, first.events, 16_700, lengthOf(3));
    await service.disconnected(first.events);

    // The page comes back on a new channel and resends its last second.
    const second = channel();
    const { offsetMs } = await service.start(
      ENCOUNTER,
      USER,
      'computador',
      second.events,
    );
    expect(offsetMs).toBe(22_300);
    await speak(service, second.events, 21_300, 1_000);
    for (const [i, at] of sentences.slice(4).entries()) {
      await speak(service, second.events, at, lengthOf(i + 4));
      if (i === 0) recognizer.current.confirm();
    }
    // A stop without silence after it.
    await service.stop(ENCOUNTER, second.events);

    const transcript = await service.transcriptOf(ENCOUNTER);
    expect(transcript.map((line) => line.startMs)).toEqual(sentences);
    expect(new Set(transcript.map((l) => l.startMs)).size).toBe(6);
    expect(store.session).toMatchObject({ state: 'STOPPED', offsetMs: 32_300 });
  });

  it('AS-054: another channel takes the capture over, and the first one is told and refused', async () => {
    const { service } = setup();
    const desk = channel();
    const phone = channel();
    await service.start(ENCOUNTER, USER, 'computador', desk.events);
    await speak(service, desk.events, 0, 300);

    expect(
      await service.start(ENCOUNTER, USER, 'teléfono', phone.events),
    ).toEqual({ offsetMs: 300 });
    expect(desk.takenOver()).toBe(1);
    await expect(
      service.receive(ENCOUNTER, desk.events, frame(300)),
    ).rejects.toBeInstanceOf(ListeningNotOpenError);
    await speak(service, phone.events, 300, 100);
  });

  it('AS-055: a recogniser that fails pauses the listening with its reason', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);

    recognizer.current.endByItself('failed');
    await flush();
    await flush();

    expect(store.session).toMatchObject({
      state: 'PAUSED',
      reason: 'recognizer-failed',
    });
    expect(ch.paused).toEqual(['recognizer-failed']);
  });

  it('AS-055: a recogniser closed for its own limits is reopened with the next frame, on the same clock, without pausing', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    await speak(service, ch.events, 0, 500);

    recognizer.current.endByItself('expired');
    await speak(service, ch.events, 500, 200);

    expect(recognizer.sessions).toHaveLength(2);
    expect(recognizer.current.frames[0]?.offsetMs).toBe(500);
    expect(store.session?.state).toBe('LISTENING');
    expect(ch.paused).toEqual([]);
  });

  it('AS-055: an end that does not finish pauses with recognizer-failed', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    recognizer.current.endFails = true;

    await service.pause(ENCOUNTER, ch.events);

    expect(store.session).toMatchObject({
      state: 'PAUSED',
      reason: 'recognizer-failed',
    });
  });

  it('AS-055: three refusals of the store in a row pause with store-failed, and the held lines go with the next one', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    store.refuse = 1;
    await speak(service, ch.events, 0, 100);
    recognizer.current.confirm();
    await speak(service, ch.events, 100, 100);
    recognizer.current.confirm();
    await flush();
    // Positive control: one refusal is a blip, and nothing is lost.
    expect(store.segments.map((s) => s.startMs)).toEqual([0, 100]);

    store.refuse = 3;
    for (const at of [200, 300, 400]) {
      await speak(service, ch.events, at, 100);
      recognizer.current.confirm();
    }
    await flush();
    await flush();

    expect(store.session).toMatchObject({
      state: 'PAUSED',
      reason: 'store-failed',
    });
  });

  it('AS-058: nothing of what was heard reaches the log', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    store.refuse = 3;
    for (const at of [0, 100, 200]) {
      await speak(service, ch.events, at, 100);
      recognizer.current.confirm('Tomo enalapril de 10 miligramos');
    }
    await flush();

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/enalapril/);
  });

  it('AS-049: refuses a frame or a pause on a channel that is not listening', async () => {
    const { service } = setup();

    await expect(
      service.receive(ENCOUNTER, channel().events, frame(0)),
    ).rejects.toBeInstanceOf(ListeningNotOpenError);
    await expect(
      service.pause(ENCOUNTER, channel().events),
    ).rejects.toBeInstanceOf(ListeningNotOpenError);
  });

  it('AS-048: a recogniser that cannot listen opens nothing and writes nothing', async () => {
    const { service, recognizer, store } = setup();
    recognizer.failOpen = new Error('cannot listen');

    await expect(
      service.start(ENCOUNTER, USER, 'computador', channel().events),
    ).rejects.toThrow('cannot listen');
    expect(store.session).toBeNull();
  });

  it('AS-055: a silent channel does not hold clinica-ai: closed for idleness, nothing is reopened until audio comes', async () => {
    const { service, recognizer, store } = setup();
    await service.start(ENCOUNTER, USER, 'computador', channel().events);

    recognizer.current.endByItself('expired');
    await flush();

    expect(recognizer.sessions).toHaveLength(1);
    expect(store.session?.state).toBe('LISTENING');
  });

  it('AS-055: a frame that meets the recognition closing is not heard and does not pause', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    recognizer.current.closing = true;

    await speak(service, ch.events, 0, 100);

    expect(ch.paused).toEqual([]);
    expect(store.session?.state).toBe('LISTENING');
    // Not heard: the browser's resend from the clock covers it.
    expect((await service.sessionOf(ENCOUNTER))?.offsetMs).toBe(0);
  });

  it('AS-054 AS-051: after a take-over, the old channel going away does not pause the new one', async () => {
    const { service, store } = setup();
    const desk = channel();
    const phone = channel();
    await service.start(ENCOUNTER, USER, 'computador', desk.events);
    await service.start(ENCOUNTER, USER, 'teléfono', phone.events);

    await service.disconnected(desk.events);

    expect(store.session?.state).toBe('LISTENING');
    expect(phone.paused).toEqual([]);
    await speak(service, phone.events, 0, 100);
  });

  it('AS-050: a line the store refused once is kept when the physician pauses', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    store.refuse = 1;
    await speak(service, ch.events, 0, 100);
    recognizer.current.confirm();
    await flush();
    expect(store.segments).toEqual([]);

    await service.pause(ENCOUNTER, ch.events);

    expect(store.segments.map((s) => s.startMs)).toEqual([0]);
    expect(ch.heard.map((s) => s.startMs)).toEqual([0]);
  });

  it('AS-055: a pause the system makes is told to the channel even when writing it down fails', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    store.refuseSave = true;

    recognizer.current.endByItself('failed');
    await flush();
    await flush();

    expect(ch.paused).toEqual(['recognizer-failed']);
    await expect(
      service.receive(ENCOUNTER, ch.events, frame(0)),
    ).rejects.toBeInstanceOf(ListeningNotOpenError);
  });

  it('AS-049: a frame far ahead of the clock is dropped, and does not move it', async () => {
    const { service, recognizer } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);

    await service.receive(ENCOUNTER, ch.events, frame(3_000_000_000));
    await speak(service, ch.events, 0, 200);

    expect(recognizer.current.frames.map((f) => f.offsetMs)).toEqual([0, 100]);
  });

  it('AS-049: audio faster than speech, beyond what a reconnection holds, is dropped', async () => {
    const { service, recognizer } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);

    // 80 s of audio in no time: the backlog a reconnection may resend is 75 s.
    await speak(service, ch.events, 0, 80_000);

    expect(recognizer.current.frames.at(-1)?.offsetMs).toBe(74_900);
  });

  it('AS-045: an attention closed while it is listened to stops the listening, whatever channel holds it', async () => {
    const { service, recognizer, store } = setup();
    const ch = channel();
    await service.start(ENCOUNTER, USER, 'computador', ch.events);
    await speak(service, ch.events, 0, 300);

    await service.close(ENCOUNTER);

    expect(store.session).toMatchObject({ state: 'STOPPED', offsetMs: 300 });
    expect(store.segments.map((s) => s.startMs)).toEqual([0]);
    expect(recognizer.current.closed).toBe(true);
    await expect(
      service.receive(ENCOUNTER, ch.events, frame(300)),
    ).rejects.toBeInstanceOf(ListeningNotOpenError);
  });
});
