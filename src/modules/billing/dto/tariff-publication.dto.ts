import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * BI-110 to BI-115. The tariff on the wall, over HTTP.
 *
 * Amounts and percentages leave as STRINGS (BI-001): `JSON.parse` would turn
 * a number back into a float and lose the cent.
 */

/** One price as the wall shows it. */
const shownPriceSchema = z.object({
  amount: z.string(),
  /** `null` for «no objeto» and «exento». */
  taxPercentage: z.string().nullable(),
});

/**
 * BI-110, BI-112. THE PUBLIC VIEW, AND EVERY KEY IN IT IS A DECISION. What was
 * published —version, the day it rules from, the clinic's name, and per line
 * the category, the name, the price and its tax— and nothing else: no id, no
 * code, no author, no payer, no list. A key added here is a key the whole
 * internet reads; `billing-tariff-publication-http.spec.ts` lists them exactly.
 */
const publicTariffSchema = z.object({
  version: z.number().int(),
  effectiveFrom: z.string(),
  establishmentName: z.string().nullable(),
  items: z.array(
    shownPriceSchema.extend({
      categoryName: z.string(),
      name: z.string(),
    }),
  ),
});
export class PublicTariffDto extends createZodDto(publicTariffSchema) {}
export type PublicTariffResponse = z.infer<typeof publicTariffSchema>;

const publicationSummarySchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  effectiveFrom: z.string(),
  publishedAt: z.iso.datetime(),
  publishedBy: z.object({ id: z.uuid(), name: z.string() }),
  establishmentName: z.string().nullable(),
  lineCount: z.number().int(),
});

/** BI-113. One publication, as it was copied. */
const publicationSchema = publicationSummarySchema.extend({
  items: z.array(
    shownPriceSchema.extend({
      billableServiceId: z.uuid(),
      code: z.string(),
      name: z.string(),
      categoryName: z.string(),
    }),
  ),
});
export class TariffPublicationDto extends createZodDto(publicationSchema) {}
export type TariffPublicationResponse = z.infer<typeof publicationSchema>;

/**
 * BI-115. How the wall and the list differ: `published` is `null` on an
 * `ADDED` line and `current` on a `WITHDRAWN` one.
 */
const differenceSchema = z.object({
  kind: z.enum(['PRICE_CHANGED', 'WITHDRAWN', 'ADDED']),
  billableServiceId: z.uuid(),
  name: z.string(),
  published: shownPriceSchema.nullable(),
  current: shownPriceSchema.nullable(),
});

/** BI-113, BI-115. Every publication, newest first, and the newest's state. */
const overviewSchema = z.object({
  items: z.array(publicationSummarySchema),
  latest: z
    .object({
      id: z.uuid(),
      version: z.number().int(),
      /** Empty: the wall says what the list charges today. */
      differences: z.array(differenceSchema),
    })
    .nullable(),
});
export class TariffPublicationOverviewDto extends createZodDto(
  overviewSchema,
) {}
export type TariffPublicationOverviewResponse = z.infer<typeof overviewSchema>;
