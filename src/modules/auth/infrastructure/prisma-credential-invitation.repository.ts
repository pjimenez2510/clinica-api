import { Injectable } from '@nestjs/common';

import { RevocationReason } from '../../../shared/request/client-context';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CredentialInvitationRepositoryPort,
  CredentialRecipient,
  IssueCredentialInvitationInput,
  StoredCredentialInvitation,
} from '../application/credential-ports';

/**
 * Rows in, domain shapes out, for the first-credential half (AU-021, AU-026..AU-029).
 *
 * THE TOKEN NEVER APPEARS IN THIS FILE, in either direction. Only its SHA-256
 * is written, and nothing here can read one back — there is none stored. That
 * is the same guarantee `refresh_token` gives and it is the reason a stolen
 * database dump contains no way into anybody's account.
 */
@Injectable()
export class PrismaCredentialInvitationRepository implements CredentialInvitationRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * AU-027. Supersede the live one and issue the new one, atomically.
   *
   * WHY IT MUST BE ONE TRANSACTION. `credential_invitation_one_live_per_user`
   * is a partial unique index over `WHERE used_at IS NULL`, so the insert can
   * only succeed once the previous row has stopped being live. Split into two
   * calls, a crash in between leaves the person with no way in at all, and two
   * concurrent re-sends can interleave into a unique violation that reads to
   * the caller as an unexplained conflict.
   *
   * SUPERSEDING WRITES `used_at`, and the column means «ya no está viva» for
   * both of its reasons — redeemed, or replaced. It is not a shortcut: the
   * partial index is defined over exactly this column, and a second «superseded_at»
   * would either sit outside the index (letting two live links exist) or have
   * to be added to it, which is the same rule written twice. What was actually
   * redeemed is answerable anyway, and from stronger evidence: only a
   * redemption changes `app_user.password_hash`.
   */
  async supersedeAndIssue(
    input: IssueCredentialInvitationInput,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.credentialInvitation.updateMany({
        where: { userId: input.userId, usedAt: null },
        data: { usedAt: input.now },
      });

      await tx.credentialInvitation.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdById: input.createdById,
        },
      });
    });
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<StoredCredentialInvitation | null> {
    const row = await this.prisma.credentialInvitation.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
    return row;
  }

  /**
   * AU-021. Spend the invitation and set the password, or do neither.
   *
   * THE CONDITIONAL UPDATE IS THE LOCK. `updateMany ... where usedAt: null`
   * lets PostgreSQL decide which of two simultaneous submissions wins, and the
   * loser gets a count of zero rather than a second password write. Reading
   * the row and then updating it would let both through, and the second would
   * overwrite the password the person had just chosen with the one typed in a
   * tab they had left open.
   *
   * THE SESSIONS ARE REVOKED IN THE SAME TRANSACTION, for the reason
   * `rotateCredentials` already documents: setting a credential and cutting
   * the sessions must not come apart. An account redeeming its FIRST
   * invitation normally has none — it could never sign in — but a re-invited
   * account does, and those are exactly the sessions somebody wanted gone.
   */
  async redeem(input: {
    invitationId: string;
    userId: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.credentialInvitation.updateMany({
        where: { id: input.invitationId, usedAt: null },
        data: { usedAt: input.now },
      });

      if (claimed.count !== 1) return false;

      await tx.user.update({
        where: { id: input.userId },
        data: {
          passwordHash: input.passwordHash,
          // A brand-new account cannot be locked out, but a re-invited one
          // can: refusing the person on the first sign-in after they have just
          // set a password is indistinguishable from the password not working.
          failedAttempts: 0,
          lockedUntil: null,
        },
      });

      await tx.refreshToken.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: {
          revokedAt: input.now,
          revocationReason: RevocationReason.PASSWORD_CHANGE,
        },
      });

      return true;
    });
  }

  /**
   * The person, their inviter and the clinic, in one query each.
   *
   * THE CLINIC'S NAME COMES FROM `establishment.legal_name`, a table
   * `organization` owns. Read and not imported: no module imports another, and
   * the message has to name the clinic — an anonymous link asking somebody for
   * a password is exactly what phishing looks like. `null` when the
   * installation has not registered its establishment yet (OR-001), and the
   * message is written to survive that.
   */
  async recipient(
    userId: string,
    inviterId: string | null,
  ): Promise<CredentialRecipient | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        cedula: true,
      },
    });
    if (!user) return null;

    const inviter = inviterId
      ? await this.prisma.user.findUnique({
          where: { id: inviterId },
          select: { firstName: true, lastName: true },
        })
      : null;

    const establishment = await this.prisma.establishment.findFirst({
      where: { active: true },
      select: { legalName: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      cedula: user.cedula,
      inviterName: inviter
        ? `${inviter.firstName} ${inviter.lastName}`.trim()
        : null,
      clinicName: establishment?.legalName ?? null,
    };
  }
}
