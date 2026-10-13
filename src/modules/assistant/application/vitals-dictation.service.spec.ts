import { describe, expect, it, vi } from 'vitest';

import type {
  CodingContextReader,
  CodingEncounter,
  CodingEncounterStatus,
} from '../../../shared/clinical/coding-context.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  DictationNotHeardError,
} from '../domain/assistant.errors';

import type { DictationHeard } from './dictation-transcriber.port';
import {
  MAX_DICTATION_SECONDS,
  VitalsDictationService,
} from './vitals-dictation.service';

const ENCOUNTER_ID = '01900000-0000-7000-8000-000000000001';
const RECORDING = Buffer.from('a recording');

/** What clinica-ai heard, every token sure of itself. */
function sure(text: string, seconds = 3): DictationHeard {
  return {
    text,
    seconds,
    words: text.split(' ').map((piece, at) => ({ text: at === 0 ? piece : ` ${piece}`, probability: 0.98 })), // prettier-ignore
  };
}

function encounter(status: CodingEncounterStatus = 'OPEN'): CodingEncounter {
  return {
    id: ENCOUNTER_ID,
    patientId: 'p-1',
    siteId: 'site-1',
    practitionerUserId: 'a-doctor',
    status,
    clinicalDate: 'irrelevant',
  };
}

function service(
  found: CodingEncounter | null,
  heard: DictationHeard = { text: '', seconds: 0, words: [] },
) {
  const reader = { encounter: vi.fn(() => Promise.resolve(found)) };
  const transcriber = { transcribe: vi.fn(() => Promise.resolve(heard)) };
  return {
    reader,
    transcriber,
    service: new VitalsDictationService(
      reader as unknown as CodingContextReader,
      transcriber,
    ),
  };
}

describe('AS-180 AS-185 AS-186 AS-196 AS-197 VitalsDictationService', () => {
  it('AS-180 reads what clinica-ai heard into a proposal and asks for the attention within the sites given', async () => {
    const {
      service: dictation,
      reader,
      transcriber,
    } = service(
      encounter(),
      sure(
        'Presión 120 sobre 80, pulso 72, frecuencia respiratoria trescientos',
      ),
    );

    await expect(
      dictation.dictate(ENCOUNTER_ID, RECORDING, { sites: ['site-1'] }),
    ).resolves.toEqual({
      heard:
        'Presión 120 sobre 80, pulso 72, frecuencia respiratoria trescientos',
      signs: { systolicBp: 120, diastolicBp: 80, heartRate: 72 },
      unclear: ['respiratoryRate'],
    });
    expect(reader.encounter).toHaveBeenCalledWith(ENCOUNTER_ID, ['site-1']);
    expect(transcriber.transcribe).toHaveBeenCalledWith(RECORDING);
  });

  it('AS-185 an attention that does not exist or is out of the sites is not found, and nothing is transcribed', async () => {
    const { service: dictation, transcriber } = service(null);

    await expect(
      dictation.dictate(ENCOUNTER_ID, RECORDING, { sites: 'all' }),
    ).rejects.toBeInstanceOf(AssistantEncounterNotFoundError);
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    'DISCHARGED',
    'COMPLETED',
    'DISCONTINUED',
    'ENTERED_IN_ERROR',
  ] as const)(
    'AS-185 a %s attention takes no dictation, and nothing is transcribed',
    async (status) => {
      const { service: dictation, transcriber } = service(encounter(status));

      await expect(
        dictation.dictate(ENCOUNTER_ID, RECORDING, { sites: 'all' }),
      ).rejects.toBeInstanceOf(AssistantEncounterClosedError);
      expect(transcriber.transcribe).not.toHaveBeenCalled();
    },
  );

  it('AS-185 an attention on hold still takes a dictation (the control of the closed ones)', async () => {
    const { service: dictation } = service(
      encounter('ON_HOLD'),
      sure('pulso 70'),
    );

    await expect(
      dictation.dictate(ENCOUNTER_ID, RECORDING, { sites: 'all' }),
    ).resolves.toMatchObject({ signs: { heartRate: 70 } });
  });

  it('AS-186 a recording where no voice was heard says how long it was', async () => {
    const { service: dictation } = service(encounter(), {
      text: '   ',
      seconds: 4.4,
      words: [],
    });

    const error = await dictation
      .dictate(ENCOUNTER_ID, RECORDING, { sites: 'all' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DictationNotHeardError);
    expect((error as DictationNotHeardError).heard).toEqual({
      kind: 'silent',
      seconds: 4.4,
    });
  });

  it('AS-197 a number clinica-ai was unsure of is not proposed, and what was heard is shown as heard', async () => {
    const heard = sure('frecuencia respiratoria 20, pulso 80');
    heard.words[2] = { text: ' 20,', probability: 0.6 };
    const { service: dictation } = service(encounter(), heard);

    await expect(
      dictation.dictate(ENCOUNTER_ID, RECORDING, { sites: 'all' }),
    ).resolves.toEqual({
      heard: 'frecuencia respiratoria 20, pulso 80',
      signs: { heartRate: 80 },
      unclear: ['respiratoryRate'],
    });
  });

  it('AS-196 tells the screen how long a dictation may last, for a live attention in scope', async () => {
    await expect(
      service(encounter()).service.limits(ENCOUNTER_ID, { sites: 'all' }),
    ).resolves.toEqual({ maxSeconds: MAX_DICTATION_SECONDS });
    await expect(
      service(null).service.limits(ENCOUNTER_ID, { sites: 'all' }),
    ).rejects.toBeInstanceOf(AssistantEncounterNotFoundError);
    expect(MAX_DICTATION_SECONDS).toBe(120);
  });
});
