import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { WebSocket } from 'ws';

/**
 * AS-062. E-031 again, on this system: does the listening lose or repeat
 * anything when it is paused, cut and resumed?
 *
 * Against the API and `clinica-ai` running (whisper with voice detection), as
 * the browser does it: six invented sentences (`test/fixtures/escucha`, made
 * with the system's synthetic voice — no patient), streamed in real time in
 * frames of a tenth of a second with the session clock in front;
 *
 *   1–2 with a pause of silence after each,
 *   3 and a PAUSE with no silence before it,
 *   4 and the channel KILLED with that sentence still inside the recogniser,
 *   a new ticket, a new channel, the last second resent,
 *   5–6 and a STOP with no silence after it.
 *
 * Then it reads the transcript and counts, for each sentence, how many times
 * its own word appears: once is neither lost nor repeated. Whisper may mishear
 * a word; that is recognition, not the pipeline, and is reported apart.
 *
 *   pnpm listening:measure --encounter <id> [--email medico@clinica.ec]
 *   (the password in LISTENING_PASSWORD; the accounts are in prisma/seed.mts)
 */
const { values } = parseArgs({
  options: {
    encounter: { type: 'string' },
    email: { type: 'string', default: 'medico@clinica.ec' },
    api: { type: 'string', default: process.env.API_URL },
  },
});
const encounterId = values.encounter;
const password = process.env.LISTENING_PASSWORD;
if (!encounterId || !password || !values.api) {
  console.error('Uso: LISTENING_PASSWORD=… pnpm listening:measure --encounter <id> [--email …] [--api http://localhost:3260]'); // prettier-ignore
  process.exit(2);
}
const api = values.api.replace(/\/$/, '');

const FRAME_MS = 100;
const BYTES_PER_MS = 32;
const SILENCE_AFTER_MS = 1_800;
/** The word of each sentence that appears in no other. */
const WORDS = ['cuenteme', 'duele', 'medicamento', 'miligramos', 'temperatura', 'control']; // prettier-ignore

const fold = (text: string) =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** The PCM16 of a WAV, wherever its `data` chunk is. */
function pcmOf(file: string): Buffer {
  const wav = readFileSync(file);
  let at = 12;
  while (at < wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: sin datos de audio`);
}

const sentences = WORDS.map(
  (_, i) =>
  pcmOf(resolve(import.meta.dirname, `../test/fixtures/escucha/frase-${i + 1}.wav`)), // prettier-ignore
);
const silence = (ms: number) => Buffer.alloc(ms * BYTES_PER_MS);

async function login(): Promise<string> {
  const response = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: values.email, password }),
  });
  if (!response.ok)
    throw new Error(`inicio de sesión: HTTP ${response.status}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function ticket(token: string): Promise<string> {
  const response = await fetch(`${api}/api/v1/encounters/${encounterId}/assistant/listening/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }); // prettier-ignore
  if (!response.ok) throw new Error(`vale: HTTP ${response.status} ${await response.text()}`); // prettier-ignore
  return ((await response.json()) as { ticket: string }).ticket;
}

interface Channel {
  socket: WebSocket;
  next(type: string): Promise<Record<string, unknown>>;
}

async function open(token: string): Promise<Channel> {
  const socket = new WebSocket(`${api.replace(/^http/, 'ws')}/api/v1/assistant/listening`); // prettier-ignore
  const inbox: Record<string, unknown>[] = [];
  const waiting = new Map<string, (m: Record<string, unknown>) => void>();
  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const type = String(message.type);
    if (type === 'error') console.error('  error del canal:', message.code, message.reason ?? ''); // prettier-ignore
    const resolveIt = waiting.get(type);
    if (resolveIt) {
      waiting.delete(type);
      resolveIt(message);
    } else inbox.push(message);
  });
  await new Promise((ok, fail) => {
    socket.once('open', ok);
    socket.once('error', fail);
  });
  const next = (type: string) =>
    new Promise<Record<string, unknown>>((ok) => {
      const index = inbox.findIndex((m) => m.type === type);
      if (index >= 0) ok(inbox.splice(index, 1)[0]!);
      else waiting.set(type, ok);
    });
  socket.send(JSON.stringify({ type: 'hello', ticket: await ticket(token) }));
  await next('ready');
  socket.send(JSON.stringify({ type: 'start', device: 'medición' }));
  return { socket, next };
}

/** Streams `pcm` from `fromMs` at the speed of speech; answers where it ended. */
async function stream(
  channel: Channel,
  pcm: Buffer,
  fromMs: number,
): Promise<number> {
  const frameBytes = FRAME_MS * BYTES_PER_MS;
  let at = fromMs;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const chunk = pcm.subarray(offset, offset + frameBytes);
    const frame = Buffer.alloc(4 + chunk.length);
    frame.writeUInt32LE(at, 0);
    chunk.copy(frame, 4);
    channel.socket.send(frame);
    at += Math.round(chunk.length / BYTES_PER_MS);
    await new Promise((ok) => setTimeout(ok, FRAME_MS));
  }
  return at;
}

const started = Date.now();
const token = await login();
const starts: number[] = [];
let clock: number;

const first = await open(token);
clock = (await first.next('listening')).offsetMs as number;
for (const i of [0, 1]) {
  starts.push(clock);
  clock = await stream(first, Buffer.concat([sentences[i]!, silence(SILENCE_AFTER_MS)]), clock); // prettier-ignore
}
starts.push(clock);
clock = await stream(first, sentences[2]!, clock);
let waited = Date.now();
first.socket.send(JSON.stringify({ type: 'pause' }));
const paused = await first.next('paused');
const pauseWaitMs = Date.now() - waited;
first.socket.send(JSON.stringify({ type: 'start', device: 'medición' }));
clock = (await first.next('listening')).offsetMs as number;
starts.push(clock);
const beforeCut = Buffer.concat([silence(400), sentences[3]!]);
clock = await stream(first, beforeCut, clock);
// The cut: the fourth sentence is inside the recogniser, nobody said stop.
first.socket.terminate();

const second = await open(token);
const resumedAt = (await second.next('listening')).offsetMs as number;
// The page resends its last second, which the server already has.
const resend = beforeCut.subarray(Math.max(0, beforeCut.length - 1_000 * BYTES_PER_MS)); // prettier-ignore
await stream(second, resend, clock - Math.round(resend.length / BYTES_PER_MS));
clock = Math.max(clock, resumedAt);
for (const i of [4, 5]) {
  starts.push(clock);
  const tail = i === 4 ? Buffer.concat([sentences[i]!, silence(SILENCE_AFTER_MS)]) : sentences[i]!; // prettier-ignore
  clock = await stream(second, tail, clock);
}
waited = Date.now();
second.socket.send(JSON.stringify({ type: 'stop' }));
const stopped = await second.next('stopped');
const stopWaitMs = Date.now() - waited;
second.socket.close();

const response = await fetch(`${api}/api/v1/encounters/${encounterId}/assistant/listening`, { headers: { authorization: `Bearer ${token}` } }); // prettier-ignore
const { session, segments } = (await response.json()) as {
  session: { state: string; offsetMs: number };
  segments: { startMs: number; endMs: number; text: string }[];
};

const whole = fold(segments.map((s) => s.text).join(' '));
const times = WORDS.map((word) => whole.split(word).length - 1);
const sameStart =
  segments.length - new Set(segments.map((s) => s.startMs)).size;
const inOrder = segments.every((s, i) => i === 0 || s.startMs >= segments[i - 1]!.endMs); // prettier-ignore
const order = WORDS.map((word) => whole.indexOf(word)).filter((at) => at >= 0);

console.log(`E-031 en clinica (C1) — ${new Date().toISOString()}`);
console.log(`Frases dichas: ${WORDS.length} · audio ${clock} ms · ${Math.round((Date.now() - started) / 1000)} s de reloj`); // prettier-ignore
console.log(
  `Inicio de cada frase en el reloj de la sesión: ${starts.join(' · ')}`,
);
console.log(`Pausa respondida con el reloj ${String(paused.offsetMs)} en ${pauseWaitMs} ms`); // prettier-ignore
console.log(`Corte con la 4.ª frase dentro; reanudada en ${resumedAt} ms`);
console.log(`Detención respondida con el reloj ${String(stopped.offsetMs)} en ${stopWaitMs} ms`); // prettier-ignore
console.log(`Segmentos guardados: ${segments.length} · con el mismo inicio: ${sameStart} · sin solaparse y en orden: ${inOrder ? 'sí' : 'NO'}`); // prettier-ignore
for (const [i, word] of WORDS.entries()) {
  console.log(`  frase ${i + 1} («${word}»): ${times[i]} vez/veces`);
}
console.log(`Frases presentes una sola vez: ${times.filter((t) => t === 1).length}/6 · repetidas: ${times.filter((t) => t > 1).length} · no oídas: ${times.filter((t) => t === 0).length}`); // prettier-ignore
console.log(`Las presentes, en el orden en que se dijeron: ${order.every((at, i) => i === 0 || at > order[i - 1]!) ? 'sí' : 'NO'}`); // prettier-ignore
console.log(`Estado final: ${session.state}, reloj ${session.offsetMs} ms`);
console.log('Segmentos:');
for (const s of segments) console.log(`  [${s.startMs}–${s.endMs}] ${s.text}`);
