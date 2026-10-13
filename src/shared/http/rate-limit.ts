import type { ThrottlerOptions } from '@nestjs/throttler';

/**
 * The three general windows of the rate limiter, per route and address: they
 * tell a short burst apart from sustained abuse.
 *
 * `scale` multiplies the LIMIT of each and nothing else. It is 1 in production
 * (`RATE_LIMIT_SCALE`, refused otherwise there): only the walks' own API raises
 * it, because every request of a run comes from 127.0.0.1 and a run is faster
 * than a clinic. The limits a route declares itself (`@Throttle` on login, MFA,
 * the cedula lookup…) are not scaled.
 */
export function generalThrottlers(scale: number): ThrottlerOptions[] {
  return [
    // 10/s: the agenda's week view legitimately bursts 6 same-handler
    // GETs (one per day); 5/s returned 429 on the sixth and blanked it.
    { name: 'short', ttl: 1_000, limit: 10 * scale },
    { name: 'medium', ttl: 10_000, limit: 30 * scale },
    { name: 'long', ttl: 60_000, limit: 150 * scale },
  ];
}
