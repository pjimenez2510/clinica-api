import { ValidationError } from '../../../shared/domain/errors/domain-error';

export class WeakPasswordError extends ValidationError {
  readonly code = 'WEAK_PASSWORD';

  constructor(
    readonly reasons: string[],
    field = 'password',
  ) {
    // Two audiences, deliberately separated:
    //  - `message` is English, technical, and only reaches the logs. It never
    //    contains the password.
    //  - `fieldErrors` is what the user reads, and it DOES travel in the
    //    response in every environment. Telling somebody "the password was
    //    rejected" without saying why leaves them guessing, and guessing ends
    //    in a weaker password, not a stronger one.
    super(
      `Password rejected: ${reasons.length} rule(s) failed`,
      { reasonCount: reasons.length },
      reasons.map((message) => ({ field, code: 'WEAK_PASSWORD', message })),
    );
  }
}

/**
 * Password policy.
 *
 * Follows the current NIST guidance: **length is what matters**, and
 * composition rules ("one uppercase, one digit, one symbol") are deliberately
 * dropped. They are measured to push people toward predictable patterns
 * (`Password1!`) and toward writing the password down — in a clinic, taped to
 * the reception monitor.
 *
 * What is checked instead is that the password is not trivial and does not
 * contain the user's own data, which is where genuinely guessable passwords
 * come from.
 *
 * NOTE: the rejection reasons are shown to the end user, so they are the one
 * thing in this file written in Spanish.
 */
export const MIN_LENGTH = 12;
export const MAX_LENGTH = 256; // prevents DoS by hashing huge inputs

/** Trivial passwords common in the local context. */
const FORBIDDEN = new Set([
  'password',
  'contrasena',
  'contraseña',
  '123456789012',
  'qwertyuiop12',
  'clinica2026',
  'administrador',
]);

export interface UserDataForPassword {
  email?: string;
  firstName?: string;
  lastName?: string;
  cedula?: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Validates a password. Returns the rejection reasons, empty when valid.
 *
 * ALL reasons are returned rather than just the first: forcing the user to
 * discover them one at a time is the fastest way to make them pick something
 * bad out of sheer exhaustion.
 */
export function validatePassword(
  password: string,
  user: UserDataForPassword = {},
): string[] {
  const reasons: string[] = [];

  if (password.length < MIN_LENGTH) {
    reasons.push(`debe tener al menos ${MIN_LENGTH} caracteres`);
  }
  if (password.length > MAX_LENGTH) {
    reasons.push(`no puede superar ${MAX_LENGTH} caracteres`);
  }

  const normalized = normalize(password);

  if (FORBIDDEN.has(normalized)) {
    reasons.push('es una contraseña demasiado común');
  }

  // A single repeated character, or an obvious sequence.
  if (/^(.)\1+$/.test(password)) {
    reasons.push('no puede ser un mismo carácter repetido');
  }
  if (/0123456789|abcdefghij|qwertyuiop/.test(normalized)) {
    reasons.push('no puede ser una secuencia del teclado');
  }

  // The user's own data: this is where guessable passwords come from.
  const fragments = [
    user.email?.split('@')[0],
    user.firstName,
    user.lastName,
    user.cedula,
  ]
    .filter((f): f is string => typeof f === 'string' && f.length >= 4)
    .map(normalize);

  if (fragments.some((f) => normalized.includes(f))) {
    reasons.push('no puede contener tu nombre, correo ni cédula');
  }

  return reasons;
}

/** Validates and throws when the password does not comply. */
export function assertValidPassword(
  password: string,
  user: UserDataForPassword = {},
): void {
  const reasons = validatePassword(password, user);
  if (reasons.length > 0) throw new WeakPasswordError(reasons);
}
