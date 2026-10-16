import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** AS-313. «Mi voz»: never the vector (AS-319). */
const voiceprintSchema = z.object({
  /** The voice registered, or null. */
  registered: z
    .object({
      phrases: z.number().int(),
      seconds: z.number(),
      consentedAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  /** «Distinguir mi voz de la del paciente». Off by default. */
  attribution: z.boolean(),
  /** Whether the voice service can tell voices apart now. */
  available: z.boolean(),
  /** Why not, in a sentence for the professional; null when it can. */
  reason: z.string().nullable(),
});

/** AS-313. The switch. */
const attributionSchema = z.object({ on: z.boolean() });

/** AS-310. `consent=true` is the owner's consent, given on that screen. */
const consentSchema = z.object({
  consent: z.enum(['true', 'false']).optional(),
});

export class VoiceprintDto extends createZodDto(voiceprintSchema) {}
export class VoiceprintAttributionDto extends createZodDto(attributionSchema) {}
export class VoiceprintConsentQueryDto extends createZodDto(consentSchema) {}
