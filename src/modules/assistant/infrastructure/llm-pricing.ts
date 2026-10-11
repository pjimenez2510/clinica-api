import { z } from 'zod';

import { PROVIDER_NAMES } from '../domain/llm-outcome';
import type { ModelPrice } from '../domain/pricing';

import pricingTable from './llm-pricing.json';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const priceSchema = z.object({
  model: z.string().min(1),
  provider: z.enum(PROVIDER_NAMES),
  validFrom: day,
  inputPerMillion: z.number().min(0),
  outputPerMillion: z.number().min(0),
  cacheReadPerMillion: z.number().min(0),
  cacheWritePerMillion: z.number().min(0),
  currency: z.literal('USD'),
  /** The day it was read. Without it the figure cannot be cited. */
  asOf: day,
  source: z.string().min(1),
});

const tableSchema = z.object({ models: z.array(priceSchema).min(1) });

/**
 * AS-016. The versioned price table, validated when the module loads: a
 * malformed table stops the boot instead of costing every call at nothing.
 * One currency only, so the ceiling never adds dollars to something else.
 */
export function parseLlmPricing(raw: unknown): ModelPrice[] {
  return tableSchema.parse(raw).models;
}

export const LLM_PRICES: readonly ModelPrice[] = parseLlmPricing(pricingTable);
