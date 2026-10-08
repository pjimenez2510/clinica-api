/**
 * The open live-events streams, by user (revisión clínica M2).
 *
 * TWO JOBS. A cap per user: every stream holds a socket and asks the database
 * about its session every heartbeat, and nothing else stopped one account from
 * opening hundreds — the browser opens one per browser (ORD-165), so more than
 * a handful is a loop or an abuse, and the OLDEST is the one that goes. And
 * the shutdown: an open stream keeps `app.close()` waiting until its token
 * expires, up to fifteen minutes of a deploy hanging; ending them first lets
 * the browsers reconnect to the next instance.
 */
export const MAX_STREAMS_PER_USER = 5;

export class LiveStreamRegistry {
  private readonly byUser = new Map<string, (() => void)[]>();

  /** Registers a stream's `end`; returns what forgets it. */
  track(userId: string, end: () => void): () => void {
    const open = this.byUser.get(userId) ?? [];
    open.push(end);
    this.byUser.set(userId, open);
    while (open.length > MAX_STREAMS_PER_USER) open.shift()?.();
    return () => {
      const current = this.byUser.get(userId);
      if (!current) return;
      const at = current.indexOf(end);
      if (at >= 0) current.splice(at, 1);
      if (current.length === 0) this.byUser.delete(userId);
    };
  }

  /** Ends every open stream. */
  endAll(): void {
    for (const ends of [...this.byUser.values()]) {
      for (const end of [...ends]) end();
    }
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.length ?? 0;
  }
}
