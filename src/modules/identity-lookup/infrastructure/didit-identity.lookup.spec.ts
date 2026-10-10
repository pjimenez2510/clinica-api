import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Cedula } from '../../../shared/domain/value-objects/cedula.vo';

import {
  DiditIdentityLookup,
  ProviderAnswerError,
} from './didit-identity.lookup';

/**
 * The provider adapter against a LOCAL double of the provider: an HTTP server
 * on the loopback, never the real service (D-206; IL-008).
 */

/** Synthetic, with a computed check digit; never a real person's. */
const CEDULA = Cedula.create('1701000018');
const KEY = 'clave-de-prueba';

interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

describe('the provider adapter (local double)', () => {
  let server: Server;
  let url: string;
  let reply: (res: import('node:http').ServerResponse) => void;
  let seen: Seen[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: JSON.parse(raw || '{}') as Record<string, unknown> }); // prettier-ignore
        reply(res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/database-validation/`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    seen = [];
  });

  const json =
    (status: number, body: unknown) =>
    (res: import('node:http').ServerResponse) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

  it('IL-001 sends one cedula with the key and maps the names, already separated', async () => {
    reply = json(200, {
      status: 'Approved',
      match_type: 'full_match',
      source_data: {
        first_name: 'MARIA JOSE',
        last_name: 'DE LA TORRE QUISPE',
        identification_number: CEDULA.toString(),
        date_of_birth: '1990-05-17', // fecha-fija: lo que respondería el doble
      },
    });

    const finding = await new DiditIdentityLookup(url, KEY).findByCedula(CEDULA, new AbortController().signal); // prettier-ignore

    expect(finding).toEqual({
      source: 'PROVIDER',
      sourceName: 'DE LA TORRE QUISPE MARIA JOSE',
      familyName: 'DE LA TORRE',
      secondFamilyName: 'QUISPE',
      givenName: 'MARIA',
      secondGivenName: 'JOSE',
      birthDate: '1990-05-17', // fecha-fija: la misma del doble
      orderToReview: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-api-key']).toBe(KEY);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body).toEqual({ issuing_state: 'ECU', services: 'ecu_cedula', personal_number: CEDULA.toString() }); // prettier-ignore
  });

  it('IL-001 answers null when the provider found nobody', async () => {
    reply = json(200, { status: 'Declined', match_type: 'no_match', source_data: {} }); // prettier-ignore
    expect(await new DiditIdentityLookup(url, KEY).findByCedula(CEDULA, new AbortController().signal)).toBeNull(); // prettier-ignore
  });

  it('IL-003 throws on an error status, so the service moves on', async () => {
    reply = json(500, { error: 'boom' });
    await expect(new DiditIdentityLookup(url, KEY).findByCedula(CEDULA, new AbortController().signal)).rejects.toBeInstanceOf(ProviderAnswerError); // prettier-ignore
  });

  it('IL-003 stops waiting when the budget aborts the request', async () => {
    reply = () => {}; // never answers
    const budget = new AbortController();
    const pending = new DiditIdentityLookup(url, KEY).findByCedula(CEDULA, budget.signal); // prettier-ignore
    budget.abort();
    await expect(pending).rejects.toThrow();
  });
});
