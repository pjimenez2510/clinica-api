import { describe, expect, it, vi } from 'vitest';

import { ExternalServiceError } from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import type { PseudonymizedText } from '../application/llm-client.port';
import {
  MissingPseudonymizer,
  type PseudonymizeInput,
} from '../application/pseudonymizer.port';
import {
  AssistantNotConfiguredError,
  PseudonymizerFailedError,
} from '../domain/assistant.errors';

import {
  ClinicaAiPseudonymizer,
  pseudonymizerFor,
} from './clinica-ai.pseudonymizer';

const URL_ = 'http://127.0.0.1:8100';
const SECRET = 's'.repeat(64);
const NOTE =
  'Mariela Guanoluisa, cédula 1714567893, refiere cefalea desde el 12/03/2026';
const INPUT: PseudonymizeInput = {
  text: NOTE,
  subject: 'chart-1',
  names: ['Mariela Guanoluisa'],
};
const ANSWER = {
  text: '[NOMBRE_1] [NOMBRE_2], cédula [ID_1], refiere cefalea desde el 02/05/2026',
  replacements: [
    { placeholder: '[NOMBRE_1]', original: 'Mariela', kind: 'nombre' },
    { placeholder: '[NOMBRE_2]', original: 'Guanoluisa', kind: 'nombre' },
    { placeholder: '[ID_1]', original: '1714567893', kind: 'id' },
  ],
  date_shift_days: 51,
  counts: { nombre: 2, id: 1 },
};

function answering(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function adapter(fetcher: typeof fetch, timeoutMs = 1000) {
  return new ClinicaAiPseudonymizer(URL_, SECRET, timeoutMs, fetcher);
}

/** Everything a failure exposes: message, serialisation and inspect. */
function exposed(error: unknown): string {
  return [
    String(error),
    (error as Error).message,
    JSON.stringify(error),
    JSON.stringify((error as { details?: unknown }).details ?? null),
  ].join('\n');
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('ClinicaAiPseudonymizer', () => {
  it('AS-030 posts the text with the shared secret and returns it cleared, with its map', async () => {
    const fetcher = answering(200, ANSWER);

    const result = await adapter(fetcher).pseudonymize(INPUT);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(`${URL_}/v1/privacy/pseudonymize`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${SECRET}`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      text: NOTE,
      subject: 'chart-1',
      names: ['Mariela Guanoluisa'],
      places: [],
      staff: [],
    });
    const cleared: PseudonymizedText = result.cleared;
    expect(cleared).toBe(ANSWER.text);
    expect(result.replacements).toEqual(ANSWER.replacements);
    expect(result.dateShiftDays).toBe(51);
  });

  it('AS-030 AS-033 refuses an answer outside the contract and hands back nothing', async () => {
    for (const body of [
      { ...ANSWER, text: 42 },
      { ...ANSWER, replacements: [{ placeholder: '[NOMBRE_1]' }] },
      { ...ANSWER, date_shift_days: 1.5 },
      'no es json',
    ]) {
      const error = await failure(
        adapter(answering(200, body)).pseudonymize(INPUT),
      );

      expect(error).toBeInstanceOf(PseudonymizerFailedError);
      expect((error as PseudonymizerFailedError).outcome).toBe(
        'invalid-answer',
      );
      expect((error as PseudonymizerFailedError).isRetryable).toBe(false);
    }
  });

  it('AS-033 a service that is down, slow or failing is retryable; one that refuses is not', async () => {
    const down = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          );
        }),
    );
    const cases: [typeof fetch, string, boolean][] = [
      [down, 'unavailable', true],
      [slow, 'unavailable', true],
      [answering(503, {}), 'unavailable', true],
      [answering(401, ''), 'refused', false],
      [answering(422, { detail: [] }), 'refused', false],
    ];

    for (const [fetcher, outcome, retryable] of cases) {
      const error = await failure(adapter(fetcher, 20).pseudonymize(INPUT));

      expect(error).toBeInstanceOf(PseudonymizerFailedError);
      expect((error as PseudonymizerFailedError).outcome).toBe(outcome);
      expect((error as PseudonymizerFailedError).isRetryable).toBe(retryable);
    }
  });

  it('AS-033 stops when the caller cancels, and says it was the caller', async () => {
    const controller = new AbortController();
    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          );
        }),
    );

    const pending = failure(
      adapter(slow, 60_000).pseudonymize(INPUT, controller.signal),
    );
    controller.abort();
    const error = await pending;

    expect((error as PseudonymizerFailedError).outcome).toBe('cancelled');
    expect((error as PseudonymizerFailedError).isRetryable).toBe(false);
  });

  it('AS-034 a failure carries no word of the note, of the names, of the map or of the body', async () => {
    const quoting = {
      detail: `no se pudo con ${NOTE}`,
      map: ANSWER.replacements,
    };
    const bodies: (typeof fetch)[] = [
      answering(500, quoting),
      answering(200, {
        ...ANSWER,
        date_shift_days: 'x',
      }),
      vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError(`fetch failed for ${NOTE}`)),
      ),
    ];

    for (const fetcher of bodies) {
      const text = exposed(await failure(adapter(fetcher).pseudonymize(INPUT)));

      for (const secret of [
        'Mariela',
        'Guanoluisa',
        '1714567893',
        'cefalea',
        SECRET,
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('AS-033 answers ASSISTANT_PSEUDONYMIZER_FAILED as an external failure the user can act on', () => {
    const error = new PseudonymizerFailedError('unavailable', 503);

    expect(error.code).toBe('ASSISTANT_PSEUDONYMIZER_FAILED');
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.isRetryable).toBe(true);
    expect(error.userTitle).toMatch(/asistente/i);
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
    expect(new PseudonymizerFailedError('invalid-answer').isRetryable).toBe(
      false,
    );
  });
});

describe('ClinicaAiPseudonymizer, after the review', () => {
  it('AS-033 never follows a redirect: the note would go on to wherever it points', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(
        new Response(null, {
          status: 307,
          headers: {
            location: 'http://elsewhere.example/v1/privacy/pseudonymize',
          },
        }),
      );
    });

    const error = await failure(adapter(fetcher).pseudonymize(INPUT));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((error as PseudonymizerFailedError).outcome).toBe('refused');
  });

  it('AS-030 refuses an answer that still carries a name the request asked to take out', async () => {
    for (const text of [
      'Mariela [NOMBRE_2], cédula [ID_1]',
      '[NOMBRE_1] GUANOLUISA, cédula [ID_1]',
      '[NOMBRE_1] Guanoluisá refiere',
    ]) {
      const error = await failure(
        adapter(answering(200, { ...ANSWER, text })).pseudonymize(INPUT),
      );

      expect((error as PseudonymizerFailedError).outcome).toBe(
        'invalid-answer',
      );
    }
  });

  it('AS-030 keeps the path of a service published under one', async () => {
    const fetcher = answering(200, ANSWER);

    await new ClinicaAiPseudonymizer(
      'https://127.0.0.1:8443/ia/',
      SECRET,
      1000,
      fetcher,
    ).pseudonymize(INPUT);

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://127.0.0.1:8443/ia/v1/privacy/pseudonymize',
    );
  });
});

describe('ClinicaAiPseudonymizer, second review', () => {
  it('AS-030 does not refuse a month the date shift wrote, nor a connector of a name', async () => {
    const cases: [string[], string][] = [
      [
        ['Julio Quishpe'],
        '[NOMBRE_1] [NOMBRE_2] control el 17 de julio de 2025',
      ],
      [['Ana dos Santos'], '[NOMBRE_1] dos [NOMBRE_2] toma dos tabletas'],
      [['Mayo Van Berg'], '[NOMBRE_1] van [NOMBRE_2] desde mayo de 2026'],
    ];

    for (const [names, text] of cases) {
      const result = await adapter(
        answering(200, { ...ANSWER, text }),
      ).pseudonymize({
        ...INPUT,
        names,
      });

      expect(result.cleared).toBe(text);
    }
  });

  it('AS-030 sees each half of a hyphenated surname', async () => {
    const error = await failure(
      adapter(
        answering(200, { ...ANSWER, text: 'Paciente Toapanta refiere' }),
      ).pseudonymize({ ...INPUT, names: ['Pérez-Toapanta'] }),
    );

    expect((error as PseudonymizerFailedError).outcome).toBe('invalid-answer');
  });
});

describe('ClinicaAiPseudonymizer, third review', () => {
  it('AS-030 refuses a patient called Julio left as a person, and forgives only the month of a date', async () => {
    for (const text of [
      'Paciente Julio [NOMBRE_1] acude',
      'Paciente Ju\u034Flio [NOMBRE_1] acude',
      'Paciente Ju\u200Blio [NOMBRE_1] acude',
    ]) {
      const error = await failure(
        adapter(answering(200, { ...ANSWER, text })).pseudonymize({
          ...INPUT,
          names: ['Julio Quishpe'],
        }),
      );

      expect((error as PseudonymizerFailedError).outcome).toBe(
        'invalid-answer',
      );
    }

    const dated =
      '[NOMBRE_1] [NOMBRE_2] control el 17 de julio de 2025 y en julio de 2026';
    const result = await adapter(
      answering(200, { ...ANSWER, text: dated }),
    ).pseudonymize({
      ...INPUT,
      names: ['Julio Quishpe'],
    });
    expect(result.cleared).toBe(dated);
  });
});

describe('pseudonymizerFor', () => {
  it('AS-031 without a secret it is the missing one, which refuses before any request', async () => {
    const fetcher = vi.fn();

    const chosen = pseudonymizerFor(
      { url: URL_, secret: undefined, timeoutMs: 1000 },
      fetcher,
    );

    expect(chosen).toBeInstanceOf(MissingPseudonymizer);
    await expect(chosen.pseudonymize(INPUT)).rejects.toBeInstanceOf(
      AssistantNotConfiguredError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AS-031 with a secret it is the HTTP adapter', () => {
    expect(
      pseudonymizerFor({ url: URL_, secret: SECRET, timeoutMs: 1000 }),
    ).toBeInstanceOf(ClinicaAiPseudonymizer);
  });
});
