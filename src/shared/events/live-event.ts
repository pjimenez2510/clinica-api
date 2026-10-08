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
  /**
   * AG-179, AG-180. The entries of a site changed: the agenda, the reception
   * board and the day board read theirs again.
   */
  agenda: 'agenda:read',
  /**
   * AG-179, AG-180. What the waiting room projects may have changed. A kind
   * of its own so the room's account —which holds `agenda:board:public` and
   * nothing else— hears this and only this.
   */
  'waiting-room': 'agenda:board:public',
  /** BI-238. Caja of a site: an account, a charge, a visit ready to charge. */
  billing: 'billing:read',
  /** SRI-092. An electronic voucher of a site changed state. */
  sri: 'billing:read',
  /**
   * AG-182. An emergency notice (AG-129, AG-175) was raised or acknowledged.
   * ADDRESSED: it reaches only the sessions of its recipients (`userIds`).
   */
  'emergency-alerts': 'agenda:read',
} as const satisfies Record<string, Permission>;

export type LiveEventKind = keyof typeof LIVE_EVENT_PERMISSION;

/** AG-182. The kinds that are said to their recipients, never to a site. */
const ADDRESSED_KINDS: ReadonlySet<LiveEventKind> = new Set([
  'emergency-alerts',
]);

/**
 * AU-054 (afinado). What a session must hold —any one of them, at some site—
 * for the channel to open and to stay open: the permission of some kind of
 * event. Derived from the map, so a new kind widens the route by itself.
 */
export const LIVE_STREAM_PERMISSIONS = [
  ...new Set(Object.values(LIVE_EVENT_PERMISSION)),
] as [Permission, ...Permission[]];

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
  /**
   * AG-182. For an addressed event, who may hear it. It travels between API
   * instances and NEVER to a browser: the stream rebuilds each event as
   * `{ kind, siteId }` (AU-055).
   */
  userIds: z.array(z.uuid()).min(1).max(50).optional(),
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
  // AG-182. An addressed kind without its addressees reaches nobody: closed
  // by default, not «everybody at the site».
  if (ADDRESSED_KINDS.has(event.kind) && !event.userIds) return false;
  if (event.userIds && !event.userIds.includes(principal.userId)) return false;
  return principal.canAtSite(LIVE_EVENT_PERMISSION[event.kind], event.siteId);
}
