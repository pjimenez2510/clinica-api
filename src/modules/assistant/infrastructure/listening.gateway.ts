import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import { ASSISTANT_ENABLED } from '../assistant-diagnosis.controller';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import {
  ListeningAccess,
  type ListeningGrant,
} from '../application/listening-access';
import {
  ListeningService,
  PREPARATION_LISTENING,
  type ListeningChannel,
} from '../application/listening.service';
import {
  ListeningFailedError,
  ListeningNotOpenError,
  ListeningUnavailableError,
} from '../domain/assistant.errors';
import { MAX_FRAME_BYTES } from '../domain/listening';

/** Where the browser opens the channel: no credential in it (AS-046). */
export const LISTENING_PATH = '/api/v1/assistant/listening';
/** AS-046. How long the ticket may take to arrive. */
const HELLO_WAIT_MS = 5_000;
/** AS-046, AS-047. The channel is not, or no longer, of a valid session. */
export const SESSION_REFUSED = 4401;
/**
 * AS-047. A channel lives, at most, this long; then the browser asks for a
 * new ticket — the guards decide again — and resumes on the same clock. It
 * bounds what a revoked session or permission keeps, whatever the token's TTL.
 */
const LONGEST_CHANNEL_MS = 15 * 60_000;
/**
 * AS-059 (D-247 §7). How often a channel asks whether its attention still
 * takes content: signed with its discharge or annulled, the listening stops.
 */
/** AS-163, AS-166. Why a listening stops without keeping what is held. */
const DISCARD_HELD: ReadonlySet<string> = new Set([
  'ASSISTANT_RECORDING_NOT_AUTHORIZED',
  'ASSISTANT_ENCOUNTER_NOT_FOUND',
  // AS-244 (B3). The consultation began: what was held is the consultation's.
  'ASSISTANT_PREPARATION_OVER',
]);

const LIVE_CHECK_MS = 5_000;
/** Channels without a ticket yet, per address: what one client may hold open. */
const UNTICKETED_PER_ADDRESS = 20;
/** AS-059. The listening stopped because the attention was closed. */
export const ATTENTION_CLOSED = 4409;

export const LISTENING_GATEWAY_OPTIONS = Symbol('LISTENING_GATEWAY_OPTIONS');
export interface ListeningGatewayOptions {
  /** AS-046. `CORS_ORIGINS`: the browsers that may open the channel. */
  origins: readonly string[];
  helloWaitMs?: number;
  liveCheckMs?: number;
}

const helloSchema = z.object({ type: z.literal('hello'), ticket: z.string() });
const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    device: z.string().trim().min(1).max(80).catch('navegador'),
  }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('stop') }),
]);

interface Connection {
  socket: WebSocket;
  address: string;
  grant: ListeningGrant | null;
  channel: ListeningChannel;
  /** Messages are handled one after another: a stop never overtakes its start. */
  queue: Promise<void>;
  timers: NodeJS.Timeout[];
}

/**
 * AS-045 to AS-055. The channel the browser sends the consultation's audio
 * through, on the API's own HTTP server.
 *
 * The browser cannot put a header on a WebSocket, and SigmAI put the session
 * token in the URL, where any proxy logs it. Here the URL carries nothing: the
 * first message is a single-use ticket asked for over HTTP, where the guards
 * of every route decided (AS-045, AS-046). The channel lives as long as the
 * access token it was asked with (AS-047); the browser asks for another
 * ticket and resumes on the same clock.
 *
 * Messages in: `hello {ticket}`, then `start {device}`, `pause`, `stop`, and
 * binary frames of a 4-byte offset (little endian) and PCM16 at 16 kHz. Out:
 * `ready {offsetMs, state}`, `listening {offsetMs}`, `paused {offsetMs,
 * reason?}`, `stopped {offsetMs}`, `segment {startMs, endMs, text}`,
 * `taken-over`, and `error {code}`. Audio is binary and everything else short
 * JSON, which keeps the frames out of any text path that might log them; a
 * frame lives here for one function call (AS-053).
 */
@Injectable()
export class ListeningGateway
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ListeningGateway.name);
  private readonly connections = new Set<Connection>();
  private readonly unticketed = new Map<string, number>();
  private server: WebSocketServer | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly access: ListeningAccess,
    private readonly listening: ListeningService,
    /** AS-241. The preparation's, chosen by the scope of the ticket. */
    @Inject(PREPARATION_LISTENING)
    private readonly preparation: ListeningService,
    @Inject(LISTENING_GATEWAY_OPTIONS)
    private readonly options: ListeningGatewayOptions,
    /** AS-026, AS-046. The same switch as the routes. */
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const http = this.adapterHost.httpAdapter?.getHttpServer() as
      import('node:http').Server | undefined;
    if (!http) return;

    // AS-053. A frame larger than a second of audio closes with 1009 before
    // it is held in memory.
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: 4 + MAX_FRAME_BYTES,
    });
    http.on('upgrade', (request: IncomingMessage, socket: Duplex, head) =>
      this.upgrade(request, socket, head),
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.listening.shutdown(), this.preparation.shutdown()]);
    for (const connection of this.connections) connection.socket.close(1001);
    this.server?.close();
  }

  /**
   * With a listener on `upgrade`, Node no longer closes the upgrades nobody
   * takes, nor watches their socket for errors: this one answers every one.
   */
  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy());
    const path = new URL(request.url ?? '/', 'http://api').pathname;
    if (path !== LISTENING_PATH || !this.server) {
      return refuse(socket, 404, 'Not Found');
    }

    // AS-026, AS-046. Off: the answer of a route that does not exist.
    if (!this.enabled) return refuse(socket, 404, 'Not Found');
    // AS-046. A browser page of another origin never opens it. A client
    // without `Origin` is not a browser, and still needs a ticket.
    const origin = request.headers.origin;
    if (origin !== undefined && !this.options.origins.includes(origin)) {
      return refuse(socket, 403, 'Forbidden');
    }

    const address = request.socket.remoteAddress ?? 'unknown';
    if ((this.unticketed.get(address) ?? 0) >= UNTICKETED_PER_ADDRESS) {
      return refuse(socket, 429, 'Too Many Requests');
    }
    this.server.handleUpgrade(request, socket, head, (ws) =>
      this.connected(ws, address),
    );
  }

  private connected(socket: WebSocket, address: string): void {
    this.unticketed.set(address, (this.unticketed.get(address) ?? 0) + 1);
    const connection: Connection = {
      socket,
      address,
      grant: null,
      channel: {
        onSegment: (segment) => send(socket, { type: 'segment', ...segment }),
        onPaused: (reason, offsetMs) =>
          send(socket, { type: 'paused', offsetMs, reason }),
        onTakenOver: () => send(socket, { type: 'taken-over' }),
      },
      queue: Promise.resolve(),
      timers: [],
    };
    this.connections.add(connection);

    // AS-046. No ticket in time: nothing was attended to.
    connection.timers.push(
      setTimeout(() => {
        if (!connection.grant) socket.close(SESSION_REFUSED, 'sin vale');
      }, this.options.helloWaitMs ?? HELLO_WAIT_MS),
    );

    // Every message is handled, and its failure answered, in its turn: a
    // rejection left on the queue would skip the rest — the pause on close
    // among them — and, unhandled, end the process.
    socket.on('message', (data: Buffer, binary: boolean) => {
      connection.queue = connection.queue
        .then(() => this.onMessage(connection, data, binary))
        .catch((error: unknown) => this.answerError(connection, error));
    });
    socket.on('close', () => {
      for (const timer of connection.timers) clearInterval(timer);
      this.connections.delete(connection);
      if (!connection.grant) {
        this.forgetUnticketed(connection);
        return;
      }
      // AS-051. A channel that goes away without pausing pauses its listening,
      // after the recogniser handed over what it held.
      const service = this.serviceOf(connection.grant);
      connection.queue = connection.queue.then(() =>
        service.disconnected(connection.channel).catch(() => {
          this.logger.warn(
            { error_code: 'listening-disconnect' },
            'a listening could not be paused after its channel went away',
          );
        }),
      );
    });
    socket.on('error', () => undefined);
  }

  private async onMessage(
    connection: Connection,
    data: Buffer,
    binary: boolean,
  ): Promise<void> {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (!connection.grant) return this.hello(connection, data, binary);

    const { encounterId } = connection.grant;
    if (!binary) {
      return this.command(connection, connection.grant, data.toString('utf8'));
    }
    if (data.length <= 4) return;
    try {
      await this.serviceOf(connection.grant).receive(
        encounterId,
        connection.channel,
        {
          offsetMs: data.readUInt32LE(0),
          pcm: data.subarray(4),
        },
      );
    } catch (error) {
      // AS-054, AS-055. A frame is never answered on its own: one of a
      // channel that lost the capture is dropped, and a listening that cannot
      // go on pauses itself and says so once.
      if (!(error instanceof ListeningNotOpenError)) {
        this.logger.warn(
          { error_code: errorName(error), dependency: 'listening' },
          'a frame of the listening could not be handled',
        );
      }
    }
  }

  /** AS-046. The first message is the ticket, or the channel closes. */
  private async hello(connection: Connection, data: Buffer, binary: boolean) {
    const hello = binary ? null : helloSchema.safeParse(parse(data));
    const grant = hello?.success ? this.access.redeem(hello.data.ticket) : null;
    if (!grant) {
      connection.socket.close(SESSION_REFUSED, 'vale no válido');
      return;
    }
    connection.grant = grant;
    this.forgetUnticketed(connection);

    // AS-047. The channel lives as long as the token the ticket was asked
    // with, and never longer than LONGEST_CHANNEL_MS.
    const left = grant.tokenExpiresAt.getTime() - Date.now();
    connection.timers.push(
      setTimeout(
        () => connection.socket.close(SESSION_REFUSED, 'sesión vencida'),
        Math.min(Math.max(left, 0), LONGEST_CHANNEL_MS),
      ),
      setInterval(() => {
        connection.queue = connection.queue
          .then(() => this.checkAttention(connection, grant))
          .catch(() => undefined);
      }, this.options.liveCheckMs ?? LIVE_CHECK_MS),
    );

    const session = await this.serviceOf(grant).sessionOf(grant.encounterId);
    send(connection.socket, {
      type: 'ready',
      offsetMs: session?.offsetMs ?? 0,
      state: session?.state ?? null,
    });
  }

  private async command(
    connection: Connection,
    grant: ListeningGrant,
    raw: string,
  ): Promise<void> {
    const command = commandSchema.safeParse(parse(raw));
    if (!command.success) return;
    const { encounterId } = grant;
    const { channel } = connection;
    const listening = this.serviceOf(grant);

    switch (command.data.type) {
      case 'start': {
        // AS-045. Asked again: the attention may have been signed since.
        await this.access.confirm(grant);
        const { offsetMs } = await listening.start(
          encounterId,
          grant.userId,
          command.data.device,
          channel,
        );
        send(connection.socket, { type: 'listening', offsetMs });
        return;
      }
      case 'pause': {
        const { offsetMs } = await listening.pause(encounterId, channel);
        send(connection.socket, { type: 'paused', offsetMs });
        return;
      }
      case 'stop': {
        const { offsetMs } = await listening.stop(encounterId, channel);
        send(connection.socket, { type: 'stopped', offsetMs });
        return;
      }
    }
  }

  /**
   * AS-059 (D-247 §7). The attention was signed with its discharge, annulled
   * or interrupted, or left the requester's reach: the listening stops
   * —whatever channel holds it— and this channel is told and closed. A
   * failure to ask (the database) is not a closed attention: next round.
   */
  private async checkAttention(
    connection: Connection,
    grant: ListeningGrant,
  ): Promise<void> {
    try {
      await this.access.confirm(grant);
      return;
    } catch (error) {
      if (!(error instanceof DomainError)) return;
      // AS-163, AS-166. Revoked, or the site switched off: what the
      // recogniser holds was heard after that, and is dropped.
      const discardHeld = DISCARD_HELD.has(error.code);
      const { offsetMs } = await this.serviceOf(grant).close(
        grant.encounterId,
        {
          discardHeld,
        },
      );
      send(connection.socket, {
        type: 'stopped',
        offsetMs,
        reason: error.code,
      });
      connection.socket.close(ATTENTION_CLOSED, 'atención cerrada');
    }
  }

  /** AS-241. The listening a ticket opened: the consultation's or the preparation's. */
  private serviceOf(grant: ListeningGrant): ListeningService {
    return grant.scope === 'PREPARATION' ? this.preparation : this.listening;
  }

  private forgetUnticketed(connection: Connection): void {
    const left = (this.unticketed.get(connection.address) ?? 1) - 1;
    if (left > 0) this.unticketed.set(connection.address, left);
    else this.unticketed.delete(connection.address);
  }

  /** AS-058. The screen gets a code to word; the log a code, never a sentence. */
  private answerError(connection: Connection, error: unknown): void {
    const known = error instanceof DomainError ? error : new ListeningFailedError(); // prettier-ignore
    if (!(error instanceof DomainError)) {
      this.logger.warn(
        { error_code: errorName(error), dependency: 'listening' },
        'a listening command failed',
      );
    }
    // A ticket accepted with a channel that could not even say `ready`.
    if (!connection.grant) {
      connection.socket.close(1011, 'no disponible');
      return;
    }
    const code = known.code;
    send(connection.socket, {
      type: 'error',
      code,
      reason:
        error instanceof ListeningUnavailableError ? error.reason : undefined,
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function parse(raw: Buffer | string): unknown {
  try {
    return JSON.parse(raw.toString()) as unknown;
  } catch {
    return null;
  }
}

/** Answers the upgrade with a plain HTTP status and closes it. */
function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}
