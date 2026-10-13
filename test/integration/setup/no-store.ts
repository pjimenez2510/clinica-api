import type { Server } from 'node:http';

import request from 'supertest';
import { expect } from 'vitest';

/**
 * AU-061, the control of every `no-store` assertion: the one route exempt from
 * it, on the same application, answers `no-cache` instead. Without it a
 * `no-store` could come from anywhere —a proxy in the test setup, a global
 * header— and the assertion would prove nothing about the policy.
 *
 * With no tariff published it answers its own 404, and the exemption covers
 * that too.
 */
export async function expectPublicTariffCacheable(
  server: Server,
): Promise<void> {
  const response = await request(server).get('/api/v1/public/tariff');
  // Answered by the tariff itself: a router 404 (the path moved) or a 429
  // also carry no header, and would make this control pass on nothing.
  const fromTheTariff =
    response.status === 200 ||
    (response.status === 404 &&
      (response.body as { code?: string }).code ===
        'TARIFF_PUBLICATION_NOT_FOUND');
  expect(fromTheTariff).toBe(true);
  expect(response.headers['cache-control']).toBe('no-cache');
}
