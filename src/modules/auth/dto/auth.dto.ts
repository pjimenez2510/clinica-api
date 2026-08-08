import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Request and response contracts.
 *
 * A single Zod schema is the source of truth for runtime validation, the
 * TypeScript type and the OpenAPI document. With class-validator the same
 * information has to be written twice — decorators plus @ApiProperty — and the
 * two drift apart silently.
 */

/**
 * Every user-facing field declares its OWN message.
 *
 * Zod's built-in Spanish locale is machine translated and reads badly
 * ("Inválido dirección de correo electrónico"). It stays configured as a
 * fallback so nothing ever surfaces in English, but anything a receptionist
 * will actually read is written here.
 *
 * Wording follows clinica-docs/ADR-005-mensajes-al-usuario.md: a complete sentence,
 * capitalised, no trailing period, addressing the user as "usted".
 */
const TOTP_CODE = z
  .string({ error: 'El código de verificación es obligatorio' })
  .regex(/^\d{6}$/, 'El código debe tener exactamente 6 dígitos');

export const signInSchema = z.object({
  email: z
    .string({ error: 'El correo es obligatorio' })
    .trim()
    .toLowerCase()
    .pipe(z.email('Ingrese un correo electrónico válido')),
  // Length is NOT validated here. The policy only applies when SETTING a
  // password; rejecting a short one at sign-in would tell an attacker that the
  // stored password is short.
  password: z
    .string({ error: 'La contraseña es obligatoria' })
    .min(1, 'La contraseña es obligatoria')
    .max(256, 'La contraseña no puede superar 256 caracteres'),
});
export class SignInDto extends createZodDto(signInSchema) {}

export const verifyMfaSchema = z.object({ code: TOTP_CODE });
export class VerifyMfaDto extends createZodDto(verifyMfaSchema) {}

export const confirmMfaSchema = z.object({ code: TOTP_CODE });
export class ConfirmMfaDto extends createZodDto(confirmMfaSchema) {}

export const changePasswordSchema = z.object({
  currentPassword: z
    .string({ error: 'La contraseña actual es obligatoria' })
    .min(1, 'La contraseña actual es obligatoria')
    .max(256),
  // The strength policy is NOT duplicated here: it lives in the domain, needs
  // the user's own data to check the password does not contain their name, and
  // must apply to every path that sets a password — not only this endpoint.
  newPassword: z
    .string({ error: 'La nueva contraseña es obligatoria' })
    .min(1, 'La nueva contraseña es obligatoria')
    .max(256, 'La contraseña no puede superar 256 caracteres'),
});
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

/** Session issued after a completed sign-in. */
export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  /**
   * Roles held, with their permissions resolved, so the interface knows what
   * to OFFER. Never what to ALLOW — the API settles that on every request.
   */
  grants: {
    roleCode: string;
    siteId: string | null;
    permissions: readonly string[];
  }[];
}

/** Returned when the password was right but the second factor is still pending. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  /** Short-lived token that only opens the MFA endpoints. */
  challengeToken: string;
}
