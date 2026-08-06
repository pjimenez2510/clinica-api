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
} as const;

export type RevocationReason =
  (typeof RevocationReason)[keyof typeof RevocationReason];

/** A refresh token that has just been issued or rotated. */
export interface IssuedRefreshToken {
  token: string;
  familyId: string;
  expiresAt: Date;
}
