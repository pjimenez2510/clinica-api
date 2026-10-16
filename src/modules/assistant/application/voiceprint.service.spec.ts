import { describe, expect, it, vi } from 'vitest';

import {
  VoiceNotHeardError,
  VoiceprintConsentRequiredError,
  VoiceprintMissingError,
} from '../domain/assistant.errors';

import type {
  StoredVoiceprint,
  Voiceprint,
  VoiceprintEnroller,
  VoiceprintStore,
} from './voiceprint.port';
import { VoiceprintService } from './voiceprint.service';

const NOW = new Date();
const OWNER = { userId: 'user-1', ip: '127.0.0.1', userAgent: 'test' };
const PRINT: Voiceprint = {
  model: 'speechbrain/spkrec-ecapa-voxceleb',
  dimension: 3,
  vector: [0.6, 0.8, 0],
  phrases: 12,
  seconds: 41.2,
};

class MemoryStore implements VoiceprintStore {
  rows = new Map<string, StoredVoiceprint>();
  /** What the trail got, written with each change as the real store does. */
  readonly trail: string[] = [];

  find(userId: string) {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }

  save(userId: string, voiceprint: Voiceprint, at: Date) {
    this.trail.push(this.rows.has(userId) ? 'UPDATE' : 'CREATE');
    const row = {
      ...voiceprint,
      userId,
      attribution: this.rows.get(userId)?.attribution ?? false,
      consentedAt: at,
      updatedAt: at,
    };
    this.rows.set(userId, row);
    return Promise.resolve(row);
  }

  setAttribution(userId: string, on: boolean, at: Date) {
    const row = this.rows.get(userId);
    if (!row) return Promise.resolve(false);
    this.trail.push('UPDATE');
    this.rows.set(userId, { ...row, attribution: on, updatedAt: at });
    return Promise.resolve(true);
  }

  remove(userId: string) {
    const removed = this.rows.delete(userId);
    if (removed) this.trail.push('DELETE');
    return Promise.resolve(removed);
  }
}

function setUp(
  enrol: VoiceprintEnroller['enrol'] = () => Promise.resolve(PRINT),
) {
  const store = new MemoryStore();
  const enrolled = vi.fn(enrol);
  const enroller: VoiceprintEnroller = {
    enrol: enrolled,
    attributionStatus: () => Promise.resolve({ available: true, reason: null }),
  };
  const service = new VoiceprintService(enroller, store, () => NOW);
  return { service, store, enrolled };
}

describe('VoiceprintService (E17)', () => {
  it('AS-310 keeps only the vector of the caller, and answers without it', async () => {
    const { service, store } = setUp();

    const view = await service.register(OWNER, Buffer.from('audio'), true);

    expect(store.rows.get('user-1')?.vector).toEqual(PRINT.vector);
    expect(view).toEqual({
      registered: {
        phrases: 12,
        seconds: 41.2,
        consentedAt: NOW,
        updatedAt: NOW,
      },
      attribution: false,
      available: true,
      reason: null,
    });
    expect(JSON.stringify(view)).not.toContain('vector');
  });

  it('AS-310 without consent sends nothing to clinica-ai and keeps nothing', async () => {
    const { service, store, enrolled } = setUp();

    await expect(
      service.register(OWNER, Buffer.from('audio'), false),
    ).rejects.toBeInstanceOf(VoiceprintConsentRequiredError);
    expect(enrolled).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('AS-311 a reading without enough voice leaves the voiceprint there was as it was', async () => {
    const { service, store } = setUp(() =>
      Promise.reject(new VoiceNotHeardError()),
    );
    await store.save('user-1', PRINT, NOW);

    await expect(
      service.register(OWNER, Buffer.from('audio'), true),
    ).rejects.toBeInstanceOf(VoiceNotHeardError);
    expect(store.rows.get('user-1')?.vector).toEqual(PRINT.vector);
  });

  it('AS-312 registering again replaces it and the switch keeps its position', async () => {
    const { service, store } = setUp(() =>
      Promise.resolve({ ...PRINT, vector: [0, 1, 0] }),
    );
    await store.save('user-1', PRINT, NOW);
    await store.setAttribution('user-1', true, NOW);

    const view = await service.register(OWNER, Buffer.from('audio'), true);

    expect(store.rows.get('user-1')?.vector).toEqual([0, 1, 0]);
    expect(view.attribution).toBe(true);
  });

  it('AS-312 deleting removes it, the next listening goes without it, and every change is trailed', async () => {
    const { service, store } = setUp();
    await service.register(OWNER, Buffer.from('audio'), true);
    await service.setAttribution(OWNER, true);

    await service.remove(OWNER);
    await service.remove(OWNER);

    expect(store.rows.size).toBe(0);
    expect(await service.forListening('user-1')).toBeNull();
    expect(store.trail).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });

  it('AS-312 a reading the screen stopped waiting for is not kept', async () => {
    const gone = new AbortController();
    const { service, store } = setUp(() => {
      gone.abort();
      return Promise.resolve(PRINT);
    });

    await expect(
      service.register(OWNER, Buffer.from('audio'), true, gone.signal),
    ).rejects.toThrow();
    expect(store.rows.size).toBe(0);
  });

  it('AS-313 the switch is off with the first voiceprint and cannot go on without one', async () => {
    const { service } = setUp();

    await expect(service.setAttribution(OWNER, true)).rejects.toBeInstanceOf(
      VoiceprintMissingError,
    );
    // Positive control: off without a voiceprint is just the answer.
    expect((await service.setAttribution(OWNER, false)).attribution).toBe(
      false,
    );

    expect(
      (await service.register(OWNER, Buffer.from('audio'), true)).attribution,
    ).toBe(false);
    expect((await service.setAttribution(OWNER, true)).attribution).toBe(true);
  });

  it('AS-314 the listening gets the voiceprint only with the switch on', async () => {
    const { service } = setUp();
    await service.register(OWNER, Buffer.from('audio'), true);

    expect(await service.forListening('user-1')).toBeNull();
    await service.setAttribution(OWNER, true);
    expect(await service.forListening('user-1')).toEqual({
      model: PRINT.model,
      vector: PRINT.vector,
    });
    expect(await service.forListening('someone-else')).toBeNull();
  });
});
