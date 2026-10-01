import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A LOCAL DOUBLE OF THE SRI's OFFLINE WEB SERVICES. Never the SRI.
 *
 * It answers `validarComprobante` and `autorizacionComprobante` with the
 * envelopes printed in the Ficha Técnica v2.34 §7.2.3, so the client, the
 * queue and the screen can be exercised end to end without a single packet
 * reaching `celcer.sri.gob.ec` or `cel.sri.gob.ec` (the author connects to
 * those, sri/SPEC.md §9).
 *
 * A SCENARIO PER ACCESS KEY, with a default for keys nobody named. Every
 * call is recorded, so a test can assert what the double was NOT asked —
 * «the voucher answered 70 was never sent again» is a claim about calls.
 *
 * Written without TypeScript-only syntax so `node --experimental-strip-types`
 * can run it as the development server (`pnpm sri:double`).
 */
export type DoubleScenario =
  /** RECIBIDA, then AUTORIZADO. */
  | 'AUTHORISED'
  /** DEVUELTA 35 — the voucher does not pass the schema. */
  | 'RETURNED_35'
  /** DEVUELTA 43 — already registered; the authorisation exists. */
  | 'ALREADY_REGISTERED_43'
  /** DEVUELTA 70 — in process; the authorisation is pending, then given. */
  | 'IN_PROCESS_70'
  /** RECIBIDA, then the authorisation refuses it (Ficha: «RECHAZADO»). */
  | 'NOT_AUTHORISED'
  /** RECIBIDA, then nothing for the key yet: `numeroComprobantes = 0`. */
  | 'PENDING'
  /** HTTP 200 with a body that is not an answer (an HTML error page). */
  | 'GARBAGE';

export interface DoubleCall {
  operation: 'RECEPTION' | 'AUTHORISATION';
  accessKey: string | null;
  at: Date;
}

export interface SriDouble {
  baseUrl: string;
  receptionUrl: string;
  authorisationUrl: string;
  calls: DoubleCall[];
  setScenario(accessKey: string, scenario: DoubleScenario): void;
  setDefault(scenario: DoubleScenario): void;
  /** While down, every call answers 503 (`SRI caído`). */
  setDown(down: boolean): void;
  /** How many authorisation polls a 70 stays pending before it is given. */
  setPendingPolls(polls: number): void;
  callsFor(
    accessKey: string,
    operation?: DoubleCall['operation'],
  ): DoubleCall[];
  reset(): void;
  close(): Promise<void>;
}

const RECEPTION_PATH =
  '/comprobantes-electronicos-ws/RecepcionComprobantesOffline';
const AUTHORISATION_PATH =
  '/comprobantes-electronicos-ws/AutorizacionComprobantesOffline';

function envelope(body: string) {
  return (
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

function messageXml(
  identifier: string,
  message: string,
  type: string,
  extra?: string,
) {
  return (
    '<mensaje>' +
    `<identificador>${identifier}</identificador>` +
    `<mensaje>${message}</mensaje>` +
    (extra ? `<informacionAdicional>${extra}</informacionAdicional>` : '') +
    `<tipo>${type}</tipo>` +
    '</mensaje>'
  );
}

function reception(
  state: 'RECIBIDA' | 'DEVUELTA',
  accessKey: string,
  messages = '',
) {
  const comprobantes =
    state === 'RECIBIDA'
      ? '<comprobantes/>'
      : '<comprobantes><comprobante>' +
        `<claveAcceso>${accessKey}</claveAcceso>` +
        `<mensajes>${messages}</mensajes>` +
        '</comprobante></comprobantes>';
  return envelope(
    '<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion">' +
      '<RespuestaRecepcionComprobante>' +
      `<estado>${state}</estado>${comprobantes}` +
      '</RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>',
  );
}

/** ISO-8601 with Ecuador's `-05:00` offset, as the SRI writes `fechaAutorizacion`. */
function guayaquilTimestamp(instant: Date) {
  const shifted = new Date(instant.getTime() - 5 * 3600 * 1000);
  return shifted.toISOString().replace('Z', '-05:00');
}

function refusalXml(at: Date, signedXml: string) {
  return (
    '<autorizacion><estado>RECHAZADO</estado>' +
    `<fechaAutorizacion>${guayaquilTimestamp(at)}</fechaAutorizacion>` +
    '<ambiente>PRUEBAS</ambiente>' +
    `<comprobante><![CDATA[${signedXml}]]></comprobante>` +
    '<mensajes>' +
    messageXml(
      '39',
      'FIRMA INVALIDA',
      'ERROR',
      'La firma es invalida [doble local del SRI]',
    ) +
    '</mensajes></autorizacion>'
  );
}

/**
 * The SRI answers with EVERY authorisation it holds for the key: a voucher
 * refused and re-sent comes back with its old refusal next to whatever the
 * new one is — including nothing yet. `history` is those old refusals.
 */
function authorisation(
  accessKey: string,
  outcome: 'AUTORIZADO' | 'RECHAZADO' | 'NONE',
  signedXml: string | null,
  history: readonly { at: Date; signedXml: string }[] = [],
) {
  const past = history.map((r) => refusalXml(r.at, r.signedXml)).join('');
  const count = history.length + (outcome === 'NONE' ? 0 : 1);
  const authorisations =
    outcome === 'NONE'
      ? past === ''
        ? '<autorizaciones/>'
        : `<autorizaciones>${past}</autorizaciones>`
      : '<autorizaciones>' +
        past +
        '<autorizacion>' +
        `<estado>${outcome}</estado>` +
        (outcome === 'AUTORIZADO'
          ? `<numeroAutorizacion>${accessKey}</numeroAutorizacion>`
          : '') +
        `<fechaAutorizacion>${guayaquilTimestamp(new Date())}</fechaAutorizacion>` +
        '<ambiente>PRUEBAS</ambiente>' +
        `<comprobante><![CDATA[${signedXml ?? ''}]]></comprobante>` +
        '<mensajes>' +
        (outcome === 'AUTORIZADO'
          ? messageXml(
              '60',
              'ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS',
              'ADVERTENCIA',
            )
          : messageXml(
              '39',
              'FIRMA INVALIDA',
              'ERROR',
              'La firma es invalida [doble local del SRI]',
            )) +
        '</mensajes>' +
        '</autorizacion></autorizaciones>';
  return envelope(
    '<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion">' +
      '<RespuestaAutorizacionComprobante>' +
      `<claveAccesoConsultada>${accessKey}</claveAccesoConsultada>` +
      `<numeroComprobantes>${count}</numeroComprobantes>` +
      authorisations +
      '</RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>',
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function between(text: string, open: string, close: string) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? null : text.slice(start + open.length, end);
}

export async function startSriDouble(
  options: { port?: number } = {},
): Promise<SriDouble> {
  const scenarios = new Map<string, DoubleScenario>();
  const refusals = new Map<string, { at: Date; signedXml: string }[]>();
  const received = new Map<string, string>();
  const polls = new Map<string, number>();
  const calls: DoubleCall[] = [];
  let fallback: DoubleScenario = 'AUTHORISED';
  let down = false;
  let pendingPolls = 2;

  const scenarioOf = (key: string) => scenarios.get(key) ?? fallback;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const reply = (
        status: number,
        xml: string,
        type = 'text/xml; charset=utf-8',
      ) => {
        response.writeHead(status, { 'Content-Type': type });
        response.end(xml);
      };

      // Control surface for the development server, never part of the SRI.
      if (request.url === '/__double/state' && request.method === 'POST') {
        const state = JSON.parse(body || '{}') as {
          default?: DoubleScenario;
          down?: boolean;
          scenario?: { accessKey: string; scenario: DoubleScenario };
        };
        if (state.default) fallback = state.default;
        if (typeof state.down === 'boolean') down = state.down;
        if (state.scenario)
          scenarios.set(state.scenario.accessKey, state.scenario.scenario);
        reply(
          200,
          JSON.stringify({ default: fallback, down }),
          'application/json',
        );
        return;
      }
      if (request.url === '/__double/state' && request.method === 'GET') {
        reply(
          200,
          JSON.stringify({ default: fallback, down, calls: calls.length }),
          'application/json',
        );
        return;
      }

      if (request.url === RECEPTION_PATH && request.method === 'POST') {
        const base64 = between(body, '<xml>', '</xml>');
        const voucher = base64
          ? Buffer.from(base64, 'base64').toString('utf8')
          : '';
        const accessKey = between(voucher, '<claveAcceso>', '</claveAcceso>');
        calls.push({ operation: 'RECEPTION', accessKey, at: new Date() });
        if (down)
          return reply(
            503,
            '<html><body>Servicio no disponible</body></html>',
            'text/html',
          );
        if (!accessKey)
          return reply(
            500,
            envelope(
              '<soap:Fault><faultstring>sin comprobante</faultstring></soap:Fault>',
            ),
          );

        const scenario = scenarioOf(accessKey);
        if (scenario === 'GARBAGE')
          return reply(200, '<html>mantenimiento</html>', 'text/html');
        if (scenario === 'RETURNED_35') {
          return reply(
            200,
            reception(
              'DEVUELTA',
              accessKey,
              messageXml(
                '35',
                'ARCHIVO NO CUMPLE ESTRUCTURA XML',
                'ERROR',
                'Error de esquema simulado por el doble local del SRI',
              ),
            ),
          );
        }
        if (scenario === 'ALREADY_REGISTERED_43') {
          received.set(accessKey, voucher);
          return reply(
            200,
            reception(
              'DEVUELTA',
              accessKey,
              messageXml('43', 'CLAVE ACCESO REGISTRADA', 'ERROR'),
            ),
          );
        }
        if (scenario === 'IN_PROCESS_70') {
          received.set(accessKey, voucher);
          return reply(
            200,
            reception(
              'DEVUELTA',
              accessKey,
              messageXml('70', 'CLAVE DE ACCESO EN PROCESAMIENTO', 'ERROR'),
            ),
          );
        }
        received.set(accessKey, voucher);
        return reply(200, reception('RECIBIDA', accessKey));
      }

      if (request.url === AUTHORISATION_PATH && request.method === 'POST') {
        const accessKey = between(
          body,
          '<claveAccesoComprobante>',
          '</claveAccesoComprobante>',
        );
        calls.push({ operation: 'AUTHORISATION', accessKey, at: new Date() });
        if (down)
          return reply(
            503,
            '<html><body>Servicio no disponible</body></html>',
            'text/html',
          );
        if (!accessKey)
          return reply(
            500,
            envelope(
              '<soap:Fault><faultstring>sin clave</faultstring></soap:Fault>',
            ),
          );

        const scenario = scenarioOf(accessKey);
        const voucher = received.get(accessKey) ?? null;
        if (scenario === 'GARBAGE')
          return reply(200, '<html>mantenimiento</html>', 'text/html');
        const history = refusals.get(accessKey) ?? [];
        if (!voucher || scenario === 'PENDING')
          return reply(200, authorisation(accessKey, 'NONE', null, history));
        if (scenario === 'NOT_AUTHORISED') {
          const answer = authorisation(
            accessKey,
            'RECHAZADO',
            voucher,
            history,
          );
          // From now on the SRI holds this refusal for the key.
          refusals.set(accessKey, [
            ...history,
            { at: new Date(), signedXml: voucher },
          ]);
          return reply(200, answer);
        }
        if (scenario === 'IN_PROCESS_70') {
          const seen = (polls.get(accessKey) ?? 0) + 1;
          polls.set(accessKey, seen);
          if (seen <= pendingPolls)
            return reply(200, authorisation(accessKey, 'NONE', null, history));
        }
        return reply(
          200,
          authorisation(accessKey, 'AUTORIZADO', voucher, history),
        );
      }

      reply(404, 'not found', 'text/plain');
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve),
  );
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    receptionUrl: `${baseUrl}${RECEPTION_PATH}`,
    authorisationUrl: `${baseUrl}${AUTHORISATION_PATH}`,
    calls,
    setScenario: (accessKey, scenario) => scenarios.set(accessKey, scenario),
    setDefault: (scenario) => {
      fallback = scenario;
    },
    setDown: (value) => {
      down = value;
    },
    setPendingPolls: (value) => {
      pendingPolls = value;
    },
    callsFor: (accessKey, operation) =>
      calls.filter(
        (c) =>
          c.accessKey === accessKey &&
          (!operation || c.operation === operation),
      ),
    reset: () => {
      scenarios.clear();
      received.clear();
      polls.clear();
      refusals.clear();
      calls.length = 0;
      fallback = 'AUTHORISED';
      down = false;
      pendingPolls = 2;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
