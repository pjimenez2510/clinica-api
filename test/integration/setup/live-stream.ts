/**
 * `GET /events` read as the browser reads it (D-187): `fetch` with the
 * `Authorization` header and the stream parsed block by block. Shared by the
 * suites that watch what the channel delivers to a real session.
 */
export interface StreamEvent {
  type: string;
  data: string;
  /** Nest numbers every message it is not given an id for. */
  id: string;
}

export interface OpenStream {
  status: number;
  events: StreamEvent[];
  ended: Promise<void>;
  close: () => void;
}

export async function openLiveStream(
  baseUrl: string,
  token?: string,
): Promise<OpenStream> {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/events`, {
    headers: {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: abort.signal,
  });
  const events: StreamEvent[] = [];
  const ended = (async () => {
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const field = (name: string) =>
            block
              .split('\n')
              .find((line) => line.startsWith(`${name}: `))
              ?.slice(name.length + 2) ?? '';
          events.push({
            type: field('event'),
            data: field('data'),
            id: field('id'),
          });
        }
      }
    } catch {
      // Aborted by `close()`.
    }
  })();
  return {
    status: response.status,
    events,
    ended,
    close: () => abort.abort(),
  };
}

export async function until(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const ofKind = (stream: OpenStream, kind: string): StreamEvent[] =>
  stream.events.filter((event) => event.type === kind);
