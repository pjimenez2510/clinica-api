import { z } from 'zod';

import type { PseudonymizedText } from '../application/llm-client.port';
import {
  MissingPseudonymizer,
  type Pseudonymized,
  type PseudonymizeInput,
  type Pseudonymizer,
} from '../application/pseudonymizer.port';
import { PseudonymizerFailedError } from '../domain/assistant.errors';

/** AS-030. What `clinica-ai` answers (`contracts/openapi.json` there). */
const answerSchema = z.object({
  text: z.string(),
  replacements: z.array(
    z.object({
      placeholder: z.string().min(1),
      original: z.string(),
      kind: z.string().min(1),
    }),
  ),
  date_shift_days: z.number().int(),
});

/**
 * AS-030 to AS-034. The pseudonymizer that runs on the clinic's machine,
 * `clinica-ai`, over HTTP with the secret both sides share.
 *
 * Together with `withContext`, the only place that turns text into
 * `PseudonymizedText`: and only text that came back from the service in the
 * shape of its contract. Nothing here logs: the request is a note before it is
 * cleared, the answer holds the map from each placeholder to a real name, and
 * a failure says only how it ended (AS-034).
 */
export class ClinicaAiPseudonymizer implements Pseudonymizer {
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

  async pseudonymize(
    input: PseudonymizeInput,
    signal?: AbortSignal,
  ): Promise<Pseudonymized> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await this.fetcher(
        new URL('/v1/privacy/pseudonymize', this.baseUrl).toString(),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text: input.text,
            subject: input.subject,
            names: input.names ?? [],
            places: input.places ?? [],
            staff: input.staff ?? [],
          }),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        },
      );
      body = await response.text();
    } catch {
      // The thrown error is not kept: a network error may quote the request.
      throw new PseudonymizerFailedError(
        signal?.aborted ? 'cancelled' : 'unavailable',
      );
    }

    if (!response.ok) {
      throw new PseudonymizerFailedError(
        response.status >= 500 ? 'unavailable' : 'refused',
        response.status,
      );
    }

    const answer = answerSchema.safeParse(parseJson(body));
    if (!answer.success) {
      throw new PseudonymizerFailedError('invalid-answer', response.status);
    }

    return {
      cleared: answer.data.text as PseudonymizedText,
      replacements: answer.data.replacements,
      dateShiftDays: answer.data.date_shift_days,
    };
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** AS-031. Without a secret there is no pseudonymizer: the assistant fails closed. */
export function pseudonymizerFor(
  config: { url: string; secret: string | undefined; timeoutMs: number },
  fetcher: typeof fetch = fetch,
): Pseudonymizer {
  return config.secret === undefined
    ? new MissingPseudonymizer()
    : new ClinicaAiPseudonymizer(
        config.url,
        config.secret,
        config.timeoutMs,
        fetcher,
      );
}
