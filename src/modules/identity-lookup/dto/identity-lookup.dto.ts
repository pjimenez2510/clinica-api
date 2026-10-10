import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Cedula } from '../../../shared/domain/value-objects/cedula.vo';
import { IDENTITY_SOURCES } from '../domain/identity-proposal';

/**
 * The identity-lookup contract. Responses are schemas too: the web generates
 * its types from the OpenAPI document.
 */

/**
 * IL-004, IL-011. ONE cedula, in the BODY: a path ends up in the access logs
 * of any proxy on the way, and a third party's cedula has no business there.
 * `strict`: a list of cedulas is not a typo to ignore, it is a batch (D-206).
 */
export const proposalRequestSchema = z
  .object({
    cedula: z
      .string({ error: 'La cédula es obligatoria' })
      .trim()
      .refine((value) => Cedula.isValid(value), {
        error: 'La cédula no es válida: revise los diez dígitos',
      }),
  })
  .strict();
export class ProposalRequestDto extends createZodDto(proposalRequestSchema) {}

export const identityProposalSchema = z.object({
  source: z.enum(IDENTITY_SOURCES),
  /** IL-005. The name exactly as the source wrote it. */
  sourceName: z.string(),
  familyName: z.string().nullable(),
  secondFamilyName: z.string().nullable(),
  givenName: z.string().nullable(),
  secondGivenName: z.string().nullable(),
  /** `YYYY-MM-DD`, only when the source carries it. */
  birthDate: z.string().nullable(),
  /** IL-005, D-209. The split is a convention: the screen must say so. */
  orderToReview: z.boolean(),
  lookedUpAt: z.iso.datetime(),
});

/** IL-001. `proposal: null` is the ordinary answer, not an error. */
export const proposalResponseSchema = z.object({
  proposal: identityProposalSchema.nullable(),
});
export class ProposalResponseDto extends createZodDto(proposalResponseSchema) {}
export type ProposalResponse = z.infer<typeof proposalResponseSchema>;

export const identityLookupSettingsSchema = z.object({
  externalSourcesEnabled: z.boolean(),
  /** The latest registry file imported, or `null` when none was. */
  registry: z
    .object({
      fileName: z.string(),
      importedAt: z.iso.datetime(),
      people: z.number().int(),
    })
    .nullable(),
  providerConfigured: z.boolean(),
  digestKeyConfigured: z.boolean(),
});
export class IdentityLookupSettingsDto extends createZodDto(
  identityLookupSettingsSchema,
) {}
export type IdentityLookupSettingsResponse = z.infer<
  typeof identityLookupSettingsSchema
>;

export const updateIdentityLookupSettingsSchema = z
  .object({ externalSourcesEnabled: z.boolean() })
  .strict();
export class UpdateIdentityLookupSettingsDto extends createZodDto(
  updateIdentityLookupSettingsSchema,
) {}
