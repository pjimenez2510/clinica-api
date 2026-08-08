import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  type Permission,
  PERMISSIONS,
} from '../../../shared/authorisation/permission.catalogue';

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

/**
 * RESPONSES ARE SCHEMAS TOO, not bare TypeScript interfaces.
 *
 * They used to be interfaces, and the consequence was concrete: the OpenAPI
 * document described every response as having no content, so a client
 * generated from it got `never` for the body of every call. The contract
 * between the two repositories IS this document — writing the types by hand on
 * the other side is how `user` disappeared from the refresh response without
 * anything noticing.
 *
 * `createZodDto` puts them in the document; `z.infer` keeps the TypeScript
 * type derived from the same schema, so they cannot drift.
 */
export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds, not a timestamp. Read from the token service, never a literal. */
  expiresIn: z.number().int().positive(),
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    firstName: z.string(),
    lastName: z.string(),
  }),
  /**
   * Roles held, with their permissions resolved, so the interface knows what
   * to OFFER. Never what to ALLOW — the API settles that on every request.
   */
  grants: z.array(
    z.object({
      roleCode: z.string(),
      /** `null` means every site. */
      siteId: z.uuid().nullable(),
      /**
       * THE CATALOGUE TRAVELS IN THE CONTRACT, not as free strings.
       *
       * Declared as an enum so the OpenAPI document lists every permission
       * code, which means a client generated from it gets a string-literal
       * union instead of `string`. On the other side those codes are written
       * in three places — the sidebar, each page's route meta, and every
       * button guard — and with a plain `string` a single typo produces a
       * screen nobody can reach and no error anywhere.
       *
       * `readonly` because `ResolvedGrant` is: the list is resolved once and
       * shared between requests, so nobody should be able to mutate it.
       */
      permissions: z
        .enum(PERMISSIONS as unknown as [Permission, ...Permission[]])
        .array()
        .readonly(),
    }),
  ),
});
export class SessionResponseDto extends createZodDto(sessionResponseSchema) {}
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Returned when the password was right but the second factor is still pending. */
export const mfaChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  /** Short-lived token that only opens the MFA endpoints. */
  challengeToken: z.string(),
});
export class MfaChallengeResponseDto extends createZodDto(
  mfaChallengeResponseSchema,
) {}
export type MfaChallengeResponse = z.infer<typeof mfaChallengeResponseSchema>;

/**
 * `POST /auth/login` answers with a session OR a pending second factor.
 *
 * NOT a `createZodDto` over a union: that class would have to extend a base
 * whose return type is a union, which TypeScript rejects outright —
 * "Base constructor return type is not an object type". The union is declared
 * to Swagger as `oneOf` at the controller instead, which is also what the
 * OpenAPI document is supposed to say.
 */

/** Secret and provisioning URI, returned once so the QR code can be drawn. */
export const mfaEnrolmentResponseSchema = z.object({
  secret: z.string(),
  uri: z.string(),
});
export class MfaEnrolmentResponseDto extends createZodDto(
  mfaEnrolmentResponseSchema,
) {}
