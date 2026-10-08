import { z } from 'zod';

import type { Permission } from '../authorisation/permission.catalogue';
import type { Principal } from '../authorisation/principal';

/**
 * A live event: «something changed here, read it again» (D-187, AU-055).
 *
 * WHAT TRAVELS IS THE FACT OF A CHANGE, NEVER ITS CONTENT. The screen that
 * hears it asks for its data again through the ordinary API, which applies
 * permissions, site scope and the access trail. So an event delivered to the
 * wrong session teaches it nothing beyond «at this site, this list changed» —
 * and even that is filtered by site (AU-056).
 *
 * The permission each kind demands is declared HERE, next to the kind, and
 * the map is the only source of kinds: a kind without a permission cannot be
 * spelled, so it cannot be published (AU-056, closed by default).
 */
export const LIVE_EVENT_PERMISSION = {
  /** ORD-164. The critical-values queue of a site changed. */
  'critical-results': 'record:read',
} as const satisfies Record<string, Permission>;

export type LiveEventKind = keyof typeof LIVE_EVENT_PERMISSION;

const KINDS = Object.keys(LIVE_EVENT_PERMISSION) as [
  LiveEventKind,
  ...LiveEventKind[],
];

/**
 * The whole event. `strictObject` so a field added by mistake — a patient id,
 * a value — is refused on the way in from Redis instead of travelling on.
 */
export const liveEventSchema = z.strictObject({
  kind: z.enum(KINDS),
  siteId: z.uuid(),
});

export type LiveEvent = z.infer<typeof liveEventSchema>;

/**
 * Parses what arrived on the wire. `null` for anything that is not exactly an
 * event: a malformed message is dropped, never forwarded half-understood.
 */
export function parseLiveEvent(raw: string): LiveEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = liveEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * AU-056. Whether this caller may hear this event: the permission its kind
 * declares, AT the site where it happened — the same test a read of that
 * site's list would pass.
 */
export function mayReceive(principal: Principal, event: LiveEvent): boolean {
  return principal.canAtSite(LIVE_EVENT_PERMISSION[event.kind], event.siteId);
}
