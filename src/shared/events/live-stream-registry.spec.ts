import { describe, expect, it } from 'vitest';

import {
  LiveStreamRegistry,
  MAX_STREAMS_PER_USER,
} from './live-stream-registry';

describe('los flujos abiertos por persona', () => {
  it('AU-054 con más del tope por persona se cierra el más antiguo, y los de otra persona no se tocan', () => {
    const registry = new LiveStreamRegistry();
    const ended: number[] = [];
    registry.track('other', () => ended.push(-1));
    for (let index = 0; index <= MAX_STREAMS_PER_USER; index += 1) {
      registry.track('u1', () => ended.push(index));
    }

    expect(ended).toEqual([0]);
    expect(registry.count('u1')).toBe(MAX_STREAMS_PER_USER);
    expect(registry.count('other')).toBe(1);
  });

  it('AU-057 al apagar la API se terminan todos, y lo olvidado no se termina', () => {
    const registry = new LiveStreamRegistry();
    const ended: string[] = [];
    const forget = registry.track('u1', () => ended.push('a'));
    registry.track('u2', () => ended.push('b'));
    forget();

    registry.endAll();
    expect(ended).toEqual(['b']);
  });
});
