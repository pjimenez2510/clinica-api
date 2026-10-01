import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XMLParser } from 'fast-xml-parser';

import type { Env } from '../../../shared/config/env.schema';
import type { SriWebService } from '../domain/sri-web-service';
import type {
  AuthorisationAnswer,
  ReceptionAnswer,
  SriMessage,
} from '../domain/voucher-lifecycle';

/**
 * SRI-042, SRI-050. The two offline web services over `fetch` (D-A-019).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONTRACT, FROM THE FICHA v2.34 §7.2.3 (págs. 16–19)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   validarComprobante(@WebParam(name = "xml") byte[] xml)
 *     → RespuestaRecepcionComprobante { estado, comprobantes/comprobante/
 *       mensajes/mensaje { identificador, mensaje, informacionAdicional, tipo } }
 *   autorizacionComprobante(@WebParam(name = "claveAccesoComprobante") String)
 *     → RespuestaAutorizacionComprobante { claveAccesoConsultada,
 *       numeroComprobantes, autorizaciones/autorizacion { estado,
 *       numeroAutorizacion, fechaAutorizacion, ambiente, comprobante, mensajes } }
 *
 * Namespaces `http://ec.gob.sri.ws.recepcion` and `…ws.autorizacion`; SOAP 1.1.
 * `byte[]` travels as base64 (xs:base64Binary). The voucher comes back as a
 * CDATA section or as escaped text — the parser yields the same string.
 *
 * ⚠️ THE FICHA'S OWN EXAMPLE OF A REFUSAL SAYS `RECHAZADO`, while ADR-004 and
 * every implementation say `NO AUTORIZADO`. Both are read as a refusal; any
 * other `estado` (EN PROCESO) is «not yet».
 *
 * ⚠️ EVERY FAILURE TO GET AN ANSWER IS `TRANSPORT_FAILURE`, never an exception
 * and never a rejection: a timeout, a refused connection, a non-200 status, a
 * 302 (ADR-004 found one on the production query), a SOAP fault, or a body
 * without `estado`. The beginning of the body is kept so whoever connects to
 * the real SRI can see what it said (sri/SPEC.md §9, step 4).
 */
const RECEPTION_NS = 'http://ec.gob.sri.ws.recepcion';
const AUTHORISATION_NS = 'http://ec.gob.sri.ws.autorizacion';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  // Lists only where the SRI nests ELEMENTS: `<mensaje>` lives inside
  // `<mensaje>`, and the authorised `<comprobante>` is text — those two leaves
  // must stay strings.
  isArray: (name, _path, isLeafNode) =>
    !isLeafNode && ['comprobante', 'mensaje', 'autorizacion'].includes(name),
});

type Tree = Record<string, unknown>;

function child(node: unknown, name: string): unknown {
  return node !== null && typeof node === 'object'
    ? (node as Tree)[name]
    : undefined;
}

function list(node: unknown): unknown[] {
  if (node === undefined || node === null || node === '') return [];
  return Array.isArray(node) ? node : [node];
}

function text(node: unknown): string | null {
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  return null;
}

function messagesIn(container: unknown): SriMessage[] {
  return list(child(child(container, 'mensajes'), 'mensaje')).map((m) => ({
    identifier: text(child(m, 'identificador')) ?? '',
    message: text(child(m, 'mensaje')) ?? '',
    additionalInformation: text(child(m, 'informacionAdicional')),
    type: text(child(m, 'tipo')) ?? '',
  }));
}

function bodyOf(xml: string, response: string, result: string): unknown {
  const envelope = child(parser.parse(xml) as Tree, 'Envelope');
  return child(child(child(envelope, 'Body'), response), result);
}

class TransportFailure extends Error {}

@Injectable()
export class FetchSriWebService implements SriWebService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    // Truthiness and not `!== undefined`: `ConfigService` falls back to the
    // raw `process.env` when the validated value is undefined, so `KEY=`
    // arrives here as ''.
    return (
      Boolean(this.config.get('SRI_RECEPTION_URL', { infer: true })) &&
      Boolean(this.config.get('SRI_AUTHORISATION_URL', { infer: true }))
    );
  }

  async receive(signedXml: string): Promise<ReceptionAnswer> {
    try {
      const body = await this.call(
        this.config.get('SRI_RECEPTION_URL', { infer: true }),
        `<ec:validarComprobante xmlns:ec="${RECEPTION_NS}"><xml>${Buffer.from(signedXml, 'utf8').toString('base64')}</xml></ec:validarComprobante>`,
      );
      const answer = bodyOf(
        body,
        'validarComprobanteResponse',
        'RespuestaRecepcionComprobante',
      );
      const state = text(child(answer, 'estado'));
      const messages = list(
        child(child(answer, 'comprobantes'), 'comprobante'),
      ).flatMap(messagesIn);

      if (state === 'RECIBIDA') return { kind: 'RECIBIDA', messages };
      if (state === 'DEVUELTA') return { kind: 'DEVUELTA', messages };
      throw new TransportFailure(
        `unexpected reception body: ${body.slice(0, 300)}`,
      );
    } catch (error) {
      return { kind: 'TRANSPORT_FAILURE', error: describe(error) };
    }
  }

  async authorise(accessKey: string): Promise<AuthorisationAnswer> {
    try {
      const body = await this.call(
        this.config.get('SRI_AUTHORISATION_URL', { infer: true }),
        `<ec:autorizacionComprobante xmlns:ec="${AUTHORISATION_NS}"><claveAccesoComprobante>${accessKey}</claveAccesoComprobante></ec:autorizacionComprobante>`,
      );
      const answer = bodyOf(
        body,
        'autorizacionComprobanteResponse',
        'RespuestaAutorizacionComprobante',
      );
      if (answer === undefined) {
        throw new TransportFailure(
          `unexpected authorisation body: ${body.slice(0, 300)}`,
        );
      }

      // SRI-049. Several authorisations can come back for one key (a voucher
      // refused and later authorised): an AUTORIZADO among them wins.
      const authorisations = list(
        child(child(answer, 'autorizaciones'), 'autorizacion'),
      );
      const authorised = authorisations.find(
        (a) => text(child(a, 'estado')) === 'AUTORIZADO',
      );
      if (authorised) {
        const authorisedAtText =
          text(child(authorised, 'fechaAutorizacion')) ?? '';
        const authorisedAt = new Date(authorisedAtText);
        const voucherXml = text(child(authorised, 'comprobante'));
        if (Number.isNaN(authorisedAt.getTime()) || !voucherXml) {
          throw new TransportFailure(
            'authorised answer without date or voucher',
          );
        }
        return {
          kind: 'AUTORIZADO',
          authorisationNumber:
            text(child(authorised, 'numeroAutorizacion')) ?? accessKey,
          authorisedAt,
          authorisedAtText,
          environmentLabel: text(child(authorised, 'ambiente')) ?? '',
          voucherXml,
          messages: messagesIn(authorised),
        };
      }
      const refused = authorisations.find((a) =>
        ['NO AUTORIZADO', 'RECHAZADO'].includes(text(child(a, 'estado')) ?? ''),
      );
      if (refused)
        return { kind: 'NO AUTORIZADO', messages: messagesIn(refused) };
      return { kind: 'PENDING' };
    } catch (error) {
      return { kind: 'TRANSPORT_FAILURE', error: describe(error) };
    }
  }

  private async call(
    url: string | undefined,
    operation: string,
  ): Promise<string> {
    if (!url) throw new TransportFailure('web service URL not configured');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
      },
      body:
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
        `<soapenv:Header/><soapenv:Body>${operation}</soapenv:Body></soapenv:Envelope>`,
      // ADR-004: the production query answered 302. Followed, it would turn
      // into a GET with no body; refused, it is a transport failure to look at.
      redirect: 'manual',
      signal: AbortSignal.timeout(
        this.config.get('SRI_REQUEST_TIMEOUT_MS', { infer: true }),
      ),
    });
    const body = await response.text();
    if (response.status !== 200) {
      throw new TransportFailure(
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    return body;
  }
}

function describe(error: unknown): string {
  if (error instanceof TransportFailure) return error.message;
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return [error.name, error.message, cause]
      .filter(Boolean)
      .join(': ')
      .slice(0, 500);
  }
  return 'unknown transport failure';
}
