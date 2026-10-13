import { z } from 'zod';

import type {
  DictationHeard,
  DictationTranscriber,
} from '../application/dictation-transcriber.port';
import {
  DictationNotHeardError,
  DictationUnavailableError,
} from '../domain/assistant.errors';

/** AS-180. What `clinica-ai` answers (`contracts/openapi.json`, `Transcription`). */
const answerSchema = z.object({
  text: z.string(),
  seconds: z.number().nonnegative(),
});

/**
 * AS-180, AS-184, AS-186. The short dictation, transcribed by `clinica-ai`
 * on this machine (`POST /v1/speech/transcription`) with the secret both
 * sides share.
 *
 * The recording goes in the body as it came from the screen and is not kept
 * here; nothing of it, nor of the text that comes back, is logged or put in
 * an error: a failure says only how it ended.
 */
export class ClinicaAiDictationTranscriber implements DictationTranscriber {
  /** ECMAScript-private: an `inspect` of the adapter does not print it. */
  readonly #secret: string;

  constructor(
    private readonly baseUrl: string,
    secret: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#secret = secret;
  }

  async transcribe(
    recording: Buffer,
    signal?: AbortSignal,
  ): Promise<DictationHeard> {
    if (recording.length === 0) {
      throw new DictationNotHeardError({ kind: 'empty' });
    }

    const deadline = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await this.fetcher(
        new URL(
          'v1/speech/transcription',
          withTrailingSlash(this.baseUrl),
        ).toString(),
        {
          method: 'POST',
          // A redirect would carry the recording wherever it points.
          redirect: 'manual',
          headers: {
            authorization: `Bearer ${this.#secret}`,
            'content-type': 'application/octet-stream',
          },
          body: new Uint8Array(recording),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        },
      );
      body = await response.text();
    } catch {
      // The thrown error is not kept: it may quote the request.
      throw new DictationUnavailableError('unreachable');
    }

    // clinica-ai: 422 is a recording it could not decode; 503 is no recogniser.
    if (response.status === 422) {
      throw new DictationNotHeardError({ kind: 'unreadable' });
    }
    if (response.status === 503) {
      throw new DictationUnavailableError('no-recognizer');
    }
    if (!response.ok) throw new DictationUnavailableError('unreachable');

    const answer = answerSchema.safeParse(parseJson(body));
    if (!answer.success) throw new DictationUnavailableError('unreachable');

    return { text: answer.data.text.trim(), seconds: answer.data.seconds };
  }
}

/** AS-186. Without the shared secret nothing is sent: it fails closed. */
class MissingDictationTranscriber implements DictationTranscriber {
  transcribe(): Promise<DictationHeard> {
    return Promise.reject(new DictationUnavailableError('unreachable'));
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function dictationTranscriberFor(
  config: { url: string; secret: string | undefined; timeoutMs: number },
  fetcher: typeof fetch = fetch,
): DictationTranscriber {
  return config.secret === undefined
    ? new MissingDictationTranscriber()
    : new ClinicaAiDictationTranscriber(
        config.url,
        config.secret,
        config.timeoutMs,
        fetcher,
      );
}
