import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { MAILER, type Mailer } from '../../../shared/mail/mail.port';
import type { ClientContext } from '../../../shared/request/client-context';
import { InvalidCredentialTokenError, UserNotFoundError } from '../domain/auth.errors'; // prettier-ignore
import {
  credentialInvitationExpiry,
  isCredentialInvitationUsable,
} from '../domain/credential-invitation';
import {
  buildCredentialInvitationMessage,
  credentialInvitationLink,
} from '../domain/credential-invitation-email';
import { assertValidPassword } from '../domain/password-policy';

import { AuthAdminAuditTrail, type Requester } from './auth-admin-audit.trail';
import {
  CREDENTIAL_INVITATION_REPOSITORY,
  type CredentialInvitationRepositoryPort,
  CREDENTIAL_TOKENS,
  type CredentialTokenPort,
  WEB_BASE_URL,
} from './credential-ports';
import { PASSWORD_HASHER, type PasswordHasherPort } from './ports';

/** What issuing an invitation tells the caller. */
export interface IssuedInvitation {
  /**
   * AU-029. `false` means the account exists and the message did not leave —
   * no mail server, or one that refused. The screen has to be able to say so:
   * a green «cuenta creada» over a person who will never receive anything is
   * the failure this flag exists to make impossible.
   */
  sent: boolean;
  /** When the link stops working. Travels so the screen can say the date. */
  expiresAt: Date;
}

/**
 * The first credential of an account (AU-021, AU-026..AU-029, D-013).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ITS OWN SERVICE, AND NOT THREE MORE METHODS ON `AccountsService`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-008 §2 splits a service when it crosses any of three lines, and this
 * crosses two of them. `AccountsService` already has eight public use cases,
 * which is the limit; and the two change for genuinely different reasons —
 * that one for how a person is hired and let go, this one for how a credential
 * is delivered, which is a decision (D-013) that has already been reopened
 * once and names email today and something else tomorrow.
 *
 * The dependencies barely overlap, which is the third line: nothing here needs
 * roles, grants or the deactivation rules, and nothing there needs a mailer, a
 * password hasher or the password policy.
 *
 * ⚠️ THE HALF THAT IS PUBLIC. `redeem` and `check` answer an ANONYMOUS caller
 * — that is the whole point, since somebody who cannot sign in has no other
 * channel — so everything they can reveal is attack surface. Both answer the
 * same thing for an unknown, a spent and an expired token, and neither
 * confirms that an account exists.
 */
@Injectable()
export class CredentialInvitationsService {
  constructor(
    @Inject(CREDENTIAL_INVITATION_REPOSITORY)
    private readonly invitations: CredentialInvitationRepositoryPort,
    @Inject(CREDENTIAL_TOKENS)
    private readonly tokens: CredentialTokenPort,
    @Inject(PASSWORD_HASHER)
    private readonly hasher: PasswordHasherPort,
    @Inject(MAILER)
    private readonly mailer: Mailer,
    @Inject(WEB_BASE_URL)
    private readonly webBaseUrl: string,
    private readonly trail: AuthAdminAuditTrail,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CredentialInvitationsService.name);
  }

  /**
   * AU-021, AU-026, AU-027, AU-029. Issues a link and tries to send it.
   *
   * THE ORDER IS THE REQUIREMENT. The invitation is written FIRST and the
   * message is sent afterwards, so:
   *
   *   - a link sent by mistake stops working the moment a new one is issued,
   *     even if the new message never leaves (AU-027). Sending first and
   *     writing after would leave the old link alive whenever the send failed,
   *     which is the exact situation somebody re-sends to fix;
   *   - a failure to send is REPORTED, not swallowed, and the caller keeps the
   *     account (AU-029). The mail port throws on purpose — see its own
   *     comment for why its policy is the opposite of the audit port's — and
   *     this is the one place that catches it, because this is the only place
   *     that knows the account must survive.
   *
   * The token exists in memory for the length of this method and nowhere else:
   * it is not returned, not logged and not stored. Only its hash is written.
   *
   * THE SAME METHOD SERVES THE RE-SEND, and there is no second path. The
   * situations that need one — the mail server was down when the person was
   * hired, the address was mistyped, the link expired over a long weekend —
   * are all «invalidate whatever exists and issue a new one», which is exactly
   * what this does. A separate «resend» that skipped the invalidation would be
   * the bug AU-027 exists to prevent: the mistyped address is precisely the
   * case where the old link is sitting in a stranger's mailbox.
   *
   * It refuses on an account that does not exist and on nothing else. It does
   * NOT refuse an account that already has a password: somebody who forgot
   * theirs and has no second factor to recover with is the case a clinic hits
   * first, and redeeming the invitation cuts their open sessions. What this
   * must never become is a way for an administrator to LEARN a password, and
   * it is not — the token never reaches them.
   */
  async issue(userId: string, requester: Requester): Promise<IssuedInvitation> {
    const recipient = await this.invitations.recipient(
      userId,
      requester.userId,
    );
    if (!recipient) throw new UserNotFoundError();

    const now = new Date();
    const expiresAt = credentialInvitationExpiry(now);
    const { token, hash } = this.tokens.generate();

    await this.invitations.supersedeAndIssue({
      userId,
      tokenHash: hash,
      expiresAt,
      createdById: requester.userId,
      now,
    });

    // AU-025: that an invitation was issued is in the trail. WHAT is never
    // there — the shape of `AuthAdminAuditTrail.record` has nowhere to put a
    // token, which is what makes that true rather than remembered.
    await this.trail.record('UPDATE', userId, requester);

    const message = buildCredentialInvitationMessage({
      recipientName: `${recipient.firstName} ${recipient.lastName}`.trim(),
      // «Quien administra el sistema» when no author is recorded: the sentence
      // still has to say who invited them, and a blank there reads as broken.
      inviterName: recipient.inviterName ?? 'Quien administra el sistema',
      clinicName: recipient.clinicName,
      link: credentialInvitationLink(this.webBaseUrl, token),
    });

    try {
      await this.mailer.send({
        to: recipient.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      /**
       * CAUGHT HERE AND NOWHERE ELSE (AU-029).
       *
       * Letting it out would fail the whole request, and the account —
       * already created, already granted its roles — would look to the
       * administrator like something that did not happen. They would create
       * it again and hit `EMAIL_ALREADY_REGISTERED`, which explains nothing
       * about a mail server.
       *
       * `error` and not an interpolated message: `log-privacy.ts` prunes by
       * allowlist, and an interpolated recipient address walks past it.
       */
      this.logger.error(
        { err: error, user_id: userId, action: 'CREDENTIAL_INVITATION_UNSENT' },
        'the credential invitation could not be sent',
      );
      return { sent: false, expiresAt };
    }

    this.logger.info(
      { user_id: userId, action: 'CREDENTIAL_INVITATION_SENT' },
      'credential invitation sent',
    );
    return { sent: true, expiresAt };
  }

  /**
   * AU-028. Whether a link is still worth showing a password field for.
   *
   * Answers a plain boolean and never an error, so the page can say «este
   * enlace ya no sirve» BEFORE asking somebody to think of a password. The
   * three ways of not being usable are indistinguishable from out here, which
   * is the point: this endpoint is public and the token is the secret.
   */
  async check(
    token: string,
  ): Promise<{ valid: boolean; expiresAt: Date | null }> {
    // prettier-ignore
    const invitation = await this.invitations.findByTokenHash(
      this.tokens.hash(token),
    );

    if (!invitation || !isCredentialInvitationUsable(invitation, new Date())) {
      // Same shape for all three. `expiresAt` is withheld too: an expiry date
      // would confirm the token existed.
      return { valid: false, expiresAt: null };
    }

    return { valid: true, expiresAt: invitation.expiresAt };
  }

  /**
   * AU-021, AU-028. Sets the password the person chose and spends the link.
   *
   * THE POLICY IS THE SAME ONE `changePassword` APPLIES, imported and not
   * re-stated: `assertValidPassword` needs the owner's own data to refuse a
   * password containing their name, email or cedula, and a second copy of
   * those rules would drift into a weaker one on the path that is reachable
   * WITHOUT authentication — which is the worse of the two.
   *
   * The order is validate, then hash, then claim. Hashing before validating
   * would spend ~100 ms of Argon2 on input already known to be refused, on a
   * public endpoint, which is a free amplifier for anybody sending short
   * passwords in bulk.
   */
  async redeem(
    token: string,
    password: string,
    ctx: ClientContext = {},
  ): Promise<void> {
    const invitation = await this.invitations.findByTokenHash(
      this.tokens.hash(token),
    );

    if (!invitation || !isCredentialInvitationUsable(invitation, new Date())) {
      throw new InvalidCredentialTokenError();
    }

    const recipient = await this.invitations.recipient(invitation.userId, null);
    // The account vanished between the two reads. Answering `USER_NOT_FOUND`
    // here would tell an anonymous caller that their token was real.
    if (!recipient) throw new InvalidCredentialTokenError();

    assertValidPassword(password, {
      email: recipient.email,
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      cedula: recipient.cedula ?? undefined,
    });

    const claimed = await this.invitations.redeem({
      invitationId: invitation.id,
      userId: invitation.userId,
      passwordHash: await this.hasher.hash(password),
      now: new Date(),
    });

    // Lost the race against a second submission of the same link. The answer
    // is the same as for a spent token, because that is what it now is.
    if (!claimed) throw new InvalidCredentialTokenError();

    /**
     * AU-021, AU-025. The trail records that this account's credential was
     * set, WITH THE ACCOUNT ITSELF AS THE AUTHOR — which is the whole point of
     * D-013: nobody else could have done it, because nobody else ever knew the
     * password. An administrator issuing an invitation appears as a separate,
     * earlier entry under their own id.
     *
     * The same collaborator the administration half uses, and not a second
     * one: AU-025 is one promise about mutations of an account, and the value
     * of the trail is that a single query answers «quién cambió qué y cuándo».
     * There is nowhere in its shape to put the password or the token.
     */
    await this.trail.record('UPDATE', invitation.userId, {
      userId: invitation.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    this.logger.info(
      {
        user_id: invitation.userId,
        action: 'CREDENTIAL_INVITATION_REDEEMED',
      },
      'first credential set from an invitation',
    );
  }
}
