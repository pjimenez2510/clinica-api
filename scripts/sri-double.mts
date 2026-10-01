import { startSriDouble } from '../test/sri-double/sri-double.ts';

/**
 * `pnpm sri:double` — THE LOCAL DOUBLE OF THE SRI for development and for the
 * screen walkthrough of F-06. Never the SRI: it listens on the loopback only.
 *
 * The API reaches it through `SRI_RECEPTION_URL` / `SRI_AUTHORISATION_URL`
 * (`.env.example`). Its scenario is changed while it runs:
 *
 *   curl -X POST localhost:8099/__double/state -d '{"default":"RETURNED_35"}'
 *   curl -X POST localhost:8099/__double/state -d '{"down":true}'
 *
 * Scenarios: AUTHORISED · RETURNED_35 · ALREADY_REGISTERED_43 ·
 * IN_PROCESS_70 · NOT_AUTHORISED · PENDING · GARBAGE.
 */
const port = Number(process.env.SRI_DOUBLE_PORT ?? 8099);
const double = await startSriDouble({ port });

console.log(`Doble local del SRI en ${double.baseUrl}`);
console.log(`  recepción:    ${double.receptionUrl}`);
console.log(`  autorización: ${double.authorisationUrl}`);
console.log(
  `  estado:       POST ${double.baseUrl}/__double/state {"default": "...", "down": true|false}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void double.close().then(() => process.exit(0));
  });
}
