import type { DictationTranscriber } from '../../src/modules/assistant/application/dictation-transcriber.port.ts';
import type { Speaker } from '../../src/modules/assistant/domain/preparation-reading.ts';
import { speak } from '../dictation/hear.ts';

import type { PreparationCase } from './cases.ts';

/**
 * AS-255. One synthetic voice per person, from B2's (AS-188): the reader is
 * never told who speaks, and nothing of the voice reaches it (AS-250).
 */
export const SPEAKER_VOICES: Readonly<Record<Speaker, string>> = {
  nursing: 'Paulina',
  patient: 'Eddy (Español (México))',
  other: 'Mónica',
};

/**
 * AS-255. Every line of every preparation said by its person's voice and
 * heard by `clinica-ai` through the product's own adapter, one at a time:
 * each recognition holds a `whisper-cli` of about 2 GB. A line heard as
 * nothing stays as an empty line, so the case keeps its order.
 */
export async function hearPreparations(
  cases: readonly PreparationCase[],
  transcriber: DictationTranscriber,
  progress: (done: number, total: number) => void = () => undefined,
  say: typeof speak = speak,
): Promise<{ id: string; lines: string[] }[]> {
  const total = cases.reduce((sum, item) => sum + item.lines.length, 0);
  let done = 0;
  const heard: { id: string; lines: string[] }[] = [];
  for (const item of cases) {
    const lines: string[] = [];
    for (const line of item.lines) {
      const recording = say(line.text, SPEAKER_VOICES[line.speaker], null);
      const { text } = await transcriber
        .transcribe(recording)
        .catch((error: unknown) => {
          // prettier-ignore
          if ((error as { code?: string }).code === 'ASSISTANT_DICTATION_NOT_HEARD') return { text: '' }; // prettier-ignore
          throw error;
        });
      lines.push(text.trim());
      progress(++done, total);
    }
    heard.push({ id: item.id, lines });
  }
  return heard;
}
