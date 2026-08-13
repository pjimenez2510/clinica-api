import type { Mailer, MailMessage } from '../../../src/shared/mail/mail.port';

/**
 * The mail port, in memory.
 *
 * ⚠️ NO TEST EVER OPENS AN SMTP CONNECTION. `test-env.ts` fills `SMTP_HOST`
 * with `not-a-real-host` so that a forgotten override fails loudly rather than
 * mysteriously, but «loudly» there means a DNS timeout ten seconds long,
 * repeated once per account created — and, on a developer's machine with
 * Mailpit running and a real `.env`, it would mean the suite silently sending
 * real messages. Every spec that boots `AppModule` and creates an account
 * overrides `MAILER` with this.
 *
 * It also makes the failure path testable, which is the point of AU-029: a
 * real relay cannot be asked to fail on command.
 */
export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  /** Set to make the next sends fail, exactly as the real adapter would. */
  failWith: Error | null = null;

  send(message: MailMessage): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The last message, which is the one a test has just caused. */
  last(): MailMessage | undefined {
    return this.sent.at(-1);
  }

  reset(): void {
    this.sent.length = 0;
    this.failWith = null;
  }

  /**
   * The token out of the link, the way the person's browser would take it.
   *
   * Reads the TEXT part on purpose: it is the one that is mandatory, and a
   * link that only survives in the HTML twin is a link some recipients cannot
   * follow.
   */
  tokenFromLast(): string {
    const text = this.last()?.text ?? '';
    const match = /\/acceso\/credencial\?token=([^\s]+)/.exec(text);
    if (!match?.[1]) {
      throw new Error(`No credential link in the last message: ${text}`);
    }
    return decodeURIComponent(match[1]);
  }
}
