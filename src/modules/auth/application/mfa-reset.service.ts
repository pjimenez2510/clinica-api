import { Inject, Injectable } from '@nestjs/common';

import { RevocationReason } from '../../../shared/request/client-context';
import { CannotResetOwnMfaError, UserNotFoundError } from '../domain/auth.errors'; // prettier-ignore

import {
  ACCOUNT_ADMIN_REPOSITORY,
  type AccountAdminRepositoryPort,
  type AccountView,
} from './admin-ports';
import type { Requester } from './auth-admin-audit.trail';

/**
 * Giving somebody their access back when their second factor is gone
 * (A4: AU-035, AU-036, REQ-154, D-014).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ITS OWN SERVICE, AND NOT A NINTH METHOD ON `AccountsService`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same reasoning that already put `CredentialInvitationsService` beside it
 * rather than inside it, and it crosses two of ADR-008 §2's three lines:
 * `AccountsService` is exactly at the eight public use cases the convention
 * allows, and the two change for different reasons — that one for how a person
 * is hired and let go, this one for how a lost second factor is recovered,
 * which is a policy question the clinic can reopen (D-014) without anything
 * about hiring changing.
 *
 * It is also the only use case in the module behind a permission that can take
 * over somebody else's account, and keeping it in a file of its own is what
 * lets that argument sit next to the code instead of in a paragraph buried
 * among eight unrelated methods.
 *
 * ⚠️ WHAT THIS PERMISSION REALLY GRANTS, stated where whoever changes this can
 * see it: retiring a doctor's second factor removes the last barrier between a
 * password and their signature, and whoever can also re-invite them (AU-021)
 * can sign in their name. The trail entry below is not bookkeeping — it is the
 * requirement, and it is the only thing that makes granting the permission
 * defensible before the SPDP (REQ-110).
 */
@Injectable()
export class MfaResetService {
  constructor(
    @Inject(ACCOUNT_ADMIN_REPOSITORY)
    private readonly accounts: AccountAdminRepositoryPort,
  ) {}

  /**
   * AU-035, AU-036.
   *
   * WHAT DISAPPEARS: the TOTP secret, the enrolment mark, the last consumed
   * step and the batch of backup codes — in one operation, so the account is
   * never left with half a second factor (see `resetMfa` on the port).
   *
   * WHAT DOES NOT: the password. The person still needs their own to sign in,
   * and whoever resets never learns any credential — which is what keeps this
   * a recovery and not a handover.
   *
   * ⚠️ AND WHAT IS NOT WRITTEN AFTERWARDS: the trail entry. It travels INTO the
   * port and lands in the same transaction, so a reset that cannot be recorded
   * does not happen at all. Every other mutation in this module records
   * through `AuthAdminAuditTrail` after committing, and for those that is the
   * right trade — a failure to write the trail must not deny somebody their
   * work. This one is the exception the audit recorder's own comment
   * anticipated: here the entry IS the requirement (AU-035), because it is the
   * only thing that makes granting this permission defensible.
   */
  async reset(userId: string, requester: Requester): Promise<AccountView> {
    // FIRST, BEFORE ANYTHING IS WRITTEN. A refusal that arrives with the
    // factor already gone refuses nothing. See `CannotResetOwnMfaError` for
    // why this is not symmetry with AU-024.
    if (userId === requester.userId) throw new CannotResetOwnMfaError();

    const account = await this.accounts.resetMfa(
      userId,
      // AU-036. A reason of its own: to an auditor, «se desactivó la cuenta»
      // and «se reinició el segundo factor» are different facts.
      RevocationReason.MFA_RESET,
      // AU-035, AU-025. Who, and from where. Nothing else fits in the shape,
      // which is how «la bitácora nunca lleva una credencial» is made true
      // rather than promised.
      { userId: requester.userId, ip: requester.ip, userAgent: requester.userAgent }, // prettier-ignore
    );
    // Same answer as the rest of account administration for an id that is
    // nobody's. The whole transaction rolled back, so there is no entry
    // either: one about an account that does not exist reads as a reset that
    // happened.
    if (!account) throw new UserNotFoundError();

    return account;
  }
}
