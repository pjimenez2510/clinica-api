import { randomUUID } from 'node:crypto';

import type { AiRunStore } from '../src/modules/assistant/application/ai-run.store.ts';
import type { LlmProvider } from '../src/modules/assistant/application/llm-client.port.ts';
import { RoutingLlmClient } from '../src/modules/assistant/application/routing-llm.client.ts';
import type { ModelPrice } from '../src/modules/assistant/domain/pricing.ts';
import { LLM_PRICES } from '../src/modules/assistant/infrastructure/llm-pricing.ts';
import { PROVIDER_CHAIN } from '../src/modules/assistant/infrastructure/model-routing.ts';
import { buildProviderChain } from '../src/modules/assistant/infrastructure/provider-chain.ts';

/** EV-4. D-241 §1: the author's ceiling, 100 USD a month per clinic. */
export const EVAL_CEILING_CAP_USD = 100;

/**
 * EV-4. The ceiling of a run: the installation's, never above the author's
 * 100 USD. Without a valid value there is none, and the routing then makes
 * no remote attempt at all (AS-017, closed by default).
 */
export function ceilingFrom(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, EVAL_CEILING_CAP_USD);
}

/**
 * Prices of the fake models, so the fake run goes through the same ceiling
 * and cost arithmetic as a real one. Not real money: the report says
 * «proveedor falso» next to every figure.
 */
export const FAKE_PRICES: readonly ModelPrice[] = [
  'fake-fast',
  'fake-quality',
  'fake-gemini',
  'fake-anthropic',
  'fake-openai',
  'fake-judge',
].map((model) => ({
  model,
  provider: 'fake' as const,
  validFrom: '2026-01-01',
  inputPerMillion: 1,
  outputPerMillion: 5,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
  currency: 'USD',
  asOf: '2026-10-11',
  source: 'arnés de evaluación: precio ficticio del proveedor falso',
}));

type Env = Record<string, string | undefined>;

/**
 * EV-3. The real providers, each with its key, in the order of
 * `model-routing.ts` — through A4's own `buildProviderChain`, so the same
 * switch guards them: unless `ASSISTANT_ALLOW_REMOTE` is exactly `true`
 * nothing is built and nothing leaves (AS-006, SC-089).
 */
export function realProviders(
  env: Env,
  fetcher: typeof fetch = fetch,
): { measured: LlmProvider[]; withoutKey: string[] } {
  if (env.ASSISTANT_ALLOW_REMOTE !== 'true') {
    throw new Error(
      'ASSISTANT_ALLOW_REMOTE no es «true» en el .env de este worktree: la corrida real no llama a ningún proveedor. Use --falso, o encienda la variable y ponga las claves (sólo con casos inventados o de CodiEsp).',
    );
  }
  const keys = {
    gemini: env.ASSISTANT_GEMINI_API_KEY || undefined,
    anthropic: env.ASSISTANT_ANTHROPIC_API_KEY || undefined,
    openai: env.ASSISTANT_OPENAI_API_KEY || undefined,
  };
  const measured = buildProviderChain({ allowRemote: true, keys }, fetcher);
  return {
    measured,
    withoutKey: PROVIDER_CHAIN.filter((name) => !keys[name]),
  };
}

export interface ClientOptions {
  store: AiRunStore;
  ceilingUsd: number | undefined;
  timeoutMs: number;
  clock: () => Date;
  prices?: readonly ModelPrice[];
}

/**
 * One client per provider, with that provider alone in its chain: a 503 is
 * that provider's error and is not covered by the next one, which is what
 * D-239 §5 asks to measure. Everything else is the application's routing.
 */
export function clientFor(provider: LlmProvider, options: ClientOptions) {
  return new RoutingLlmClient({
    providers: [provider],
    store: options.store,
    prices: options.prices ?? [...LLM_PRICES, ...FAKE_PRICES],
    ceilingUsd: options.ceilingUsd,
    timeoutMs: options.timeoutMs,
    exchangeLog: false,
    clock: options.clock,
    newRequestId: randomUUID,
  });
}
