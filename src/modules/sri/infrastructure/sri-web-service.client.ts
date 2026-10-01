import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XMLParser } from 'fast-xml-parser';

import type { Env } from '../../../shared/config/env.schema';
import { capped as cutToLimit } from '../domain/kept-text';
import type { SriWebService } from '../domain/sri-web-service';
import type {
  AuthorisationAnswer,
  ReceptionAnswer,
  SriFailedResponse,
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
 * without `estado`.
 *
 * SRI-059. WHAT THE SRI SAID IS KEPT WHOLE: its status, the fault's code,
 * string and detail, and the body, each up to 16 384 characters with any cut
 * marked. On 01-10-2026 celcer answered a 500 whose cause sat past character
 * 200, where the old cut was. The REQUEST is never kept: if the answer
 * repeats the signed XML or its base64, it is replaced by a mark first.
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

/** `undefined` when the body is not that answer — not even XML (SRI-050). */
function bodyOf(xml: string, response: string, result: string): unknown {
  let tree: Tree;
  try {
    tree = parser.parse(xml) as Tree;
  } catch {
    return undefined;
  }
  const envelope = child(tree, 'Envelope');
  return child(child(child(envelope, 'Body'), response), result);
}

/** SRI-059. Each kept text's ceiling; the database allows it plus the mark. */
export const KEPT_TEXT_LIMIT = 16_384;
const SUMMARY_LIMIT = 500;
/** A fault code is a qualified name; anything longer is not one. */
const FAULT_CODE_LIMIT = 256;
const REQUEST_MARK = '[petición omitida]';
const VOUCHER_MARK = '[comprobante omitido]';
/** Below this, a shared run of base64 can be chance; above, it is an echo. */
const ECHO_WINDOW = 64;

/** Cut at `limit` with the mark (domain/kept-text.ts). */
const capped = (text: string, limit = KEPT_TEXT_LIMIT) =>
  cutToLimit(text, limit);

/** PostgreSQL refuses 0x00 in TEXT: the attempt would not be kept at all. */
const withoutNul = (text: string) => text.replaceAll('\u0000', '\uFFFD');

/** What was sent and must never be kept (SRI-059). */
interface SentRequest {
  base64: string;
  xml: string;
  /** Every 64-character piece of the base64, to find a partial echo. */
  windows: Set<string>;
}

function sentRequest(xml: string, base64: string): SentRequest {
  const windows = new Set<string>();
  for (let i = 0; i + ECHO_WINDOW <= base64.length; i++) {
    windows.add(base64.slice(i, i + ECHO_WINDOW));
  }
  return { base64, xml, windows };
}

/**
 * SRI-059. The request out of a text: the signed XML raw, escaped as an
 * attribute or as text content, and its base64 — whole, or any piece of it
 * long enough not to be chance, even glued to other characters (`xml=PD94…`).
 */
function withoutRequest(text: string, request: SentRequest | null): string {
  if (!request) return text;
  let clean = text;
  const asText = request.xml
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  for (const sent of [
    request.base64,
    request.xml,
    asText,
    asText.replace(/"/g, '&quot;'),
  ]) {
    if (sent.length > 0) clean = clean.split(sent).join(REQUEST_MARK);
  }
  return clean.replace(/[A-Za-z0-9+/=]{64,}/g, (run) => {
    let first = -1;
    let last = -1;
    for (let i = 0; i + ECHO_WINDOW <= run.length; i++) {
      if (request.windows.has(run.slice(i, i + ECHO_WINDOW))) {
        if (first < 0) first = i;
        last = i + ECHO_WINDOW;
      }
    }
    return first < 0
      ? run
      : `${run.slice(0, first)}${REQUEST_MARK}${run.slice(last)}`;
  });
}

/**
 * SRI-059. An authorisation that is not one may still carry the signed
 * voucher in `<comprobante>`: it is the request, and it is not kept.
 */
const withoutVoucher = (body: string) =>
  body.replace(
    /(<(?:[\w.-]+:)?comprobante\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?comprobante\s*>)/g,
    `$1${VOUCHER_MARK}$2`,
  );

const DETAIL =
  /<(?:[\w.-]+:)?detail\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?detail\s*>/i;

/** SRI-059. The `Fault` of SOAP 1.1 (`faultcode`…) or 1.2 (`Code/Value`…). */
function readFault(body: string) {
  let fault: unknown;
  try {
    const envelope = child(parser.parse(body) as Tree, 'Envelope');
    fault = child(child(envelope, 'Body'), 'Fault');
  } catch {
    fault = undefined;
  }
  if (fault === undefined) return null;
  const code =
    text(child(fault, 'faultcode')) ??
    text(child(child(fault, 'Code'), 'Value'));
  const reason =
    text(child(fault, 'faultstring')) ??
    text(child(child(fault, 'Reason'), 'Text'));
  return {
    faultCode: code,
    faultString: reason,
    faultDetail: DETAIL.exec(body)?.[1]?.trim() || null,
  };
}

function failedResponse(
  httpStatus: number,
  body: string,
  request: SentRequest | null,
  options: { omitVoucher?: boolean } = {},
): SriFailedResponse {
  let clean = withoutNul(body);
  if (options.omitVoucher) clean = withoutVoucher(clean);
  clean = withoutRequest(clean, request);
  const fault = readFault(clean);
  // The parser decodes entities: what was escaped in the body may be the
  // request again once read, so the read texts are cleaned too.
  const kept = (value: string | null | undefined, limit = KEPT_TEXT_LIMIT) =>
    value ? capped(withoutRequest(withoutNul(value), request), limit) : null;
  return {
    httpStatus,
    faultCode: kept(fault?.faultCode, FAULT_CODE_LIMIT),
    faultString: kept(fault?.faultString),
    faultDetail: kept(fault?.faultDetail),
    responseBody: capped(clean),
  };
}

class TransportFailure extends Error {
  constructor(
    message: string,
    readonly response: SriFailedResponse | null = null,
  ) {
    super(message);
  }

  /** SRI-059. An answer that was not one, with what it said. */
  static of(
    response: SriFailedResponse,
    what = `HTTP ${response.httpStatus}`,
  ): TransportFailure {
    const reason =
      response.faultString === null
        ? `${what}: ${capped(response.responseBody, SUMMARY_LIMIT)}`
        : // Whole, but within the ceiling the database keeps (SRI-059).
          capped(
            `${what} · ${response.faultCode ?? 'sin faultcode'}: ${response.faultString}`,
          );
    return new TransportFailure(reason, response);
  }
}

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
    const base64 = Buffer.from(signedXml, 'utf8').toString('base64');
    const request = sentRequest(signedXml, base64);
    try {
      const body = await this.call(
        this.config.get('SRI_RECEPTION_URL', { infer: true }),
        `<ec:validarComprobante xmlns:ec="${RECEPTION_NS}"><xml>${base64}</xml></ec:validarComprobante>`,
        request,
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
      throw TransportFailure.of(
        failedResponse(200, body, request),
        'unexpected reception body',
      );
    } catch (error) {
      return transportFailure(error);
    }
  }

  async authorise(accessKey: string): Promise<AuthorisationAnswer> {
    try {
      const body = await this.call(
        this.config.get('SRI_AUTHORISATION_URL', { infer: true }),
        `<ec:autorizacionComprobante xmlns:ec="${AUTHORISATION_NS}"><claveAccesoComprobante>${accessKey}</claveAccesoComprobante></ec:autorizacionComprobante>`,
        null,
      );
      const answer = bodyOf(
        body,
        'autorizacionComprobanteResponse',
        'RespuestaAutorizacionComprobante',
      );
      if (answer === undefined) {
        throw TransportFailure.of(
          failedResponse(200, body, null, { omitVoucher: true }),
          'unexpected authorisation body',
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
          throw TransportFailure.of(
            failedResponse(200, body, null, { omitVoucher: true }),
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
      // SRI-048. Of several refusals, the most recent; its date lets the
      // lifecycle tell an old one, from before a re-send, from the answer.
      const refusals = authorisations
        .filter((a) =>
          ['NO AUTORIZADO', 'RECHAZADO'].includes(
            text(child(a, 'estado')) ?? '',
          ),
        )
        .map((a) => {
          const at = new Date(text(child(a, 'fechaAutorizacion')) ?? '');
          return {
            node: a,
            decidedAt: Number.isNaN(at.getTime()) ? null : at,
          };
        })
        .sort(
          (x, y) =>
            (y.decidedAt?.getTime() ?? 0) - (x.decidedAt?.getTime() ?? 0),
        );
      const refused = refusals[0];
      if (refused) {
        return {
          kind: 'NO AUTORIZADO',
          decidedAt: refused.decidedAt,
          voucherXml: text(child(refused.node, 'comprobante')) ?? null,
          messages: messagesIn(refused.node),
        };
      }
      return { kind: 'PENDING' };
    } catch (error) {
      return transportFailure(error);
    }
  }

  /** `request`: what was sent that must never be kept (SRI-059). */
  private async call(
    url: string | undefined,
    operation: string,
    request: SentRequest | null,
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
      throw TransportFailure.of(
        // An authorisation (no request to strip) may carry the voucher.
        failedResponse(response.status, body, request, {
          omitVoucher: request === null,
        }),
      );
    }
    return body;
  }
}

function transportFailure(error: unknown) {
  if (error instanceof TransportFailure) {
    return {
      kind: 'TRANSPORT_FAILURE' as const,
      error: error.message,
      response: error.response,
    };
  }
  return {
    kind: 'TRANSPORT_FAILURE' as const,
    error: describe(error),
    response: null,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return capped(
      withoutNul([error.name, error.message, cause].filter(Boolean).join(': ')),
      SUMMARY_LIMIT,
    );
  }
  return 'unknown transport failure';
}
