import { z } from 'zod';

import type {
  AttributionStatus,
  Voiceprint,
  VoiceprintEnroller,
} from '../application/voiceprint.port';
import {
  VoiceNotHeardError,
  VoiceUnavailableError,
} from '../domain/assistant.errors';

/** CAI-016. What `clinica-ai` answers (`contracts/openapi.json`, `Voiceprint`). */
const voiceprintSchema = z
  .object({
    model: z.string().min(1).max(120),
    dimension: z.number().int().min(1).max(4096),
    phrases: z.number().int().min(1),
    seconds: z.number().positive(),
    vector: z.array(z.number().finite()),
  })
  .refine((answer) => answer.vector.length === answer.dimension);

/** CAI-020. `GET /v1/status`, the part about telling voices apart. */
const statusSchema = z.object({
  speech: z.object({
    speakerAttribution: z.object({
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  }),
});

/** FastAPI's refusal: `{"detail": "…"}`, a sentence of `clinica-ai`'s own. */
const refusalSchema = z.object({ detail: z.string().max(400) });

const UNREACHABLE = 'el servicio de voz no responde';
const NOT_CONFIGURED = 'el servicio de voz no está configurado';

export interface ClinicaAiVoiceprintOptions {
  baseUrl: string;
  secret: string;
  /** The reading is up to two minutes: whisper and the voice model over it. */
  timeoutMs: number;
  statusTimeoutMs: number;
  fetcher?: typeof fetch;
}

/**
 * AS-310, AS-311, AS-313 (E17). The voiceprint, made by `clinica-ai` on this
 * machine (`POST /v1/speech/voiceprint`) with the secret both sides share.
 *
 * The recording goes in the body and is not kept, logged or put in an error
 * here (AS-310); what comes back is a vector, which only the store sees.
 */
export class ClinicaAiVoiceprintEnroller implements VoiceprintEnroller {
  /** ECMAScript-private: an `inspect` of the adapter does not print it. */
  readonly #secret: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ClinicaAiVoiceprintOptions) {
    this.#secret = options.secret;
    this.fetcher = options.fetcher ?? fetch;
  }

  async enrol(recording: Buffer, signal?: AbortSignal): Promise<Voiceprint> {
    if (recording.length === 0) throw new VoiceNotHeardError();

    const deadline = AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await this.fetcher(this.url('v1/speech/voiceprint'), {
        method: 'POST',
        // A redirect would carry the recording wherever it points.
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.#secret}`,
          'content-type': 'application/octet-stream',
        },
        // A view over the same bytes: the recording is not copied again.
        body: new Uint8Array(
          recording.buffer as ArrayBuffer,
          recording.byteOffset,
          recording.byteLength,
        ),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      body = await response.text();
    } catch {
      // The thrown error is not kept: it may quote the request.
      throw new VoiceUnavailableError(UNREACHABLE);
    }

    // 422: too little voice, or a recording it could not read; 413: too long.
    if (response.status === 422 || response.status === 413) {
      throw new VoiceNotHeardError();
    }
    if (response.status === 503) {
      const refusal = refusalSchema.safeParse(parseJson(body));
      throw new VoiceUnavailableError(
        refusal.success ? refusal.data.detail : UNREACHABLE,
      );
    }
    if (!response.ok) throw new VoiceUnavailableError(UNREACHABLE);

    const answer = voiceprintSchema.safeParse(parseJson(body));
    if (!answer.success) throw new VoiceUnavailableError(UNREACHABLE);
    return answer.data;
  }

  async attributionStatus(): Promise<AttributionStatus> {
    try {
      const response = await this.fetcher(this.url('v1/status'), {
        redirect: 'manual',
        headers: { authorization: `Bearer ${this.#secret}` },
        signal: AbortSignal.timeout(this.options.statusTimeoutMs),
      });
      if (!response.ok) return { available: false, reason: UNREACHABLE };
      const status = statusSchema.safeParse(await response.json());
      if (!status.success) return { available: false, reason: UNREACHABLE };
      const { available, reason } = status.data.speech.speakerAttribution;
      return { available, reason: available ? null : reason };
    } catch {
      return { available: false, reason: UNREACHABLE };
    }
  }

  private url(path: string): string {
    const base = this.options.baseUrl.endsWith('/')
      ? this.options.baseUrl
      : `${this.options.baseUrl}/`;
    return new URL(path, base).toString();
  }
}

/** Without the shared secret nothing is sent: it fails closed. */
export class MissingVoiceprintEnroller implements VoiceprintEnroller {
  enrol(): Promise<Voiceprint> {
    return Promise.reject(new VoiceUnavailableError(NOT_CONFIGURED));
  }

  attributionStatus(): Promise<AttributionStatus> {
    return Promise.resolve({ available: false, reason: NOT_CONFIGURED });
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
