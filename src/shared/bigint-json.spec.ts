import { beforeAll, describe, expect, it } from 'vitest';

import { enableBigIntSerialisation } from './bigint-json';

/**
 * Patching a global prototype deserves a test that explains why it is there.
 *
 * Without this, the first endpoint returning an audit-log row answers a generic
 * 500 — and it is the endpoint the SPDP asks to see.
 */
describe('BigInt serialisation', () => {
  beforeAll(() => {
    enableBigIntSerialisation();
  });

  it('serialises a BigInt instead of throwing', () => {
    // The unpatched behaviour is a TypeError, not a wrong value.
    expect(JSON.stringify({ id: 42n })).toBe('{"id":"42"}');
  });

  it('emits a STRING, so a large id cannot lose precision', () => {
    // 2^53 + 1. As a JSON number this comes back as 9007199254740992 —
    // silently the wrong identifier.
    const beyondSafeInteger = 9_007_199_254_740_993n;

    const serialised = JSON.parse(
      JSON.stringify({ id: beyondSafeInteger }),
    ) as { id: unknown };

    expect(serialised.id).toBe('9007199254740993');
    expect(typeof serialised.id).toBe('string');
  });

  it('survives a round trip through the value Prisma returns', () => {
    const auditRow = { id: 1n, resourceType: 'Patient', action: 'READ' };

    expect(JSON.parse(JSON.stringify(auditRow))).toEqual({
      id: '1',
      resourceType: 'Patient',
      action: 'READ',
    });
  });
});
