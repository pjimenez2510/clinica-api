import { PrismaPg } from '@prisma/adapter-pg';

/**
 * The one way this system opens a connection to PostgreSQL.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THE SESSION TIME ZONE IS PINNED, AND WHY IT IS NOT A PREFERENCE
 * ═════════════════════════════════════════════════════════════════════════
 *
 * `@prisma/adapter-pg` serialises a JavaScript `Date` with `formatDateTime`,
 * which writes the UTC parts and **no zone suffix**:
 *
 *     new Date('2026-06-30T05:00:00Z')  →  '2026-06-30 05:00:00'
 *
 * PostgreSQL resolves a naive literal like that with the SESSION's `TimeZone`.
 * So the whole stack silently assumes the session is UTC — and when it is not,
 * every instant this system stores and every instant it compares against
 * shifts by the session's offset. With `TimeZone = 'Asia/Tokyo'` the appointment
 * above is stored, and matched, as 2026-06-29T20:00:00Z: nine hours and one
 * calendar day away from what the code meant.
 *
 * That assumption held by accident — the container and the default
 * configuration are both UTC — and an accident is not a guarantee. A
 * `postgresql.conf` with `timezone = 'America/Guayaquil'`, an
 * `ALTER DATABASE … SET TimeZone`, or a managed provider with its own default
 * is enough to move every clinical instant in the database, silently, with no
 * error anywhere. It was found by the E6 metric test, which asked for the same
 * range twice under two session zones and got two different answers.
 *
 * PINNED AT STARTUP, through libpq's `options`, so it applies to every
 * connection this pool opens before any query runs — including the ones the
 * pool creates later under load, which a one-off `SET` after connecting would
 * miss. It does NOT defend against a `SET TimeZone` issued mid-session; nothing
 * in this system issues one, and the failure it closes is the configured
 * default, which is the one that happens.
 *
 * UTC AND NOT `America/Guayaquil`, deliberately. This is the wire format the
 * driver already assumes, not a business decision: the clinical calendar is
 * resolved in `shared/domain/clinic-time.ts`, in Ecuador, before an instant
 * ever reaches here. Setting the session to Guayaquil would make the two
 * layers disagree about what an unqualified timestamp means and would be a
 * second, invisible place where the zone is decided.
 */
export function createPgAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    // libpq start-up options. `-c` sets a GUC for the session, exactly as
    // `PGOPTIONS` would from the environment.
    options: '-c TimeZone=UTC',
  });
}
