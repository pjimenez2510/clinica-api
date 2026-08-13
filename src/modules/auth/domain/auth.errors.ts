import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
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
  override readonly userTitle = 'El correo o la contraseña no son correctos';
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

// ═══════════════════════════════════════════════════════════════════════════
// Administration (A2: AU-020..AU-034)
// ═══════════════════════════════════════════════════════════════════════════
//
// The session errors above answer an ANONYMOUS caller and are deliberately
// vague — telling an unknown email apart from a locked account enumerates who
// works at the clinic. These are the opposite situation: the caller already
// holds `user:manage`, is looking at the staff list, and a vague answer would
// only make an administration screen impossible to use. Being specific here is
// not a relaxation of AU-002; it is a different threat model.

/**
 * AU-020. The institutional email already belongs to an account.
 *
 * The guarantee is `app_user_email_key`, so this is raised from the adapter
 * when PostgreSQL refuses: two administrators registering the same new hire in
 * the same minute both read "free", and only the unique index can arbitrate.
 */
export class EmailAlreadyRegisteredError extends ConflictError {
  readonly code = 'EMAIL_ALREADY_REGISTERED';
  override readonly userTitle =
    'Ese correo ya pertenece a una cuenta. Si la persona ya trabajó aquí, búsquela entre las cuentas desactivadas y actívela';

  constructor() {
    super('Email already belongs to an account', {}, [
      {
        field: 'email',
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'Ese correo ya está registrado',
      },
    ]);
  }
}

/** The account does not exist. */
export class UserNotFoundError extends NotFoundError {
  readonly code = 'USER_NOT_FOUND';
  override readonly userTitle =
    'La cuenta indicada no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('User not found');
  }
}

/**
 * AU-024 — the requirement that protects the installation.
 *
 * THIS IS THE ONE WHOSE FAILURE IS PERMANENT. Every other refusal in this
 * module can be undone by an administrator; this one exists because the
 * operations it forbids leave NOBODY able to undo anything. Deactivating your
 * own account, dropping your own `user:manage`, or removing the last active
 * role that carries it all end at the same place: a clinic that has to reach
 * for `psql` to get its own system back, and a clinic that cannot.
 *
 * It is 422 and not 403: the caller is perfectly authorised: what they asked
 * for is a state the system must not be able to reach.
 *
 * The sentence says WHAT TO DO instead, because the administrator handing over
 * to a successor is the legitimate case behind almost every one of these.
 */
export class CannotDemoteSelfError extends BusinessRuleViolation {
  readonly code = 'CANNOT_DEMOTE_SELF';
  override readonly userTitle =
    'No puede quitarse a sí mismo la administración ni dejar el sistema sin administradores. Conceda antes la administración a otra cuenta y luego retire la suya';

  constructor(technicalMessage: string) {
    super(technicalMessage);
  }
}

/** AU-030. Two roles may not share a code: it appears in seeds and in logs. */
export class RoleCodeDuplicateError extends ConflictError {
  readonly code = 'ROLE_CODE_DUPLICATE';
  override readonly userTitle =
    'Ya existe un rol con ese código. Elija otro: el código identifica al rol en la configuración y en la bitácora';

  constructor() {
    super('Role code already exists', {}, [
      {
        field: 'code',
        code: 'ROLE_CODE_DUPLICATE',
        message: 'Ese código ya pertenece a otro rol',
      },
    ]);
  }
}

/** The role does not exist. */
export class RoleNotFoundError extends NotFoundError {
  readonly code = 'ROLE_NOT_FOUND';
  override readonly userTitle =
    'El rol indicado no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Role not found');
  }
}

/**
 * AU-031. A role somebody still holds cannot be deleted, and deactivating it
 * is what the requirement actually asks for: the grants stay in the trail —
 * who could do what, and when, is evidence the LOPDP expects (REQ-110) — and a
 * deactivated role grants nothing from the next request onwards, because
 * `role-permission.registry.ts` excludes it in the QUERY.
 */
export class RoleInUseError extends ConflictError {
  readonly code = 'ROLE_IN_USE';
  override readonly userTitle =
    'El rol está concedido a alguna cuenta y no puede borrarse. Puede desactivarlo: deja de conceder permisos sin borrar quién lo tuvo';

  constructor() {
    super('Role still has live grants and cannot be deleted');
  }
}

/**
 * AU-031. A system role ships with the product and is never deleted.
 *
 * Its permissions ARE editable — that is the whole point of roles being data —
 * and so is its name. What cannot happen is the role disappearing: an empty
 * role table locks everyone out, including whoever would fix it. The guarantee
 * is the trigger `trg_role_protect_system`, so this is raised from the adapter
 * when PostgreSQL refuses; the service refuses earlier so the answer does not
 * depend on a database message.
 */
export class SystemRoleProtectedError extends BusinessRuleViolation {
  readonly code = 'SYSTEM_ROLE_PROTECTED';
  override readonly userTitle =
    'Ese rol viene con el sistema y no puede borrarse. Puede desactivarlo o cambiar qué permisos lleva';

  constructor() {
    super('System roles cannot be deleted');
  }
}

/**
 * AU-033. A permission code the CODE does not declare.
 *
 * Permissions are not data: each one corresponds to a check in a route, so a
 * code invented in a row protects nothing and, worse, reads on the screen as a
 * promise the system does not keep. The catalogue in
 * `shared/authorisation/permission.catalogue.ts` is the enumeration, and this
 * is what a client gets for sending anything outside it.
 */
export class UnknownPermissionError extends BusinessRuleViolation {
  readonly code = 'UNKNOWN_PERMISSION';
  override readonly userTitle =
    'Alguno de los permisos indicados no existe en el sistema. Actualice la pantalla: los permisos los define el programa, no se pueden inventar';

  constructor(unknown: readonly string[]) {
    super('One or more permission codes are not in the catalogue', {}, [
      {
        field: 'permissions',
        code: 'UNKNOWN_PERMISSION',
        // The rejected codes ARE named: they came from the caller, they are
        // not personal data, and hiding them makes the failure unreportable.
        message: `Permisos desconocidos: ${unknown.join(', ')}`,
      },
    ]);
  }
}

/**
 * Nobody grants themselves a role.
 *
 * NOT A NEW RULE — a guarantee that has been in the base since
 * `20260806045045_staff_roles_and_site_scope`, as the CHECK
 * `user_role_grant_no_self_grant`, with its reason written next to it: «the
 * audit question "who gave this person access to clinical records" must never
 * answer "they did"». Building the administration screens is what finally gave
 * it a way to be hit, and an error is what turns a `23514` into a sentence a
 * clinic can act on.
 *
 * It does NOT forbid an administrator editing their own grants altogether:
 * REVOKING one of your own roles is fine and stays possible — subject to
 * AU-024, which is what stops you revoking the last one that matters. What is
 * refused is ADDING to yourself, which is the thing separation of duties is
 * about.
 */
export class CannotGrantToSelfError extends BusinessRuleViolation {
  readonly code = 'CANNOT_GRANT_TO_SELF';
  override readonly userTitle =
    'Nadie puede concederse a sí mismo un rol. Pídaselo a otra persona con administración de usuarios: la bitácora tiene que poder decir quién concedió cada acceso';

  constructor() {
    super('A user may not grant a role to themselves');
  }
}
