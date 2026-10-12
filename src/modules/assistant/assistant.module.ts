import { randomUUID } from 'node:crypto';

import {
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../shared/config/env.schema';

import { AI_RUN_STORE, type AiRunStore } from './application/ai-run.store';
import { LLM_CLIENT, type LlmClient } from './application/llm-client.port';
import { PSEUDONYMIZER } from './application/pseudonymizer.port';
import { RoutingLlmClient } from './application/routing-llm.client';
import { LLM_PRICES } from './infrastructure/llm-pricing';
import { PrismaAiRunStore } from './infrastructure/prisma-ai-run.store';
import { pseudonymizerFor } from './infrastructure/clinica-ai.pseudonymizer';
import { buildProviderChain } from './infrastructure/provider-chain';

/**
 * The assistant (PLAN-ASISTENTE-IA.md). Composition root of the one door to a
 * language model: configuration decides which providers exist (AS-006), the
 * routing walks them (D-239 §5), and `ai_run` keeps every attempt.
 *
 * No controller: nothing here answers HTTP yet. Whoever exposes a route
 * declares its permission (REQ-118, A3).
 */
/** AS-015. Once a day: the retention is counted in days. */
const PURGE_EVERY_MS = 86_400_000;

@Module({
  providers: [
    { provide: AI_RUN_STORE, useClass: PrismaAiRunStore },
    {
      provide: LLM_CLIENT,
      inject: [ConfigService, AI_RUN_STORE],
      useFactory: (
        config: ConfigService<Env, true>,
        store: AiRunStore,
      ): LlmClient =>
        new RoutingLlmClient({
          providers: buildProviderChain({
            allowRemote: config.get('ASSISTANT_ALLOW_REMOTE', { infer: true }),
            keys: {
              gemini: config.get('ASSISTANT_GEMINI_API_KEY', { infer: true }),
              anthropic: config.get('ASSISTANT_ANTHROPIC_API_KEY', { infer: true }), // prettier-ignore
              openai: config.get('ASSISTANT_OPENAI_API_KEY', { infer: true }),
            },
          }),
          store,
          prices: LLM_PRICES,
          ceilingUsd: config.get('ASSISTANT_MONTHLY_SPEND_CEILING_USD', { infer: true }), // prettier-ignore
          timeoutMs: config.get('ASSISTANT_PROVIDER_TIMEOUT_MS', { infer: true }), // prettier-ignore
          exchangeLog: config.get('ASSISTANT_EXCHANGE_LOG', { infer: true }),
          clock: () => new Date(),
          newRequestId: randomUUID,
        }),
    },
    {
      // AS-031. Without the shared secret, MissingPseudonymizer: fails closed.
      provide: PSEUDONYMIZER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        pseudonymizerFor({
          url: config.get('ASSISTANT_AI_SERVICE_URL', { infer: true }),
          secret: config.get('ASSISTANT_AI_SERVICE_SECRET', { infer: true }),
          timeoutMs: config.get('ASSISTANT_AI_SERVICE_TIMEOUT_MS', { infer: true }), // prettier-ignore
        }),
    },
  ],
  exports: [LLM_CLIENT, PSEUDONYMIZER],
})
export class AssistantModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantModule.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(AI_RUN_STORE) private readonly store: AiRunStore) {}

  /**
   * AS-015. The purge runs at boot and then once a day, whether the exchange
   * log is on or not: text past its days goes even when nothing new is written
   * and the API is never restarted. A failure does not stop the API: it says
   * so, and the next run retries.
   */
  onModuleInit(): void {
    void this.purge();
    this.timer = setInterval(() => void this.purge(), PURGE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async purge(): Promise<void> {
    try {
      await this.store.purgeExchanges(new Date());
    } catch (error) {
      this.logger.warn(
        {
          dependency: 'ai_exchange',
          error_code: error instanceof Error ? error.name : 'unknown',
        },
        'assistant exchange purge failed',
      );
    }
  }
}
