import type { LiveEventBus } from '../../../shared/events/live-event-bus';

/**
 * AG-179, BI-238 (D-187, paso 2). An attention of this site moved: the
 * agenda and the boards read their day again, and so does the waiting room
 * —the row lives in `agenda_entry` (EN-134)—; when the attention ENDED, caja
 * too, because that is what puts the visit in «Por cobrar» (BI-181).
 *
 * CALLED LAST, after the write committed, as `orders` does (ORD-164). The
 * events say the kind and the site and nothing else (AU-055), and `publish`
 * never throws (AU-058).
 */
export function announceEncounterChange(
  bus: LiveEventBus,
  siteId: string,
  options: { ended: boolean },
): void {
  bus.publish({ kind: 'agenda', siteId });
  bus.publish({ kind: 'waiting-room', siteId });
  if (options.ended) bus.publish({ kind: 'billing', siteId });
}
