/**
 * Every business error code the API can return, in one place.
 *
 * WHY A FROZEN LIST. The README promises that `code` is "stable and never
 * translated: the contract consumed by clients, logs and alerts". Until this
 * existed, those codes were spread across ten files in three layers, nothing
 * prevented two classes declaring the same one — and two of them already did —
 * and there was nowhere to read what the API could answer. A public contract
 * that cannot be enumerated is not a contract.
 *
 * The list is maintained by hand ON PURPOSE. `error-catalogue.spec.ts` reads
 * the source and fails if the two disagree, so renaming a code becomes a line
 * in a diff that somebody reviews instead of a silent change that breaks an
 * integrator's alert at 3am.
 *
 * NOT included: codes produced by the HTTP layer from a status
 * (`NOT_FOUND`, `PAYLOAD_TOO_LARGE`, …) or by the database mapping
 * (`PRACTITIONER_SLOT_TAKEN`, …). Those have their own tables, which are
 * themselves the enumeration.
 */
export const DOMAIN_ERROR_CODES = [
  'ACCOUNT_INACTIVE',
  'INVALID_CEDULA',
  'INVALID_CREDENTIALS',
  'INVALID_MFA_CODE',
  'INVALID_REFRESH_TOKEN',
  'INVALID_TOKEN',
  'INVALID_TOTP_CODE',
  'MFA_ALREADY_ENROLLED',
  'MFA_NOT_ENROLLED',
  'MFA_REQUIRED',
  'MISSING_REFRESH_TOKEN',
  'MISSING_TOKEN',
  'PERMISSION_DENIED',
  'PRINCIPAL_UNAVAILABLE',
  'REFRESH_TOKEN_REUSE_DETECTED',
  'ROUTE_NOT_SECURED',
  'SESSION_USER_MISSING',
  'SITE_SCOPE_DENIED',
  'WEAK_PASSWORD',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
