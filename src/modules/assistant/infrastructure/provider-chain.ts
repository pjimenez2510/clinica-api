import type { LlmProvider } from '../application/llm-client.port';

import { AnthropicProvider } from './anthropic.provider';
import { GeminiProvider } from './gemini.provider';
import { PROVIDER_CHAIN } from './model-routing';
import { OpenAiProvider } from './openai.provider';

export interface ChainConfig {
  allowRemote: boolean;
  keys: {
    gemini?: string;
    anthropic?: string;
    openai?: string;
  };
}

/**
 * AS-006, AS-010. The providers of the chain, in the order of
 * `PROVIDER_CHAIN`, each only with its key — and none at all unless the
 * installation allows remote calls. A provider left out is never built, so
 * there is nothing that could call it (SC-089).
 */
export function buildProviderChain(
  config: ChainConfig,
  fetcher: typeof fetch = fetch,
): LlmProvider[] {
  if (!config.allowRemote) return [];
  return PROVIDER_CHAIN.flatMap((name): LlmProvider[] => {
    const key = config.keys[name];
    if (!key) return [];
    switch (name) {
      case 'gemini':
        return [new GeminiProvider(key, fetcher)];
      case 'anthropic':
        return [AnthropicProvider.withKey(key)];
      case 'openai':
        return [new OpenAiProvider(key, fetcher)];
    }
  });
}
