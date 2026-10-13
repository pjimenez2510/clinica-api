import { describe, expect, it, vi } from 'vitest';

import {
  DictationNotHeardError,
  DictationUnavailableError,
} from '../domain/assistant.errors';

import {
  ClinicaAiDictationTranscriber,
  dictationTranscriberFor,
} from './clinica-ai.dictation-transcriber';

const URL_ = 'http://127.0.0.1:8100';
const SECRET = 's'.repeat(64);
const RECORDING = Buffer.from('RIFF....WAVEfmt ');
const SAID = 'Presión 120 sobre 80, pulso 72';

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
  return new ClinicaAiDictationTranscriber(URL_, SECRET, timeoutMs, fetcher);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('AS-180 AS-184 AS-186 ClinicaAiDictationTranscriber', () => {
  it('AS-180 sends the recording as it came, with the shared secret and no redirect, and returns what was heard', async () => {
    const fetcher = answering(200, { text: `  ${SAID} `, seconds: 6.4 });

    await expect(adapter(fetcher).transcribe(RECORDING)).resolves.toEqual({
      text: SAID,
      seconds: 6.4,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${URL_}/v1/speech/transcription`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/octet-stream',
    });
    expect(Buffer.from(init?.body as Uint8Array).equals(RECORDING)).toBe(true);
    // The same memory, not a copy.
    expect((init?.body as Uint8Array).buffer).toBe(RECORDING.buffer);
  });

  it('AS-186 an empty recording is not heard, and clinica-ai is not asked', async () => {
    const fetcher = answering(200, { text: SAID, seconds: 1 });

    const error = await failure(adapter(fetcher).transcribe(Buffer.alloc(0)));

    expect(error).toBeInstanceOf(DictationNotHeardError);
    expect((error as DictationNotHeardError).heard).toEqual({ kind: 'empty' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AS-186 a recording clinica-ai could not decode (422) is not heard', async () => {
    const error = await failure(
      adapter(answering(422, { detail: 'No se pudo leer' })).transcribe(
        RECORDING,
      ),
    );

    expect((error as DictationNotHeardError).heard).toEqual({
      kind: 'unreadable',
    });
  });

  it('AS-186 no recogniser installed (503) is unavailable, not retried as heard', async () => {
    const error = await failure(
      adapter(answering(503, { detail: 'no instalado' })).transcribe(RECORDING),
    );

    expect(error).toBeInstanceOf(DictationUnavailableError);
    expect((error as DictationUnavailableError).reason).toBe('no-recognizer');
  });

  it.each([
    ['a refused secret', () => answering(401, { detail: 'x' })],
    ['a redirect', () => answering(307, '')],
    ['an answer out of contract', () => answering(200, { words: SAID })],
    ['an answer that is not JSON', () => answering(200, '<html>')],
    [
      'a dropped connection',
      () => vi.fn<typeof fetch>(() => Promise.reject(new TypeError(SAID))),
    ],
  ])(
    'AS-186 %s is unavailable, and says nothing of the recording',
    async (_case, make) => {
      const error = await failure(adapter(make()).transcribe(RECORDING));

      expect(error).toBeInstanceOf(DictationUnavailableError);
      expect((error as DictationUnavailableError).reason).toBe('unreachable');
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('120');
    },
  );

  it('AS-186 gives up after its time limit', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    const error = await failure(adapter(hanging, 20).transcribe(RECORDING));

    expect((error as DictationUnavailableError).reason).toBe('unreachable');
  });

  it('AS-186 without a shared secret there is no transcriber: not installed, and nothing is sent', async () => {
    const fetcher = answering(200, { text: SAID, seconds: 1 });
    const transcriber = dictationTranscriberFor(
      { url: URL_, secret: undefined, timeoutMs: 1000 },
      fetcher,
    );

    const error = await failure(transcriber.transcribe(RECORDING));

    expect((error as DictationUnavailableError).reason).toBe('no-recognizer');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AS-184 the adapter does not print its secret when inspected', () => {
    expect(JSON.stringify(adapter(answering(200, {})))).not.toContain(SECRET);
  });
});
