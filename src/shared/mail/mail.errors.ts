import { ExternalServiceError } from '../domain/errors/domain-error';

/**
 * What can go wrong when a message is handed over.
 *
 * BESIDE THE PORT AND NOT INSIDE THE ADAPTER. They are part of what `send`
 * promises — the caller branches on them to decide whether the invitation left
 * — so an adapter defining them would mean swapping SMTP for a transactional
 * provider silently moves the contract with the rest of the system. Same rule
 * already applied in `auth.errors.ts`: infrastructure THROWS these, it does not
 * define them.
 *
 * Both are `ExternalServiceError` because that is what they are: a third-party
 * system that is missing or that refused. `isRetryable` is what tells the two
 * apart for the HTTP layer, and the distinction is real — a relay that timed
 * out may work in a minute, an installation with no `SMTP_HOST` will not.
 */

/**
 * AU-029 — the installation has no mail server configured.
 *
 * FAILS HERE AND NOT AT BOOT, deliberately. `SMTP_HOST` is optional in the
 * environment schema, so a clinic that never creates an account from the
 * application still starts. Requiring it at startup would make a feature
 * nobody uses able to keep the whole API down, and a fail-fast that cries wolf
 * is one people learn to work around by inventing a value — which produces the
 * far worse failure of an invitation that «se envió» to a server that does not
 * exist.
 *
 * The sentence names the variable. Whoever reads it is the person deploying
 * the system, and «error al enviar el correo» would send them looking in the
 * wrong place.
 */
export class MailNotConfiguredError extends ExternalServiceError {
  readonly code = 'MAIL_NOT_CONFIGURED';
  readonly service = 'smtp';
  /** Retrying changes nothing: the configuration has to be written first. */
  readonly isRetryable = false;
  override readonly userTitle =
    'El sistema no tiene servidor de correo configurado, así que no puede enviar la invitación. Avise a quien administra la instalación: falta SMTP_HOST';

  constructor() {
    super('SMTP_HOST is not configured; no mail can be sent');
  }
}

/**
 * AU-029 — the server was there and the message did not go through.
 *
 * The underlying reason is kept in `cause` for the logs and NEVER in the
 * message that reaches the user: an SMTP rejection quotes the recipient
 * address back, and that address is personal data belonging to somebody who
 * did not ask this question.
 */
export class MailDeliveryFailedError extends ExternalServiceError {
  readonly code = 'MAIL_DELIVERY_FAILED';
  readonly service = 'smtp';
  /** A relay that timed out or refused momentarily may well work next time. */
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo enviar el correo. La cuenta quedó creada: vuelva a enviar la invitación cuando el servidor de correo responda';

  constructor(cause?: unknown) {
    super('The SMTP server did not accept the message');
    this.cause = cause;
  }
}
