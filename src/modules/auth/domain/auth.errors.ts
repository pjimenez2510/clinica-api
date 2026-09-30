import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
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

/**
 * AU-002: one answer for unknown email, wrong password, locked account and
 * inactive account.
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

/**
 * AU-003: a wrong TOTP or backup code; the same answer whether the code was
 * wrong or the second factor is locked.
 */
export class InvalidMfaCodeError extends UnauthorizedError {
  readonly code = 'INVALID_MFA_CODE';
  constructor() {
    // Same answer whether the code was wrong or the account is locked out of
    // the second factor: telling them apart hands an attacker a progress bar.
    super('The verification code is not valid');
  }
}

/**
 * The operation needs a second factor the account does not have (confirming an
 * enrolment never started, or proving a factor that was never set up).
 */
export class MfaNotEnrolledError extends UnauthorizedError {
  readonly code = 'MFA_NOT_ENROLLED';
  constructor() {
    super('No TOTP secret is enrolled for this account');
  }
}

/**
 * AU-005, AU-037: enrolling again over a confirmed factor. Replacing it goes
 * through the change flow, which first proves the current factor.
 */
export class MfaAlreadyEnrolledError extends ConflictError {
  readonly code = 'MFA_ALREADY_ENROLLED';
  constructor() {
    // Re-enrolling would silently invalidate the user's authenticator without
    // proving they still control the current one.
    super('This account already has a confirmed second factor');
  }
}

/**
 * AU-037 — there is no re-enrolment in progress to confirm.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE CODE FOR TWO SITUATIONS, AND BOTH ARE THE SAME FACT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Either nobody started a change — the confirmation arrived on its own, or the
 * pending secret was already spent — or somebody started ANOTHER one and this
 * confirmation is holding a secret that no longer exists. To whoever is at the
 * screen these are one thing: «lo que estaba a medias ya no está», and the
 * only move is to start again. Telling them apart would describe a race the
 * person cannot act on.
 *
 * NOT `MfaNotEnrolledError`: the account has a perfectly good second factor —
 * that is the whole point of AU-037, the old one keeps working — so saying it
 * is not enrolled would send the client to the enrolment screen, which refuses
 * with `MFA_ALREADY_ENROLLED`, and the person would be stuck between two
 * errors.
 *
 * 409 like `MfaAlreadyEnrolledError`: the request is well formed and the
 * caller is authorised; the state it assumes is simply not there any more.
 */
export class MfaChangeNotStartedError extends ConflictError {
  readonly code = 'MFA_CHANGE_NOT_STARTED';
  override readonly userTitle =
    'No hay ningún cambio de segundo factor a medias. Empiece de nuevo y escanee el código otra vez';

  constructor() {
    super('No pending second factor change to confirm');
  }
}

/**
 * The access token has not passed the second factor, and the route is not part
 * of the MFA flow. Raised by `JwtAuthGuard`; without it MFA would be
 * decorative.
 */
export class MfaRequiredError extends UnauthorizedError {
  readonly code = 'MFA_REQUIRED';
  constructor() {
    super('This session has not completed the second factor');
  }
}

/**
 * AU-036 — the session this token belongs to was closed before it expired.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT IS NOT `INVALID_TOKEN`, AND WHY SAYING SO LEAKS NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `InvalidTokenError` is «this string is not something we signed», and the
 * reason behind it is withheld from the client in production because it
 * distinguishes an expired token from a forged one: it travels only in the
 * technical message, which the problem-details filter sends as `detail`
 * outside production alone, and in `params`, which it never serialises (in
 * development, `detail` shows it). This is a different fact: the token IS ours,
 * it IS still within its lifetime, and the session behind it was revoked —
 * because the second factor was reset (AU-036), the password changed, or the
 * account was deactivated (AU-023).
 *
 * It tells whoever holds the token nothing they did not already know: they are
 * holding it. What it buys is that the interface can send the person back to
 * sign in with a sentence that matches what happened, instead of the «su sesión
 * no es válida» that a receptionist reads as a broken system.
 *
 * A 401 and not a 403: the way forward is to authenticate again.
 */
export class SessionRevokedError extends UnauthorizedError {
  readonly code = 'SESSION_REVOKED';
  override readonly userTitle =
    'Su sesión se cerró. Vuelva a iniciar sesión para continuar';

  constructor() {
    super('The session family behind this access token has been revoked');
  }
}

/**
 * AU-040. The session family reached its lifetime, counted from sign-in
 * (D-063): nobody closed it, it simply ran out.
 *
 * NOT `SESSION_REVOKED`, whose sentence would be a lie here, and not
 * `INVALID_REFRESH_TOKEN`, which the interface can only read as a broken
 * session. Like `SESSION_REVOKED`, it tells whoever holds the token nothing
 * they did not already know. Both the refresh endpoint and the guard answer
 * it, so the interface recognises it BY CODE wherever it arrives.
 */
export class SessionExpiredError extends UnauthorizedError {
  readonly code = 'SESSION_EXPIRED';
  override readonly userTitle =
    'Su sesión caducó. Vuelva a iniciar sesión para continuar';

  constructor() {
    super('The session family reached its maximum lifetime');
  }
}

/**
 * AU-004: the refresh token is unknown, or revoked without having been used.
 * A token that WAS used raises `RefreshTokenReuseError` instead, and one of an
 * expired family `SessionExpiredError` (AU-040).
 */
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

/**
 * AU-028 — the first-credential link does not work.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ANSWER FOR THREE SITUATIONS, AND THAT IS THE REQUIREMENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unknown token, already redeemed token, expired token: identical status,
 * identical code, identical sentence. Telling them apart turns a PUBLIC
 * endpoint into an oracle over a secret whose shape is guessable — «ya se usó»
 * confirms the token existed, and «caducó» confirms somebody was invited. It
 * is the same reasoning as `InvalidCredentialsError`, applied to a channel
 * where the caller is anonymous BY DESIGN: whoever cannot sign in is exactly
 * who has to reach this.
 *
 * A `ValidationError` (422) and not a 404: nothing was looked up on the
 * caller's behalf, and a 404 would say «este token no existe», which is
 * precisely the thing that must not be said. The field error points the
 * interface at the token so it can show the message on the page rather than in
 * a toast the person has already navigated away from.
 *
 * The sentence tells them WHAT TO DO, because there is exactly one thing they
 * can do and they cannot sign in to find out what it is.
 */
export class InvalidCredentialTokenError extends ValidationError {
  readonly code = 'INVALID_CREDENTIAL_TOKEN';
  override readonly userTitle =
    'Este enlace ya no sirve: puede que haya caducado o que ya lo haya usado. Pida a quien administra el sistema que le envíe uno nuevo';

  constructor() {
    // Deliberately identical whether the token is unknown, spent or expired.
    super('The credential invitation token is not usable', {}, [
      {
        field: 'token',
        code: 'INVALID_CREDENTIAL_TOKEN',
        message: 'El enlace ya no es válido',
      },
    ]);
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

/**
 * AU-035 — nobody resets their OWN second factor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS FORBIDDEN, AND IT IS NOT SYMMETRY WITH AU-024.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AU-035 scopes itself to «otra cuenta», and three things make that the right
 * scope rather than an accident of wording:
 *
 *   - IT COULD NEVER BE A RECOVERY PATH. The route is behind a permission, so
 *     reaching it needs a completed session — and a completed session means
 *     the second factor already worked. Whoever actually lost their phone
 *     cannot get here; whoever can get here does not need to.
 *   - SO IT WOULD ONLY EVER REMOVE A WORKING FACTOR. Anybody holding a live
 *     session of an account with this permission — a laptop left unlocked, a
 *     stolen token — could strip that account's second factor and from then on
 *     re-enter with the password alone. A factor a session can remove is a
 *     factor that stops protecting the moment it is most needed.
 *   - AND IT WOULD BREAK THE ONLY THING MAKING THE PERMISSION SAFE. The value
 *     of the entry AU-035 demands is that author and subject are different
 *     people. Author equal to subject is the same shape the base already
 *     refuses in `user_role_grant_no_self_grant`: the audit question must not
 *     answer «lo hizo ella misma».
 *
 * NOTHING IS LOST BY REFUSING IT. There is no self-service way to re-enrol
 * anyway — `MfaAlreadyEnrolledError` refuses a second enrolment — so somebody
 * changing phones already needs another person. This makes that explicit
 * instead of offering a path that quietly weakens the account.
 *
 * 422 and not 403, like `CANNOT_DEMOTE_SELF`: the caller is perfectly
 * authorised; what they asked for is a state the system must not reach here.
 */
export class CannotResetOwnMfaError extends BusinessRuleViolation {
  readonly code = 'CANNOT_RESET_OWN_MFA';
  override readonly userTitle =
    'No puede reiniciar su propio segundo factor. Pídaselo a otra persona con ese permiso: la bitácora tiene que poder decir quién lo reinició y a quién';

  constructor() {
    super('A user may not reset their own second factor');
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
 * AU-033's two permission errors —`UNKNOWN_PERMISSION` y
 * `PERMISSION_NOT_INSTALLED`— MOVED to
 * `shared/domain/errors/permission.errors.ts` on 14-08-2026, when
 * `configuration` started storing a permission code as data
 * (`site_parameter.overbooking_permission`, AG-094/AG-101). Same `code`, same
 * status, same sentences: what changed is the emitter, not the contract. No
 * module imports another, and two classes answering one `code` is what
 * `error-catalogue.spec.ts` refuses.
 */

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
