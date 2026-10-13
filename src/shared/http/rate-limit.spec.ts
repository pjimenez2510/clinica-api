import { describe, expect, it } from 'vitest';

import { generalThrottlers } from './rate-limit';

describe('generalThrottlers', () => {
  it('keeps the production windows at scale 1: 10 a second, 30 in 10 s, 150 a minute', () => {
    expect(generalThrottlers(1)).toEqual([
      { name: 'short', ttl: 1_000, limit: 10 },
      { name: 'medium', ttl: 10_000, limit: 30 },
      { name: 'long', ttl: 60_000, limit: 150 },
    ]);
  });

  it('multiplies only the limit of each window, never its length or name', () => {
    expect(generalThrottlers(10)).toEqual([
      { name: 'short', ttl: 1_000, limit: 100 },
      { name: 'medium', ttl: 10_000, limit: 300 },
      { name: 'long', ttl: 60_000, limit: 1_500 },
    ]);
  });
});
