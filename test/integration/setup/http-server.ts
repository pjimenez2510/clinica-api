import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Boots the application AND leaves it listening on an ephemeral port for the
 * whole suite.
 *
 * WHY THIS EXISTS — the intermittent `socket hang up` / `read ECONNRESET`.
 *
 * `app.init()` alone wires the application without binding a port, and
 * supertest compensates: `serverAddress()` in `supertest/lib/test.js` reads
 * `app.address()` and, when it is null, does `this._server = app.listen(0)`.
 * The matching `end()` then CLOSES that server once the response lands. So
 * every single `request(app.getHttpServer())` was a listen-then-close cycle on
 * a fresh port — around four hundred of them per full run.
 *
 * That is wasteful, and worse, it is a race. Two requests in flight at once —
 * `AG-040 en la carrera de dos recepcionistas`, `ST-043`, any `Promise.all` of
 * two calls — resolve like this: the first `Test` finds no address and binds
 * the port, the second finds the address the first just bound and therefore
 * never records a `_server` of its own. Whichever response lands first closes
 * the server underneath the other one, and the loser reports a transport
 * error. Nothing about the code under test is wrong; the harness shot it.
 *
 * Binding once, here, removes both. `app.address()` is never null, so
 * supertest takes the `else` branch every time, never listens and never
 * closes, and the port stays up until `closeApp` takes it down.
 *
 * A DOOR THAT FAILS AT RANDOM IS A DOOR PEOPLE LEARN TO IGNORE, which is why
 * this is fixed before the suite grows any further.
 *
 * `127.0.0.1` and not the default wildcard: supertest builds its URL as
 * `http://127.0.0.1:<port>`, so binding anywhere else only widens what can
 * reach a test server holding real migrations.
 */
export async function listenForTests(app: INestApplication): Promise<void> {
  await app.init();

  const server = app.getHttpServer() as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Tears the suite's application down without waiting on keep-alive sockets.
 *
 * `httpServer.close()` resolves only when every connection has ended, and
 * Node's global agent keeps connections alive by default since v19: a bare
 * `app.close()` on a server that answered keep-alive requests can sit there
 * until the hook times out. `closeAllConnections()` ends them first.
 *
 * Optional-chained on the method because it only exists from Node 18.2, and
 * accepts `undefined` so a suite whose `beforeAll` threw can still call it.
 */
export async function closeApp(
  app: INestApplication | undefined,
): Promise<void> {
  if (!app) return;

  const server = app.getHttpServer() as Server | undefined;
  server?.closeAllConnections?.();
  await app.close();
}
