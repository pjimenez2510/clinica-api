/**
 * SRI-043 to SRI-052. What each answer of the SRI does to a voucher, as pure
 * functions. The queue, the HTTP client and the database only carry it out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO RULES THAT CANNOT BE GOT WRONG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **43 and 70 are not rejections.** 43 — «clave de acceso registrada» — is
 *    what a retry after a network timeout receives when the SRI did store the
 *    voucher; 70 — «en procesamiento» — forbids re-sending until there is an
 *    answer (Ficha v2.34, Note 2). Both go to AUTHORISATION with the same key.
 *    The reference implementation the author shared treats both as a final
 *    DEVUELTA: that is the bug this file exists not to have.
 *
 * 2. **A body that is not an answer is a transport failure.** An HTML error
 *    page, a 302, a SOAP fault, an envelope without `estado`: none of them is
 *    «DEVUELTA». Treating them as one would park a voucher the SRI never saw.
 */

export type VoucherStatus =
  | 'PREPARED'
  | 'SIGNED'
  | 'RECEIVED'
  | 'AUTHORISED'
  | 'RETURNED'
  | 'NOT_AUTHORISED';

/** Why a PREPARED voucher is not moving: a local reason, never the SRI's. */
export type BlockedReason =
  | 'NO_CERTIFICATE'
  | 'CERTIFICATE_NOT_VALID'
  | 'CERTIFICATE_UNREADABLE'
  | 'CERTIFICATE_STORE_NOT_CONFIGURED'
  | 'NO_PAYMENT_METHOD'
  | 'MISSING_ISSUER_DATA'
  | 'SIGNING_FAILED';

/**
 * SRI-056, SRI-084. What loading a certificate can fix. The sweep leaves these
 * alone —retrying them every minute would record an opening and derive a key
 * for nothing— and the upload releases them (`unblockForCertificate`).
 */
export const CERTIFICATE_REASONS: readonly BlockedReason[] = [
  'NO_CERTIFICATE',
  'CERTIFICATE_NOT_VALID',
  'CERTIFICATE_UNREADABLE',
  'SIGNING_FAILED',
];

/**
 * SRI-056. What the sweep retries: what nobody blocked, and what is fixed by
 * editing the issuer's data or the server's configuration. `NO_PAYMENT_METHOD`
 * is never fixed: the invoice cannot change (BI-170), and the monitor says so.
 */
export const SWEPT_REASONS: readonly BlockedReason[] = [
  'MISSING_ISSUER_DATA',
  'CERTIFICATE_STORE_NOT_CONFIGURED',
];

/** One message of the SRI, as its web service returns it. */
export interface SriMessage {
  identifier: string;
  message: string;
  additionalInformation: string | null;
  /** `ERROR`, `ADVERTENCIA` or `INFORMATIVO`. */
  type: string;
}

export type ReceptionAnswer =
  | { kind: 'RECIBIDA'; messages: SriMessage[] }
  | { kind: 'DEVUELTA'; messages: SriMessage[] }
  | { kind: 'TRANSPORT_FAILURE'; error: string };

export type AuthorisationAnswer =
  | {
      kind: 'AUTORIZADO';
      authorisationNumber: string;
      authorisedAt: Date;
      /** `fechaAutorizacion` exactly as the SRI wrote it, offset included. */
      authorisedAtText: string;
      /** `PRUEBAS` or `PRODUCCIÓN`, as the SRI words it. */
      environmentLabel: string;
      /** The signed voucher the SRI returns, already unescaped. */
      voucherXml: string;
      messages: SriMessage[];
    }
  | {
      kind: 'NO AUTORIZADO';
      /** `fechaAutorizacion` of the refusal; `null` if it did not parse. */
      decidedAt: Date | null;
      messages: SriMessage[];
    }
  | { kind: 'PENDING' }
  | { kind: 'TRANSPORT_FAILURE'; error: string };

export type QueueStep = 'SEND' | 'AUTHORISE' | 'DELIVER';

/** The SRI's two «already sent» codes (ADR-004 §3). */
export const ALREADY_SENT_CODES = new Set(['43', '70']);
const IN_PROCESS_CODE = '70';

/** What an answer changes, for the repository to apply in one transaction. */
export interface VoucherTransition {
  status: VoucherStatus;
  /** The invoice follows the voucher only where the SRI decided something. */
  invoiceStatus: 'AUTHORISED' | 'REJECTED' | null;
  /** Kept on the voucher for the monitor; `null` leaves them as they were. */
  lastMessages: SriMessage[] | null;
  /** The next job, or none when a person has to act. */
  next: { step: QueueStep; delaySeconds: number } | null;
}

/**
 * SRI-052. Growing waits with a ceiling: 30 s, 1 min, 2 min … up to 1 h.
 * `attempt` counts from 1.
 */
export function retryDelaySeconds(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(30 * 2 ** exponent, 3600);
}

/** The first look for the authorisation, a few seconds after RECIBIDA. */
export const FIRST_AUTHORISATION_DELAY_SECONDS = 3;

/** SRI-043 to SRI-046, SRI-050. */
export function afterReception(
  current: VoucherStatus,
  answer: ReceptionAnswer,
  attempt: number,
): VoucherTransition {
  switch (answer.kind) {
    case 'RECIBIDA':
      return {
        status: 'RECEIVED',
        invoiceStatus: null,
        lastMessages: answer.messages,
        next: {
          step: 'AUTHORISE',
          delaySeconds: FIRST_AUTHORISATION_DELAY_SECONDS,
        },
      };
    case 'DEVUELTA': {
      // A warning or an informative message beside a 43 does not make it a
      // rejection: decide on the errors, when the SRI marked any.
      const errors = answer.messages.filter(
        (m) => m.type.toUpperCase() === 'ERROR',
      );
      const decisive = errors.length > 0 ? errors : answer.messages;
      const codes = new Set(decisive.map((m) => m.identifier));
      const onlyAlreadySent =
        codes.size > 0 &&
        [...codes].every((code) => ALREADY_SENT_CODES.has(code));
      if (onlyAlreadySent) {
        // SRI-044, SRI-045. Same key, ask for the authorisation; with 70 the
        // SRI is still working, so give it time.
        return {
          status: 'RECEIVED',
          invoiceStatus: null,
          lastMessages: answer.messages,
          next: {
            step: 'AUTHORISE',
            delaySeconds: codes.has(IN_PROCESS_CODE)
              ? retryDelaySeconds(attempt)
              : FIRST_AUTHORISATION_DELAY_SECONDS,
          },
        };
      }
      // SRI-046. Nothing that repeating fixes.
      return {
        status: 'RETURNED',
        invoiceStatus: 'REJECTED',
        lastMessages: answer.messages,
        next: null,
      };
    }
    case 'TRANSPORT_FAILURE':
      // SRI-050. The status stays; same key, same bytes, later.
      return {
        status: current,
        invoiceStatus: null,
        lastMessages: null,
        next: { step: 'SEND', delaySeconds: retryDelaySeconds(attempt) },
      };
  }
}

/** SRI-047 to SRI-050. */
export function afterAuthorisation(
  answer: AuthorisationAnswer,
  attempt: number,
  /**
   * When the voucher now at the SRI was signed. A refusal decided before it
   * is the one that led a person to re-send (SRI-058): the SRI keeps every
   * authorisation of the key, so it comes back next to the new answer.
   */
  signedAt: Date | null = null,
): VoucherTransition {
  if (
    answer.kind === 'NO AUTORIZADO' &&
    answer.decidedAt !== null &&
    signedAt !== null &&
    answer.decidedAt.getTime() < signedAt.getTime()
  ) {
    return afterAuthorisation({ kind: 'PENDING' }, attempt);
  }
  switch (answer.kind) {
    case 'AUTORIZADO':
      return {
        status: 'AUTHORISED',
        invoiceStatus: 'AUTHORISED',
        lastMessages: answer.messages,
        next: { step: 'DELIVER', delaySeconds: 0 },
      };
    case 'NO AUTORIZADO':
      return {
        status: 'NOT_AUTHORISED',
        invoiceStatus: 'REJECTED',
        lastMessages: answer.messages,
        next: null,
      };
    case 'PENDING':
    case 'TRANSPORT_FAILURE':
      // SRI-049, SRI-050. Never re-sent from here: 70 forbids it, and a
      // RECEIVED voucher is one the SRI has.
      return {
        status: 'RECEIVED',
        invoiceStatus: null,
        lastMessages: null,
        next: { step: 'AUTHORISE', delaySeconds: retryDelaySeconds(attempt) },
      };
  }
}

/** SRI-074. Never sooner than ten minutes, never later than six hours. */
const DELIVERY_RETRY_FLOOR_SECONDS = 600;
const DELIVERY_RETRY_CEILING_SECONDS = 6 * 3600;

/**
 * SRI-074. The e-mail's next try waits as long as it has already been
 * failing since the authorisation: ten minutes, then about twice as long each
 * time, capped at six hours. An SMTP down for a day costs a dozen attempts —
 * each issuing a RIDE— instead of one every ten minutes.
 */
export function deliveryRetrySeconds(
  authorisedAt: Date | null,
  now: Date,
): number {
  const elapsed =
    authorisedAt === null
      ? 0
      : Math.floor((now.getTime() - authorisedAt.getTime()) / 1000);
  return Math.min(
    DELIVERY_RETRY_CEILING_SECONDS,
    Math.max(DELIVERY_RETRY_FLOOR_SECONDS, elapsed),
  );
}

/** SRI-058. Only what the SRI returned or refused is retried by a person. */
export function isRetriableByAPerson(status: VoucherStatus): boolean {
  return status === 'RETURNED' || status === 'NOT_AUTHORISED';
}

/**
 * SRI-062. What needs somebody comes first; what the queue will resolve on its
 * own comes after.
 */
export function needsAPerson(status: VoucherStatus | 'NO_VOUCHER'): boolean {
  return (
    status === 'NO_VOUCHER' ||
    status === 'PREPARED' ||
    status === 'RETURNED' ||
    status === 'NOT_AUTHORISED'
  );
}

/** SRI-073. The authorisation document the customer receives. */
export function authorisationDocument(answer: {
  authorisationNumber: string;
  authorisedAtText: string;
  environmentLabel: string;
  voucherXml: string;
}): string {
  // A CDATA section cannot contain its own terminator; a signed voucher never
  // does, but splitting it keeps the document well-formed whatever arrives.
  const voucher = answer.voucherXml.replace(/]]>/g, ']]]]><![CDATA[>');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<autorizacion>' +
    '<estado>AUTORIZADO</estado>' +
    `<numeroAutorizacion>${answer.authorisationNumber}</numeroAutorizacion>` +
    `<fechaAutorizacion>${answer.authorisedAtText}</fechaAutorizacion>` +
    `<ambiente>${answer.environmentLabel}</ambiente>` +
    `<comprobante><![CDATA[${voucher}]]></comprobante>` +
    '<mensajes/>' +
    '</autorizacion>'
  );
}
