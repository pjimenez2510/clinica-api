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
        new URL(
          'v1/privacy/pseudonymize',
          withTrailingSlash(this.baseUrl),
        ).toString(),
        {
          method: 'POST',
          // A redirect would send the note on to wherever it points; a 3xx is a refusal.
          redirect: 'manual',
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

    // Defence in depth: whatever answers on the port, a name the caller asked
    // to take out must not be in what comes back.
    if (carriesAName(answer.data.text, input)) {
      throw new PseudonymizerFailedError('invalid-answer', response.status);
    }

    return {
      cleared: answer.data.text as PseudonymizedText,
      replacements: answer.data.replacements,
      dateShiftDays: answer.data.date_shift_days,
    };
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Words that join a name and name nobody: «María de los Ángeles», «Ana dos
 * Santos». The same list as `CONNECTORS` in clinica-ai (`privacy/rules.py`):
 * the service leaves these, so finding one is no sign of a leak.
 */
const CONNECTORS = new Set([
  'de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'dos', 'van', 'von',
]); // prettier-ignore
/**
 * The date shift writes month names that were not in the note: a patient
 * called Julio would otherwise have every shifted date refused (second
 * review). Forgiven only inside a date: a «Julio» standing alone is the
 * patient (third review).
 */
const MONTH = String.raw`(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)`;
const DATE_IN_WORDS = new RegExp(
  String.raw`\b(?:\d{1,2}\s+de\s+${MONTH}(?:\s+del?\s+\d{4})?|${MONTH}\s+del?\s+\d{4})\b`,
  'gu',
);

/**
 * Format characters and marks out first, as clinica-ai does: a word split by
 * one of them is still the word (third review).
 */
function fold(value: string): string {
  return value
    .replace(/[\p{Cf}\u180E]|\u034F|[\uFE00-\uFE0F]/gu, '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();
}

/**
 * AS-030. Every word of three letters or more of the names in the request,
 * the same words `clinica-ai` takes out, looked up as whole words in the
 * answer, without case or accents, once the dates are set aside.
 */
function carriesAName(cleared: string, input: PseudonymizeInput): boolean {
  const withoutDates = fold(cleared).replace(DATE_IN_WORDS, ' ');
  const answer = ` ${withoutDates.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return (input.names ?? [])
    .flatMap((name) => fold(name).split(/[^\p{L}\p{N}]+/u))
    .filter((word) => word.length >= 3 && !CONNECTORS.has(word))
    .some((word) => answer.includes(` ${word} `));
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
