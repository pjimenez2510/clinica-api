import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FetchSriWebService } from '../../src/modules/sri/infrastructure/sri-web-service.client';
import type { Env } from '../../src/shared/config/env.schema';
import {
  LONG_FAULT_DETAIL,
  LONG_FAULT_STRING,
  startSriDouble,
  type SriDouble,
} from '../sri-double/sri-double';

/**
 * SRI-042, SRI-049, SRI-050. The client against the LOCAL DOUBLE of the SRI,
 * over real HTTP. Never the SRI: the URLs are the double's loopback ones.
 */
const KEY = '3009202601179000156300110010010000001230045678911';
const SIGNED = `<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"><infoTributaria><claveAcceso>${KEY}</claveAcceso></infoTributaria><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></factura>`;

function clientFor(urls: {
  reception?: string;
  authorisation?: string;
  timeoutMs?: number;
}): FetchSriWebService {
  const values: Record<string, unknown> = {
    SRI_RECEPTION_URL: urls.reception,
    SRI_AUTHORISATION_URL: urls.authorisation,
    SRI_REQUEST_TIMEOUT_MS: urls.timeoutMs ?? 5000,
  };
  return new FetchSriWebService({
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env, true>);
}

describe('SRI-042 a SRI-050 el cliente del servicio web contra el doble local', () => {
  let double: SriDouble;
  let client: FetchSriWebService;

  beforeAll(async () => {
    double = await startSriDouble();
  });
  afterAll(async () => {
    await double.close();
  });
  beforeEach(() => {
    double.reset();
    client = clientFor({
      reception: double.receptionUrl,
      authorisation: double.authorisationUrl,
    });
  });

  it('SRI-054 sin las dos URL no está configurado', () => {
    expect(clientFor({ reception: double.receptionUrl }).isConfigured()).toBe(
      false,
    );
    expect(client.isConfigured()).toBe(true);
  });

  it('SRI-042 envía el XML en base64 en <xml> y lee RECIBIDA; luego autoriza con la clave y devuelve el comprobante', async () => {
    await expect(client.receive(SIGNED)).resolves.toEqual({
      kind: 'RECIBIDA',
      messages: [],
    });
    expect(double.callsFor(KEY, 'RECEPTION')).toHaveLength(1);

    const answer = await client.authorise(KEY);
    expect(answer.kind).toBe('AUTORIZADO');
    if (answer.kind !== 'AUTORIZADO') return;
    expect(answer.authorisationNumber).toBe(KEY);
    expect(answer.environmentLabel).toBe('PRUEBAS');
    expect(answer.voucherXml).toBe(SIGNED);
    expect(answer.authorisedAtText).toMatch(/-05:00$/);
    expect(answer.messages[0]).toMatchObject({
      identifier: '60',
      type: 'ADVERTENCIA',
    });
  });

  it('SRI-046 DEVUELTA 35 trae el identificador, el mensaje y la información adicional', async () => {
    double.setScenario(KEY, 'RETURNED_35');
    const answer = await client.receive(SIGNED);
    expect(answer).toEqual({
      kind: 'DEVUELTA',
      messages: [
        {
          identifier: '35',
          message: 'ARCHIVO NO CUMPLE ESTRUCTURA XML',
          additionalInformation:
            'Error de esquema simulado por el doble local del SRI',
          type: 'ERROR',
        },
      ],
    });
  });

  it('SRI-044 SRI-045 DEVUELTA 43 y DEVUELTA 70 llegan como tales, con su código', async () => {
    double.setScenario(KEY, 'ALREADY_REGISTERED_43');
    const registered = await client.receive(SIGNED);
    expect(
      registered.kind === 'DEVUELTA' && registered.messages[0]?.identifier,
    ).toBe('43');

    double.reset();
    double.setScenario(KEY, 'IN_PROCESS_70');
    const inProcess = await client.receive(SIGNED);
    expect(
      inProcess.kind === 'DEVUELTA' && inProcess.messages[0]?.identifier,
    ).toBe('70');
  });

  it('SRI-049 sin comprobantes para la clave todavía, la autorización es PENDING', async () => {
    double.setScenario(KEY, 'PENDING');
    await client.receive(SIGNED);
    await expect(client.authorise(KEY)).resolves.toEqual({ kind: 'PENDING' });
  });

  it('SRI-048 el «RECHAZADO» del ejemplo de la Ficha se lee como NO AUTORIZADO, con su motivo', async () => {
    double.setScenario(KEY, 'NOT_AUTHORISED');
    await client.receive(SIGNED);
    const answer = await client.authorise(KEY);
    expect(answer.kind).toBe('NO AUTORIZADO');
    expect(
      answer.kind === 'NO AUTORIZADO' && answer.messages[0]?.identifier,
    ).toBe('39');
  });

  it('SRI-050 el SRI caído (503) es fallo de transporte, nunca devolución', async () => {
    double.setDown(true);
    const reception = await client.receive(SIGNED);
    expect(reception.kind).toBe('TRANSPORT_FAILURE');
    expect(reception.kind === 'TRANSPORT_FAILURE' && reception.error).toMatch(
      /HTTP 503/,
    );
    expect((await client.authorise(KEY)).kind).toBe('TRANSPORT_FAILURE');
  });

  it('SRI-050 SRI-059 un cuerpo 200 que no es una respuesta (HTML) es fallo de transporte y se conserva entero', async () => {
    double.setScenario(KEY, 'GARBAGE');
    const answer = await client.receive(SIGNED);
    expect(answer.kind).toBe('TRANSPORT_FAILURE');
    if (answer.kind !== 'TRANSPORT_FAILURE') return;
    expect(answer.error).toContain('mantenimiento');
    expect(answer.response).toMatchObject({
      httpStatus: 200,
      faultString: null,
      responseBody: '<html>mantenimiento</html>',
    });
  });

  it('SRI-059 un 500 con soap:Fault largo (la forma de celcer) guarda estado, faultcode, faultstring y detail enteros', async () => {
    double.setScenario(KEY, 'FAULT_500');
    for (const answer of [
      await client.receive(SIGNED),
      await client.authorise(KEY),
    ]) {
      expect(answer.kind).toBe('TRANSPORT_FAILURE');
      if (answer.kind !== 'TRANSPORT_FAILURE') return;
      expect(LONG_FAULT_STRING.length).toBeGreaterThan(5000);
      expect(answer.response).toMatchObject({
        httpStatus: 500,
        faultCode: 'soap:Server',
        faultString: LONG_FAULT_STRING,
        faultDetail: LONG_FAULT_DETAIL,
      });
      expect(answer.response?.responseBody).toContain(LONG_FAULT_STRING);
      // The one-line reason carries the cause, not its first 200 characters.
      expect(answer.error).toBe(`HTTP 500 · soap:Server: ${LONG_FAULT_STRING}`);
      expect(answer.error).not.toMatch(/cortado/);
    }
  });

  it('SRI-059 un 500 con la página HTML de un proxy guarda el estado y el HTML tal como llegó', async () => {
    double.setScenario(KEY, 'HTML_500');
    const answer = await client.receive(SIGNED);
    expect(answer.kind).toBe('TRANSPORT_FAILURE');
    if (answer.kind !== 'TRANSPORT_FAILURE') return;
    expect(answer.response?.httpStatus).toBe(500);
    expect(answer.response?.faultString).toBeNull();
    expect(answer.response?.responseBody).toMatch(
      /^<html><head><title>500 Internal Server Error<\/title>.*<\/html>$/,
    );
    expect(answer.error).toMatch(/^HTTP 500: <html>/);
  });

  it('SRI-059 un cuerpo mayor que el tope se corta en 16 384 caracteres y el corte queda dicho', async () => {
    double.setScenario(KEY, 'HUGE_500');
    const answer = await client.receive(SIGNED);
    if (answer.kind !== 'TRANSPORT_FAILURE') throw new Error(answer.kind);
    const body = answer.response?.responseBody ?? '';
    const mark = /… \[cortado: (\d+) caracteres más\]$/.exec(body);
    expect(mark).not.toBeNull();
    const kept = body.slice(0, mark!.index);
    expect(kept).toHaveLength(16_384);
    // What was kept plus what the mark counts is what came.
    expect(kept.length + Number(mark![1])).toBe(
      '<html><body></body></html>'.length +
        'Error interno del servidor. '.length * 1500,
    );
  });

  it('SRI-059 si el SRI repite la petición firmada, no se guarda: ni el XML ni su base64', async () => {
    double.setScenario(KEY, 'ECHO_FAULT');
    const base64 = Buffer.from(SIGNED, 'utf8').toString('base64');
    const answer = await client.receive(SIGNED);
    if (answer.kind !== 'TRANSPORT_FAILURE') throw new Error(answer.kind);
    const stored = JSON.stringify(answer);
    // Positive control: the double did put the request in its answer.
    expect(double.callsFor(KEY, 'RECEPTION')).toHaveLength(1);
    expect(stored).not.toContain(base64);
    expect(stored).not.toContain(base64.slice(40, 140));
    expect(stored).not.toContain('<factura id="comprobante"');
    expect(stored).not.toContain('ds:Signature');
    expect(answer.response?.faultCode).toBe('soap:Client');
    expect(answer.response?.faultString).toBe(
      'No se pudo leer el comprobante [petición omitida]',
    );
    expect(answer.response?.responseBody).toContain('[petición omitida]');
  });

  it('SRI-059 un fault de SOAP 1.2 se lee igual: Code, Reason y Detail', async () => {
    const body =
      '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>' +
      '<env:Code><env:Value>env:Receiver</env:Value></env:Code>' +
      '<env:Reason><env:Text xml:lang="es">Base de datos no disponible</env:Text></env:Reason>' +
      '<env:Detail><causa>ORA-12541</causa></env:Detail>' +
      '</env:Fault></env:Body></env:Envelope>';
    const server: Server = createServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/soap+xml' });
      response.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/x`;
    const answer = await clientFor({
      reception: url,
      authorisation: url,
    }).authorise(KEY);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (answer.kind !== 'TRANSPORT_FAILURE') throw new Error(answer.kind);
    expect(answer.response).toEqual({
      httpStatus: 500,
      faultCode: 'env:Receiver',
      faultString: 'Base de datos no disponible',
      faultDetail: '<causa>ORA-12541</causa>',
      responseBody: body,
    });
  });

  it('SRI-050 una conexión rechazada es fallo de transporte', async () => {
    const closed = await startSriDouble();
    const url = closed.receptionUrl;
    await closed.close();
    const answer = await clientFor({
      reception: url,
      authorisation: url,
    }).receive(SIGNED);
    expect(answer.kind).toBe('TRANSPORT_FAILURE');
    // No answer came, so there is no answer to keep.
    expect(answer.kind === 'TRANSPORT_FAILURE' && answer.response).toBeNull();
  });

  it('SRI-042 SRI-050 un SRI que no contesta dentro del plazo es fallo de transporte, y no se espera más', async () => {
    const silent: Server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((resolve) =>
      silent.listen(0, '127.0.0.1', resolve),
    );
    const { port } = silent.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/x`;
    const started = performance.now();
    const answer = await clientFor({
      reception: url,
      authorisation: url,
      timeoutMs: 1000,
    }).receive(SIGNED);
    const elapsed = performance.now() - started;
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));

    expect(answer.kind).toBe('TRANSPORT_FAILURE');
    expect(elapsed).toBeLessThan(4000);
  });
});
