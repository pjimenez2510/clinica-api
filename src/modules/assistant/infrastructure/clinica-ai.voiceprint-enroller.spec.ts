import { describe, expect, it, vi } from 'vitest';

import {
  VoiceNotHeardError,
  VoiceUnavailableError,
} from '../domain/assistant.errors';

import {
  ClinicaAiVoiceprintEnroller,
  MissingVoiceprintEnroller,
} from './clinica-ai.voiceprint-enroller';

const SECRET = 'un-secreto-compartido-de-desarrollo-con-la-api';
const ANSWER = {
  model: 'speechbrain/spkrec-ecapa-voxceleb',
  dimension: 3,
  phrases: 12,
  seconds: 41.2,
  vector: [0.6, 0.8, 0],
};

function enroller(response: Response | Error) {
  const fetcher = vi.fn<typeof fetch>(() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response),
  );
  return {
    fetcher,
    enroller: new ClinicaAiVoiceprintEnroller({
      baseUrl: 'http://127.0.0.1:8100',
      secret: SECRET,
      timeoutMs: 1_000,
      statusTimeoutMs: 1_000,
      fetcher,
    }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('ClinicaAiVoiceprintEnroller (E17)', () => {
  it('AS-310 sends the recording with the secret in a header and answers the vector', async () => {
    const { enroller: adapter, fetcher } = enroller(json(ANSWER));

    expect(await adapter.enrol(Buffer.from('audio'))).toEqual(ANSWER);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://127.0.0.1:8100/v1/speech/voiceprint');
    expect(url).not.toContain(SECRET);
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`,
    );
  });

  it('AS-311 too little voice, or a recording it could not read, is ASSISTANT_VOICE_NOT_HEARD', async () => {
    for (const status of [422, 413]) {
      const { enroller: adapter } = enroller(json({ detail: 'x' }, status));
      await expect(adapter.enrol(Buffer.from('audio'))).rejects.toBeInstanceOf(
        VoiceNotHeardError,
      );
    }
    const { enroller: adapter, fetcher } = enroller(json(ANSWER));
    await expect(adapter.enrol(Buffer.alloc(0))).rejects.toBeInstanceOf(
      VoiceNotHeardError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("AS-311 no voice model is ASSISTANT_VOICE_UNAVAILABLE with clinica-ai's reason", async () => {
    const { enroller: adapter } = enroller(
      json(
        { detail: 'El registro de voz no está disponible: falta el modelo.' },
        503,
      ),
    );

    await expect(adapter.enrol(Buffer.from('audio'))).rejects.toMatchObject({
      code: 'ASSISTANT_VOICE_UNAVAILABLE',
      userTitle:
        'No se puede registrar la voz ahora: El registro de voz no está disponible: falta el modelo.',
    });
  });

  it('AS-311 a service that is down or answers something else is unavailable, quoting nothing', async () => {
    for (const response of [
      new Error('connect ECONNREFUSED audio-bytes'),
      json({ ...ANSWER, vector: [1, 2] }),
      json(ANSWER, 500),
    ]) {
      const { enroller: adapter } = enroller(response);
      const error = await adapter
        .enrol(Buffer.from('audio'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VoiceUnavailableError);
      expect(String((error as Error).message)).not.toContain('audio');
    }
  });

  it('AS-313 says whether voices can be told apart, with the reason when not', async () => {
    const off = enroller(
      json({
        speakerAttribution: {
          available: false,
          model: 'x',
          reason: 'falta torch',
        },
      }),
    );
    expect(await off.enroller.attributionStatus()).toEqual({
      available: false,
      reason: 'falta torch',
    });

    const on = enroller(
      json({
        speakerAttribution: { available: true, model: 'x', reason: null },
      }),
    );
    expect(await on.enroller.attributionStatus()).toEqual({
      available: true,
      reason: null,
    });

    const down = enroller(new Error('down'));
    expect((await down.enroller.attributionStatus()).available).toBe(false);
  });

  it('AS-311 without the shared secret it sends nothing and says it is not configured', async () => {
    const missing = new MissingVoiceprintEnroller();

    await expect(missing.enrol()).rejects.toBeInstanceOf(VoiceUnavailableError);
    expect((await missing.attributionStatus()).available).toBe(false);
  });
});
