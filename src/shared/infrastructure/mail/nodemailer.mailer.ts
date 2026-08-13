import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../config/env.schema';
import {
  MailDeliveryFailedError,
  MailNotConfiguredError,
} from '../../mail/mail.errors';
import type { Mailer, MailMessage } from '../../mail/mail.port';

/**
 * The first thing in this system that sends an e-mail (D-013, AU-021).
 *
 * WHY NODEMAILER AND NOT SOMETHING ELSE. The alternatives considered were
 * (a) an HTTP client against a transactional provider — Resend, Postmark,
 * Brevo — and (b) `nodemailer`. The clinic runs on premises with its own mail
 * server and no decision has been taken about paying an external provider, so
 * a provider SDK would have committed to one; nodemailer speaks plain SMTP,
 * which is what both the on-premises server and every provider's relay accept.
 * It is also what Mailpit answers in development, so the same code path is
 * exercised locally. If a provider is chosen later, this file is replaced and
 * nothing above the port changes — which is the whole reason the port exists.
 *
 * THE TRANSPORT IS BUILT LAZILY AND CACHED. Building it in the constructor
 * would mean an installation with no `SMTP_HOST` either refuses to boot or
 * boots with a broken object; neither is right, and AU-029 says the refusal
 * belongs at the point of use.
 */
@Injectable()
export class NodemailerMailer implements Mailer {
  private transporter?: Transporter;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NodemailerMailer.name);
  }

  async send(message: MailMessage): Promise<void> {
    const from = this.config.get('SMTP_FROM', { infer: true });
    const transporter = this.transport();

    try {
      await transporter.sendMail({
        // `SMTP_FROM` is optional in the schema, and a message with no sender
        // is refused by every relay with a message nobody can act on. Falling
        // back to the host tells the operator which variable to fill in.
        from: from ?? `no-reply@${this.requireHost()}`,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      /**
       * LOGGED HERE AND RE-THROWN, not logged INSTEAD of thrown.
       *
       * The log is for whoever operates the system — it carries the reason the
       * relay gave, which the caller must never put in a response. The throw
       * is for the caller, which is the half that makes AU-029 possible: the
       * response can only say «la invitación no salió» if it was told.
       *
       * No interpolation and no recipient address: `log-privacy.ts` prunes by
       * allowlist and interpolating would walk straight past it.
       */
      this.logger.error(
        { err: error, error_code: 'MAIL_DELIVERY_FAILED' },
        'the SMTP server did not accept the message',
      );
      throw new MailDeliveryFailedError(error);
    }
  }

  /**
   * One transport, reused. Nodemailer pools nothing by default, but rebuilding
   * it per message re-resolves DNS and reopens a connection for every single
   * invitation.
   */
  private transport(): Transporter {
    if (this.transporter) return this.transporter;

    const host = this.requireHost();
    const port = this.config.get('SMTP_PORT', { infer: true });

    this.transporter = createTransport({
      host,
      port,
      /**
       * IMPLICIT TLS ONLY ON 465, which is what `secure` means in SMTP: 465 is
       * TLS from the first byte, 587 and 25 start in clear and upgrade with
       * STARTTLS. Hardcoding `true` would make development against Mailpit on
       * 1025 fail with a handshake error that says nothing about the cause.
       *
       * `requireTLS` on everything else so a server that offers STARTTLS is
       * never talked to in clear: the message carries a single-use credential
       * link, and a link read off the wire is an account taken over.
       */
      secure: port === 465,
      requireTLS: port !== 465 && !this.isLoopback(host),
      // A relay that hangs must not hold the request open until the global
      // timeout interceptor cuts it: a refused invitation is recoverable, a
      // stuck connection pool is not.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    return this.transporter;
  }

  /** AU-029. The refusal happens here, by name, and never at boot. */
  private requireHost(): string {
    const host = this.config.get('SMTP_HOST', { infer: true });
    if (!host) throw new MailNotConfiguredError();
    return host;
  }

  /**
   * Development against Mailpit, which speaks no TLS at all.
   *
   * Narrow on purpose: only the loopback address is exempt, so a real host
   * name never loses the requirement by accident. A production relay reachable
   * only over a private network still has to offer STARTTLS.
   */
  private isLoopback(host: string): boolean {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
}
