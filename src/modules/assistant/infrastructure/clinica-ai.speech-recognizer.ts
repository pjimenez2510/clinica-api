import { WebSocket } from 'ws';
import { z } from 'zod';

import type {
  RecognitionEnd,
  RecognitionSession,
  RecognizerEvents,
  SpeechRecognizer,
} from '../application/speech-recognizer.port';
import { ListeningUnavailableError } from '../domain/assistant.errors';
import type { AudioFrame } from '../domain/listening';

/** AS-048. What `/v1/status` says of speech (`core/health.py` there). */
const statusSchema = z.object({
  speech: z.object({
    available: z.boolean(),
    voiceDetection: z.boolean(),
  }),
});

const segmentSchema = z.object({
  type: z.literal('segment'),
  startMs: z.number().int().min(0),
  endMs: z.number().int(),
  text: z.string(),
});

/** How long the stream has to complete its handshake. */
const OPEN_TIMEOUT_MS = 5_000;
/**
 * AS-050. A window is at most twenty seconds and the recogniser gives up on
 * it after sixty (CAI-012): waiting longer for `ended` is waiting for a
 * process that is not coming back.
 */
const END_WAIT_MS = 90_000;
/** `clinica-ai` closed the stream for its own limits: idle or too long (CAI-015). */
const GOING_AWAY = 1001;

export interface ClinicaAiSpeechOptions {
  baseUrl: string;
  secret: string;
  /** For `/v1/status`: `ASSISTANT_AI_SERVICE_TIMEOUT_MS`. */
  timeoutMs: number;
  endWaitMs?: number;
  fetcher?: typeof fetch;
}

/**
 * AS-048 to AS-055. The recogniser on the other side of `clinica-ai`
 * (whisper.cpp with voice detection, on this machine), over the socket of
 * `speech/router.py`: four bytes of offset (little endian) and PCM16 in,
 * `segment` / `ended` / `failed` / `unavailable` / `busy` out.
 *
 * The browser never talks to `clinica-ai`: `clinica-api` checks the session,
 * the permission and the owner of the attention in one place and forwards the
 * frames here. Each frame is written to the socket and dropped — nothing is
 * buffered, stored or logged (AS-053). The secret goes in a header, never in
 * the URL, which ends up in access logs.
 */
export class ClinicaAiSpeechRecognizer implements SpeechRecognizer {
  /** ECMAScript-private: an `inspect` of the adapter does not print it. */
  readonly #secret: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ClinicaAiSpeechOptions) {
    this.#secret = options.secret;
    this.fetcher = options.fetcher ?? fetch;
  }

  async open(events: RecognizerEvents): Promise<RecognitionSession> {
    await this.requireVoiceDetection();

    const socket = new WebSocket(this.streamUrl(), {
      headers: { authorization: `Bearer ${this.#secret}` },
      // A redirect would send the audio on to wherever it points.
      followRedirects: false,
      handshakeTimeout: OPEN_TIMEOUT_MS,
    });
    return listen(socket, events, this.options.endWaitMs ?? END_WAIT_MS);
  }

  /**
   * AS-048. Without the voice detector whisper writes sentences nobody said
   * over silence (E-028); `clinica-ai` uses it only when installed (CAI-010),
   * so the obligation is enforced here, before anything is opened.
   */
  private async requireVoiceDetection(): Promise<void> {
    let body: unknown;
    try {
      const response = await this.fetcher(this.url('v1/status'), {
        redirect: 'manual',
        headers: { authorization: `Bearer ${this.#secret}` },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      body = await response.json();
    } catch {
      throw new ListeningUnavailableError('unreachable');
    }

    const status = statusSchema.safeParse(body);
    if (!status.success) throw new ListeningUnavailableError('unreachable');
    if (!status.data.speech.available) {
      throw new ListeningUnavailableError('no-recognizer');
    }
    if (!status.data.speech.voiceDetection) {
      throw new ListeningUnavailableError('no-voice-detection');
    }
  }

  private streamUrl(): string {
    return this.url('v1/speech/stream').replace(/^http/, 'ws');
  }

  private url(path: string): string {
    const base = this.options.baseUrl.endsWith('/')
      ? this.options.baseUrl
      : `${this.options.baseUrl}/`;
    return new URL(path, base).toString();
  }
}

/** Resolves once the stream is open; a stream that never opens is unreachable. */
async function listen(
  socket: WebSocket,
  events: RecognizerEvents,
  endWaitMs: number,
): Promise<RecognitionSession> {
  let opened = false;
  let ended = false;
  let finished = false;
  let waiting: { resolve: () => void; reject: (error: Error) => void } | null =
    null;

  socket.on('message', (data: Buffer, binary: boolean) => {
    if (binary) return;
    const message = parse(data.toString('utf8'));
    if (message === null) return;
    const segment = segmentSchema.safeParse(message);
    if (segment.success) {
      const { startMs, endMs, text } = segment.data;
      if (endMs > startMs && text.trim() !== '') {
        events.onSegment({ startMs, endMs, text: text.trim() });
      }
      return;
    }
    if ((message as { type?: unknown }).type === 'ended') {
      ended = true;
      waiting?.resolve();
    }
  });

  socket.on('close', (code: number) => {
    // Before `open`, the refusal is the rejection of `open` itself.
    if (!opened || ended || finished) return;
    finished = true;
    if (waiting) {
      waiting.reject(new Error('the recogniser closed before finishing'));
      return;
    }
    const how: RecognitionEnd = code === GOING_AWAY ? 'expired' : 'failed';
    events.onEnded(how);
  });

  // An error is always followed by `close`, which says how it ended.
  socket.on('error', () => undefined);

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      opened = true;
      resolve();
    });
    socket.once('close', () =>
      reject(new ListeningUnavailableError('unreachable')),
    );
  });

  return {
    send(frame: AudioFrame): void {
      if (socket.readyState !== WebSocket.OPEN || ended) {
        throw new Error('the recognition is not open');
      }
      const header = Buffer.alloc(4);
      header.writeUInt32LE(frame.offsetMs, 0);
      socket.send(Buffer.concat([header, frame.pcm]));
    },

    end(): Promise<void> {
      if (ended) return Promise.resolve();
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('the recognition is not open'));
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          finished = true;
          socket.terminate();
          reject(new Error(`the recogniser did not finish in ${endWaitMs} ms`));
        }, endWaitMs);
        waiting = {
          resolve: () => {
            clearTimeout(timer);
            waiting = null;
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            waiting = null;
            reject(error);
          },
        };
        socket.send(JSON.stringify({ type: 'end' }));
      });
    },

    abort(): void {
      finished = true;
      socket.terminate();
    },
  };
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
