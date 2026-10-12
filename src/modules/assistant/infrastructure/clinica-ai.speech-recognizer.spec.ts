import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import type {
  RecognitionEnd,
  RecognizedSegment,
} from '../application/speech-recognizer.port';
import { ListeningUnavailableError } from '../domain/assistant.errors';
import { BYTES_PER_MS } from '../domain/listening';

import { ClinicaAiSpeechRecognizer } from './clinica-ai.speech-recognizer';

const SECRET = 's'.repeat(40);

interface Fake {
  url: string;
  /** What each accepted socket received, in order. */
  received: (Buffer | string)[];
  authorizations: (string | undefined)[];
  sockets: WebSocket[];
}

let server: WebSocketServer | undefined;

afterEach(async () => {
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = undefined;
});

/**
 * `clinica-ai`'s listening socket as `speech/router.py` speaks it: binary
 * frames with a 4-byte offset in, `{"type":"end"}` → segments, `ended`, close.
 * Each frame answers one segment covering it, as a confirmed window would.
 */
async function fakeClinicaAi(
  behave: (socket: WebSocket, fake: Fake) => void = echo,
): Promise<Fake> {
  const fake: Fake = { url: '', received: [], authorizations: [], sockets: [] };
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server!.on('listening', resolve));
  server.on('connection', (socket, request) => {
    fake.authorizations.push(request.headers.authorization);
    fake.sockets.push(socket);
    behave(socket, fake);
  });
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

function echo(socket: WebSocket, fake: Fake): void {
  const held: { startMs: number; endMs: number }[] = [];
  socket.on('message', (data: Buffer, binary: boolean) => {
    if (binary) {
      fake.received.push(data);
      const startMs = data.readUInt32LE(0);
      held.push({
        startMs,
        endMs: startMs + (data.length - 4) / BYTES_PER_MS,
      });
      return;
    }
    fake.received.push(data.toString());
    for (const window of held.splice(0)) {
      socket.send(
        JSON.stringify({
          type: 'segment',
          ...window,
          text: `frase ${window.startMs}`,
          final: true,
        }),
      );
    }
    socket.send(JSON.stringify({ type: 'ended' }));
    socket.close();
  });
}

function status(speech: { available: boolean; voiceDetection: boolean }) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          catalogue: { loaded: false, names: 0, places: 0 },
          speech: {
            ...speech,
            model: 'ggml-large-v3-turbo.bin',
            recognitions: { limit: 1, running: 0, waiting: 0 },
          },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  return { fetcher, calls };
}

const ready = () => status({ available: true, voiceDetection: true });

function recognizer(fake: Fake, fetcher = ready().fetcher, endWaitMs = 2_000) {
  return new ClinicaAiSpeechRecognizer({
    baseUrl: fake.url,
    secret: SECRET,
    timeoutMs: 1_000,
    endWaitMs,
    fetcher,
  });
}

function listener() {
  const segments: RecognizedSegment[] = [];
  const ended: RecognitionEnd[] = [];
  return {
    segments,
    ended,
    events: {
      onSegment: (segment: RecognizedSegment) => segments.push(segment),
      onEnded: (how: RecognitionEnd) => ended.push(how),
    },
  };
}

const frame = (offsetMs: number, ms = 100) => ({
  offsetMs,
  pcm: Buffer.alloc(ms * BYTES_PER_MS, 7),
});

const until = async (condition: () => boolean) => {
  // Polls the event loop, never a fixed sleep: it ends as soon as it holds.
  for (let turn = 0; turn < 500 && !condition(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('ClinicaAiSpeechRecognizer', () => {
  it('AS-048: refuses to listen when clinica-ai has no voice detector, and opens nothing', async () => {
    const fake = await fakeClinicaAi();
    const { fetcher } = status({ available: true, voiceDetection: false });

    await expect(
      recognizer(fake, fetcher).open(listener().events),
    ).rejects.toEqual(new ListeningUnavailableError('no-voice-detection'));
    expect(fake.sockets).toHaveLength(0);
  });

  it('AS-048: refuses to listen without a recogniser, or when clinica-ai does not answer', async () => {
    const fake = await fakeClinicaAi();

    await expect(
      recognizer(
        fake,
        status({ available: false, voiceDetection: true }).fetcher,
      ).open(listener().events),
    ).rejects.toMatchObject({ reason: 'no-recognizer' });
    await expect(
      recognizer(fake, () =>
        Promise.reject(new TypeError('fetch failed')),
      ).open(listener().events),
    ).rejects.toMatchObject({ reason: 'unreachable' });
    expect(fake.sockets).toHaveLength(0);
  });

  it('AS-048: asks for the status and opens the stream with the secret in a header, never in the URL', async () => {
    const fake = await fakeClinicaAi();
    const { fetcher, calls } = ready();

    const session = await recognizer(fake, fetcher).open(listener().events);
    session.abort();

    expect(calls).toEqual([
      { url: `${fake.url}/v1/status`, authorization: `Bearer ${SECRET}` },
    ]);
    expect(fake.authorizations).toEqual([`Bearer ${SECRET}`]);
  });

  it('AS-049, AS-050: sends each frame with its offset in front, and end() waits for the last segment', async () => {
    const fake = await fakeClinicaAi();
    const heard = listener();
    const session = await recognizer(fake).open(heard.events);

    session.send(frame(4_100));
    session.send(frame(4_200));
    await session.end();

    const binary = fake.received.filter((m): m is Buffer => Buffer.isBuffer(m));
    expect(binary.map((b) => b.readUInt32LE(0))).toEqual([4_100, 4_200]);
    expect(binary[0]?.length).toBe(4 + 100 * BYTES_PER_MS);
    expect(fake.received.at(-1)).toBe('{"type":"end"}');
    // Every segment was handed over by the time end() resolved.
    expect(heard.segments.map((s) => s.startMs)).toEqual([4_100, 4_200]);
    expect(heard.ended).toEqual([]);
  });

  it('AS-055: a close for its own limits (1001) ends as expired', async () => {
    const fake = await fakeClinicaAi((socket) => socket.close(1001));
    const heard = listener();

    await recognizer(fake).open(heard.events);
    await until(() => heard.ended.length > 0);

    expect(heard.ended).toEqual(['expired']);
  });

  it('AS-055: busy, a crash or a close without ending ends as failed', async () => {
    const fake = await fakeClinicaAi((socket) => {
      socket.send(JSON.stringify({ type: 'busy' }));
      socket.close(1013);
    });
    const heard = listener();

    await recognizer(fake).open(heard.events);
    await until(() => heard.ended.length > 0);

    expect(heard.ended).toEqual(['failed']);
  });

  it('AS-050: end() rejects when clinica-ai does not finish in time, and closes', async () => {
    const fake = await fakeClinicaAi(() => undefined);
    const session = await recognizer(fake, ready().fetcher, 50).open(
      listener().events,
    );

    await expect(session.end()).rejects.toThrow(/did not finish/);
    await until(() => fake.sockets[0]?.readyState === fake.sockets[0]?.CLOSED);
    expect(fake.sockets[0]?.readyState).toBe(fake.sockets[0]?.CLOSED);
  });

  it('AS-053: send() refuses once the recognition is closed, keeping nothing', async () => {
    const fake = await fakeClinicaAi((socket) => socket.close(1011));
    const heard = listener();
    const session = await recognizer(fake).open(heard.events);
    await until(() => heard.ended.length > 0);

    expect(() => session.send(frame(0))).toThrow(/not open/);
  });
});
