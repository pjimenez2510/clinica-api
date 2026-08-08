import {
  ConflictError,
  UnauthorizedError,
} from '../../../shared/domain/errors/domain-error';

/**
 * Business rules of authentication, as errors.
 *
 * WHY THEY LIVE HERE AND NOT NEXT TO WHAT THROWS THEM. Two reasons, both about
 * the direction of dependencies:
 *
 *   - To type a `catch` or write a test, a consumer had to import
 *     `auth.service.ts` — and with it `@nestjs/common`, `PinoLogger`, the
 *     password policy and five ports. An error is a lightweight value; it
 *     should not drag in the machine that produces it.
 *   - `RefreshTokenReuseError` is documented as part of what the client sees,
 *     and it lived in an infrastructure adapter. An adapter was defining public
 *     contract: change the token strategy and the contract with the frontend
 *     moves underneath it.
 *
 * The rule is the same one already applied to ports: infrastructure THROWS
 * domain errors, it does not DEFINE them. What stays outside this file is what
 * is genuinely not a business rule — a malformed Authorization header is the
 * shape of the transport, and a corrupt signature is a technical failure of the
 * adapter that parses it.
 */

export class InvalidCredentialsError extends UnauthorizedError {
  readonly code = 'INVALID_CREDENTIALS';
  /**
   * Says the pair is wrong WITHOUT saying which half.
   *
   * The generic 401 title, "No autenticado", is HTTP vocabulary and left the
   * user with nothing actionable on screen. This does not weaken the
   * protection below: it still refuses to distinguish an unknown email from a
   * wrong password from a locked account.
   */
  readonly override userTitle = 'El correo o la contraseña no son correctos';
  constructor() {
    // Deliberately identical whether the email is unknown, the password is
    // wrong, or the account is locked or inactive. Telling them apart lets an
    // attacker enumerate who works here — and locking an account is something
    // an attacker can cause at will.
    super('Email or password is incorrect');
  }
}

/**
 * Only thrown where the caller has ALREADY proved they had a session — a
 * refresh whose account was deactivated meanwhile. Saying so there is useful:
 * the client stops retrying and shows a real message.
 *
 * Never during sign-in, where the caller is anonymous and "this account exists
 * but is inactive" is exactly what an attacker is fishing for.
 */
export class AccountInactiveError extends UnauthorizedError {
  readonly code = 'ACCOUNT_INACTIVE';
  constructor() {
    super('Account is not active');
  }
}

/**
 * The token is valid but the user behind it is gone.
 *
 * A 404 would be wrong: nothing was looked up by the caller. It is an
 * inconsistent system state — a valid signature over a subject that no longer
 * exists — so the session is what is invalid, and the honest answer is 401.
 */
export class SessionUserMissingError extends UnauthorizedError {
  readonly code = 'SESSION_USER_MISSING';
  constructor() {
    super('The session refers to a user that no longer exists');
  }
}

export class InvalidMfaCodeError extends UnauthorizedError {
  readonly code = 'INVALID_MFA_CODE';
  constructor() {
    // Same answer whether the code was wrong or the account is locked out of
    // the second factor: telling them apart hands an attacker a progress bar.
    super('The verification code is not valid');
  }
}

export class MfaNotEnrolledError extends UnauthorizedError {
  readonly code = 'MFA_NOT_ENROLLED';
  constructor() {
    super('No TOTP secret is enrolled for this account');
  }
}

export class MfaAlreadyEnrolledError extends ConflictError {
  readonly code = 'MFA_ALREADY_ENROLLED';
  constructor() {
    // Re-enrolling would silently invalidate the user's authenticator without
    // proving they still control the current one.
    super('This account already has a confirmed second factor');
  }
}

export class MfaRequiredError extends UnauthorizedError {
  readonly code = 'MFA_REQUIRED';
  constructor() {
    super('This session has not completed the second factor');
  }
}

export class InvalidRefreshTokenError extends UnauthorizedError {
  readonly code = 'INVALID_REFRESH_TOKEN';
  constructor() {
    super('The refresh token is not valid');
  }
}

/**
 * A refresh token was presented twice.
 *
 * Part of the public contract: the client is expected to treat it as a session
 * compromise and send the user back to sign-in, not retry.
 */
export class RefreshTokenReuseError extends UnauthorizedError {
  readonly code = 'REFRESH_TOKEN_REUSE_DETECTED';
  constructor() {
    super('The refresh token had already been used');
  }
}
