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

export const signInSchema = z.object({
  email: z.email().toLowerCase().trim(),
  // Length is not validated here: the policy only applies when SETTING a
  // password. Rejecting a short one at sign-in would tell an attacker that the
  // stored password is short.
  password: z.string().min(1).max(256),
});
export class SignInDto extends createZodDto(signInSchema) {}

export const verifyMfaSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'el código debe tener 6 dígitos'),
});
export class VerifyMfaDto extends createZodDto(verifyMfaSchema) {}

export const confirmMfaSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'el código debe tener 6 dígitos'),
});
export class ConfirmMfaDto extends createZodDto(confirmMfaSchema) {}

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
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
}

/** Returned when the password was right but the second factor is still pending. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  /** Short-lived token that only opens the MFA endpoints. */
  challengeToken: string;
}
