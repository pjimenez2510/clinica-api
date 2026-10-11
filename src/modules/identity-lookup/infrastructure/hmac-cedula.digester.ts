import { createHmac } from 'node:crypto';

import type { CedulaDigester } from '../domain/identity-lookup.store';

/**
 * IL-006. HMAC-SHA256 of the cedula with `IDENTITY_LOOKUP_DIGEST_KEY`.
 *
 * A KEYED hash and not a plain SHA-256: a cedula has ten digits with a check
 * digit, so a plain hash of every possible one is computed in seconds and the
 * digest would be the number in disguise. With the key, only who holds it can
 * ask the trail «¿quién consultó esta cédula?» — which is the point (ARCO).
 */
export class HmacCedulaDigester implements CedulaDigester {
  constructor(private readonly key: string) {}

  digest(cedula: string): string {
    return createHmac('sha256', this.key).update(cedula).digest('hex');
  }
}
