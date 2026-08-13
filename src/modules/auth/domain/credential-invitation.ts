/**
 * The rules of a first-credential invitation (AU-021, AU-026, AU-028, D-013).
 *
 * PURE, and the time arrives as a parameter. A `new Date()` inside any of
 * these would make «caduca a las 72 horas» impossible to test without
 * travelling in time, and this is the deadline whose failure mode is a person
 * unable to enter the system.
 */

/**
 * How long a first-credential link lives. THE ONLY DEFINITION OF THIS NUMBER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 72 HOURS, AND WHY THAT AND NOT 24 OR 7 DAYS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The link is a bearer credential sitting in a mailbox: whoever holds it can
 * set the password of an account that may read medical records. Its lifetime
 * is exactly the window in which a forwarded, forgotten or intercepted message
 * is still an account takeover, so short is safer.
 *
 * It cannot be too short either. Somebody hired on a Friday afternoon is
 * invited on Friday and reads their institutional mail on Monday morning; with
 * 24 hours every single one of them arrives to a dead link, and an
 * administrator who has to re-send the invitation for half the staff stops
 * treating the expiry as meaningful. 72 hours covers the weekend and nothing
 * more.
 *
 * NOT a database default and not a configuration knob: one deadline with two
 * definitions is one that gets changed in a single place, and «cuánto dura la
 * invitación» is not a question a clinic has asked to answer for itself. If it
 * ever is, this constant is what moves — not a copy of it.
 */
export const CREDENTIAL_INVITATION_TTL_HOURS = 72;

const HOUR_IN_MS = 60 * 60 * 1000;

/** When an invitation issued at `now` stops working. */
export function credentialInvitationExpiry(now: Date): Date {
  return new Date(now.getTime() + CREDENTIAL_INVITATION_TTL_HOURS * HOUR_IN_MS);
}

/** What the rules need to know about a stored invitation. Never the token. */
export interface CredentialInvitationState {
  expiresAt: Date;
  /** `null` = still live. Set on redemption AND on being superseded. */
  usedAt: Date | null;
}

/**
 * Whether a link still works.
 *
 * ONE ANSWER FOR THREE SITUATIONS — unknown, already used, expired — and that
 * is the point rather than a simplification. Told apart, this endpoint becomes
 * an oracle over a guessable-shaped secret: «used» confirms the token existed,
 * which confirms a guess was structurally right, and «expired» confirms an
 * account was invited. The caller is anonymous by design, because somebody who
 * cannot sign in is exactly who needs this.
 *
 * The unknown case is not modelled here at all: there is no state to pass, and
 * the caller answers the same thing for it. Making it an argument would invite
 * a branch.
 */
export function isCredentialInvitationUsable(
  invitation: CredentialInvitationState,
  now: Date,
): boolean {
  if (invitation.usedAt !== null) return false;
  return invitation.expiresAt.getTime() > now.getTime();
}
