import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { DocumentVerificationController } from './document-verification.controller';

/**
 * DOC-094. The only public route of the module is RATE LIMITED, and that is
 * asserted on the declaration itself: the HTTP suites replace the throttler's
 * storage so they can run, and would stay green if the decorator were removed.
 */
describe('DocumentVerificationController', () => {
  it('DOC-094 la verificación pública lleva su tope: 30 por minuto y por IP', () => {
    const handler = Object.getOwnPropertyDescriptor(
      DocumentVerificationController.prototype,
      'verify',
    )?.value as object;

    expect(Reflect.getMetadata('THROTTLER:LIMITshort', handler)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLshort', handler)).toBe(60_000);
  });
});
