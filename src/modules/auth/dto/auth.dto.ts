import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  type Permission,
  PERMISSIONS,
} from '../../../shared/authorisation/permission.catalogue';
import { normalizeBackupCode } from '../domain/backup-code';

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

/**
 * AU-005. Completing the second factor accepts EITHER shape.
 *
 * The endpoint takes the six digits from the authenticator or one of the
 * backup codes, and the form has one field for both — asking the person to
 * declare which kind they are about to type is a question they should not have
 * to answer, and a second field is a second thing to get wrong while locked
 * out.
 *
 * The shape is checked here only to refuse obvious rubbish before it reaches
 * Argon2. WHICH of the two it is is decided by the service, and both are
 * refused with the same error, so this validation cannot become an oracle. The
 * backup format is not restated: `normalizeBackupCode` owns it, and a second
 * copy of the alphabet is how a correctly typed code ends up rejected.
 *
 * `confirmMfaSchema` below stays six digits: confirming enrolment proves the
 * QR code was scanned, and a backup code cannot prove that.
 */
const MFA_CODE = z
  .string({ error: 'El código de verificación es obligatorio' })
  // Bounded before any parsing: there is no reason for this field to be long,
  // and normalising a megabyte of input is work an anonymous caller can ask
  // for over and over.
  .max(64, 'El código no tiene el formato de ninguno de los dos códigos')
  .refine(
    (value) => /^\d{6}$/.test(value) || normalizeBackupCode(value) !== null,
    'Ingrese el código de seis dígitos de su aplicación o uno de sus códigos de respaldo',
  );

export const verifyMfaSchema = z.object({ code: MFA_CODE });
export class VerifyMfaDto extends createZodDto(verifyMfaSchema) {}

export const confirmMfaSchema = z.object({ code: TOTP_CODE });
export class ConfirmMfaDto extends createZodDto(confirmMfaSchema) {}

/**
 * AU-037. The proof of the CURRENT factor, to start changing it.
 *
 * Accepts both shapes, like `verifyMfaSchema` and for the same reason: the
 * person may be changing phones precisely because the old one is already gone
 * from their hands, and a backup code is the second factor just as much as the
 * six digits are. It is spent, like any other use of one.
 *
 * Confirming the NEW authenticator reuses `confirmMfaSchema`: six digits and
 * nothing else, because what that step has to prove is that the new QR code
 * was scanned, and a backup code — which belongs to the old batch — cannot
 * prove that.
 */
export const changeMfaSchema = z.object({ code: MFA_CODE });
export class ChangeMfaDto extends createZodDto(changeMfaSchema) {}

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
 * Setting the FIRST password from an invitation link (AU-021, D-013).
 *
 * NO `currentPassword`, and that is the entire difference from the schema
 * above: whoever uses this has no password to prove. The token is what proves
 * they hold the invitation, and the account cannot sign in until this
 * succeeds.
 *
 * The strength policy is NOT duplicated here either — same reason as
 * `changePassword`: it lives in the domain, needs the account's own data to
 * refuse a password containing their name, and must be the same rules on every
 * path that sets a password. This is the path reachable WITHOUT
 * authentication, which is the one where a second, weaker copy would matter
 * most.
 */
export const setCredentialSchema = z.object({
  /**
   * Bounded so a caller cannot make the server hash an arbitrarily long
   * string before discovering the token is nonsense. 512 is far above the 43
   * characters a 32-byte base64url token actually takes.
   */
  token: z
    .string({ error: 'El enlace no es válido' })
    .min(1, 'El enlace no es válido')
    .max(512, 'El enlace no es válido'),
  password: z
    .string({ error: 'La contraseña es obligatoria' })
    .min(1, 'La contraseña es obligatoria')
    .max(256, 'La contraseña no puede superar 256 caracteres'),
});
export class SetCredentialDto extends createZodDto(setCredentialSchema) {}

/**
 * Whether an invitation link is still worth showing a form for (AU-028).
 *
 * ONE SHAPE FOR ALL THREE FAILURES — unknown, spent, expired — because telling
 * them apart on a public endpoint is an oracle over the secret itself.
 * `expiresAt` is withheld when invalid for the same reason: a date would
 * confirm the token existed.
 */
export const credentialTokenStatusSchema = z.object({
  valid: z.boolean(),
  /** `null` whenever `valid` is false. Never a reason. */
  expiresAt: z.iso.datetime().nullable(),
});
export class CredentialTokenStatusDto extends createZodDto(
  credentialTokenStatusSchema,
) {}
export type CredentialTokenStatusResponse = z.infer<
  typeof credentialTokenStatusSchema
>;

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
   * AU-005, AU-037. Whether THIS account has a second factor enrolled.
   *
   * ⚠️ ONE BOOLEAN, DELIBERATELY. Not the secret, not when it was enrolled,
   * not the last consumed step and not how many backup codes are left — that
   * count is an oracle over how close an account is to losing access, and
   * nothing on screen needs it.
   *
   * It is here because it is the OWNER'S OWN DATA and needs no permission to
   * read. The only other place it exists is `UserAccountDto`, behind `user:read`
   * over the whole payroll, which is administration looking at somebody else.
   */
  mfaEnabled: z.boolean(),
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

/**
 * AU-005. The backup codes, returned by `POST /auth/mfa/confirm`.
 *
 * ⚠️ THE ONLY TIME THEY ARE EVER SENT. Only their Argon2 hashes are stored, so
 * this response cannot be repeated — which is why the endpoint answers 200
 * with a body and no longer 204. An interface that discards it leaves the
 * person with a second factor and no way back if the phone is lost.
 */
export const mfaConfirmationResponseSchema = z.object({
  /** Ten codes in the printed form `ABCDE-FGHJK`. */
  backupCodes: z.array(z.string()),
});
export class MfaConfirmationResponseDto extends createZodDto(
  mfaConfirmationResponseSchema,
) {}
export type MfaConfirmationResponse = z.infer<
  typeof mfaConfirmationResponseSchema
>;
