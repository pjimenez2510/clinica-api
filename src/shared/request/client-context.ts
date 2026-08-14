/**
 * Who made the request, from the transport's point of view.
 *
 * IN `shared/`, not in the auth module. It was declared identically in two
 * files a layer apart, and the audit log — which is not auth's business — needs
 * exactly the same shape. Two copies of a type is one copy away from two
 * copies that disagree.
 *
 * The IP is here because the LOPDP expects an improper access to be traceable
 * to a device. It is deliberately NOT written to the general logs: it goes to
 * the audit table, where it is declared in the processing register.
 */
export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

/**
 * Why a refresh token stopped being valid.
 *
 * Also duplicated, in the service and in the adapter. The moment somebody adds
 * a reason to one and not the other, the values stored stop matching the
 * values the code compares against — and the audit trail is what suffers.
 */
export const RevocationReason = {
  ROTATION: 'ROTATION',
  REUSE: 'REUSE',
  SIGN_OUT: 'SIGN_OUT',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  /**
   * AU-023: an administrator deactivated the account.
   *
   * A reason of its own and not `SIGN_OUT`: the two answer different questions
   * in an audit. «Se cerró la sesión» is the employee leaving for the day;
   * «se desactivó la cuenta» is somebody's access being withdrawn, which is
   * exactly what the SPDP asks to see.
   */
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  /**
   * AU-036: the account's second factor was reset by somebody else.
   *
   * Its own reason for the same argument as `ACCOUNT_DEACTIVATED`. To an
   * auditor «se desactivó la cuenta» is access being withdrawn and «se
   * reinició el segundo factor» is a recovery that leaves the account
   * reachable with the password alone — and only one of the two happened. The
   * value lands in `refresh_token.revocation_reason`, which is where that
   * question gets answered.
   */
  MFA_RESET: 'MFA_RESET',
} as const;

export type RevocationReason =
  (typeof RevocationReason)[keyof typeof RevocationReason];

/** A refresh token that has just been issued or rotated. */
export interface IssuedRefreshToken {
  token: string;
  familyId: string;
  expiresAt: Date;
}
