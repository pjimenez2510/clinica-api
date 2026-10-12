import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiRunStore } from './application/ai-run.store';
import { AssistantModule } from './assistant.module';

const DAY_MS = 86_400_000;

function storeWith(purge: AiRunStore['purgeExchanges']) {
  const purgeExchanges = vi.fn(purge);
  const store: AiRunStore = {
    record: vi.fn(),
    spentSince: vi.fn(),
    purgeExchanges,
  };
  return { store, purgeExchanges };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AssistantModule', () => {
  it('AS-015 purges the exchanges at boot and once a day after, until it is destroyed', async () => {
    vi.useFakeTimers();
    const { store, purgeExchanges } = storeWith(() => Promise.resolve(0));
    const module = new AssistantModule(store);

    module.onModuleInit();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    module.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);

    expect(purgeExchanges).toHaveBeenCalledTimes(3);
  });

  it('AS-015 AS-018 a failed purge does not stop the API and logs no text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // prettier-ignore
    const { store } = storeWith(() =>
      Promise.reject(new Error('DELETE … Persona_1 refiere dolor')),
    );
    const module = new AssistantModule(store);

    expect(() => module.onModuleInit()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    module.onModuleDestroy();

    expect(JSON.stringify(warn.mock.calls)).not.toContain('Persona_1');
  });
});
