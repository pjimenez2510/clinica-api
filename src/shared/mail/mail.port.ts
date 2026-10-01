/**
 * How a message leaves the building.
 *
 * A PORT, for the same reason `ACCESS_AUDIT_RECORDER` is one: «por dónde sale
 * el correo» is a decision that will change. Today it is the clinic's SMTP
 * relay — Mailpit in development; tomorrow it is a transactional provider with
 * an HTTP API, delivery receipts and a bounce webhook. What the use case
 * depends on is «this message was handed over», not «there is a TCP connection
 * to port 587».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ITS FAILURE POLICY IS THE OPPOSITE OF THE AUDIT PORT'S, ON PURPOSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AccessAuditRecorder.record` must NOT throw into the caller: refusing to show
 * a doctor a chart because the audit table is unreachable is the wrong trade in
 * a clinic, so the adapter logs at error level and the request continues.
 *
 * Here that reasoning inverts. A credential e-mail that fails silently leaves a
 * person unable to enter the system with NOBODY aware of it: the administrator
 * saw a green «cuenta creada», the new employee never received anything, and
 * the two only find out on Monday when she cannot open the agenda. There is no
 * later signal — unlike a missing audit row, which at least an audit would
 * eventually surface.
 *
 * So `send` REPORTS FAILURE to its caller, and the caller decides. For the
 * account-creation flow the decision is written down in AU-029: the account is
 * still created and the response says the invitation did not leave, so the
 * screen can offer to send it again. What must never happen is the failure
 * being swallowed here.
 */

/** A file travelling with a message (SRI-072: the RIDE and the XML). */
export interface MailAttachment {
  fileName: string;
  content: Buffer;
  contentType: string;
}

/** One message. */
export interface MailMessage {
  /** A single institutional address. Bulk sending is not this port's job. */
  to: string;
  subject: string;
  /**
   * The message, in plain text. MANDATORY and not a fallback: it is what a
   * screen reader, a terminal client and a suspicious mail filter all read,
   * and a message whose meaning only survives in HTML is a message half the
   * recipients cannot act on.
   */
  text: string;
  /** The same content in minimal HTML, for clients that prefer it. */
  html?: string;
  attachments?: readonly MailAttachment[];
}

/**
 * Outbound mail, with the OPPOSITE failure policy to the audit recorder: it
 * throws. See `send`.
 */
export interface Mailer {
  /**
   * Hands one message over for delivery.
   *
   * THROWS on failure — `MailNotConfiguredError` when the installation has no
   * SMTP server, `MailDeliveryFailedError` when the server refused or was
   * unreachable. Both are the caller's to handle; see the note above for why
   * they are not logged and hidden.
   *
   * Success means the SMTP server ACCEPTED the message, which is not the same
   * as the person receiving it: a later bounce is invisible from here. Nothing
   * in this system depends on the difference yet, and pretending otherwise
   * would be a promise the transport cannot keep.
   */
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('Mailer');
