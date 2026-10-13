import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DictationTranscriber } from '../../src/modules/assistant/application/dictation-transcriber.port.ts';

import type { DictationCase, Heard } from './cases.ts';

/**
 * AS-188. The voices of the measurement: macOS's synthesis, not any
 * person's, the four Spanish ones SigmAI used in E-055, at their own speed
 * and faster.
 */
export const VOICES = [
  'Paulina',
  'Eddy (Español (México))',
  'Flo (Español (México))',
  'Mónica',
] as const;
export const RATES = [null, 220] as const;

/**
 * One phrase said by one voice, as the screen sends it: PCM16 WAV at 16 kHz,
 * mono. The audio lives in a temporary folder only while it is made, and is
 * removed before the recording is handed back (P3).
 */
export function speak(
  text: string,
  voice: string,
  rate: number | null,
): Buffer {
  const folder = mkdtempSync(join(tmpdir(), 'dictado-'));
  try {
    const speech = join(folder, 's.aiff');
    const wav = join(folder, 's.wav');
    const rateArgs = rate === null ? [] : ['-r', String(rate)];
    execFileSync('say', ['-v', voice, ...rateArgs, '-o', speech, text]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', speech, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]); // prettier-ignore
    return readFileSync(wav);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * AS-188. Every phrase by every voice and speed, through the product's own
 * adapter to `clinica-ai` (the recogniser the nurse will use), one at a time:
 * each recognition holds a `whisper-cli` of about 2 GB.
 */
export async function hearAll(
  cases: readonly DictationCase[],
  transcriber: DictationTranscriber,
  say: typeof speak = speak,
  progress: (done: number, total: number) => void = () => undefined,
): Promise<Heard[]> {
  const heard: Heard[] = [];
  const total = cases.length * VOICES.length * RATES.length;
  for (const item of cases) {
    for (const voice of VOICES) {
      for (const rate of RATES) {
        const recording = say(item.text, voice, rate);
        const { text, words } = await transcriber
          .transcribe(recording)
          // A clip the recogniser found no voice in is heard as nothing.
          .catch((error: unknown) => {
            if ((error as { code?: string }).code === 'ASSISTANT_DICTATION_NOT_HEARD') return { text: '', words: [] }; // prettier-ignore
            throw error;
          });
        heard.push({ id: item.id, voice, rate, text: text.replace(/\s+/g, ' ').trim(), words }); // prettier-ignore
        progress(heard.length, total);
      }
    }
  }
  return heard;
}
