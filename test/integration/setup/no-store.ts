import type { Server } from 'node:http';

import request from 'supertest';
import { expect } from 'vitest';

/**
 * AU-061, the control of every `no-store` assertion: the one route exempt from
 * it, on the same application, carries no `Cache-Control` at all. Without it a
 * `no-store` could come from anywhere —a proxy in the test setup, a global
 * header— and the assertion would prove nothing about the policy.
 *
 * Whatever its status: with no tariff published it answers 404, and the
 * exemption covers its errors too.
 */
export async function expectPublicTariffCacheable(
  server: Server,
): Promise<void> {
  const response = await request(server).get('/api/v1/public/tariff');
  expect(response.headers['cache-control']).toBeUndefined();
}
