/* eslint-disable @typescript-eslint/unbound-method -- the method is only a
   target for `Reflect.getMetadata`, never called, so `this` is irrelevant. */
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { IdentityLookupController } from './identity-lookup.controller';

/**
 * IL-011. The proposal route caps consultations at twenty a minute from one
 * origin, «ninguna consulta en lote» (D-206). Asserted on the decorator's
 * metadata so removing `@Throttle` turns this red instead of silently
 * reopening a batch route. The keys are @nestjs/throttler's
 * `THROTTLER:LIMIT`/`THROTTLER:TTL` plus the window name; written as literals
 * because the package's named constants come through as `undefined` under the
 * test runner's module interop.
 */
describe('IdentityLookupController throttle (IL-011)', () => {
  it('IL-011 limits the proposal to 20 per minute on the short window', () => {
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITshort',
        IdentityLookupController.prototype.propose,
      ),
    ).toBe(20);
    expect(
      Reflect.getMetadata(
        'THROTTLER:TTLshort',
        IdentityLookupController.prototype.propose,
      ),
    ).toBe(60_000);
  });
});
