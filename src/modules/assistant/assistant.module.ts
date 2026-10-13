import express from 'express';
import { randomUUID } from 'node:crypto';

import {
  Global,
  Inject,
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ACCESS_AUDIT_RECORDER } from '../../shared/audit/access-audit.port';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { CIE10_LOOKUP } from '../../shared/clinical/cie10-lookup.port';
import { ALLERGY_ABSENCE_READER } from '../../shared/clinical/allergy-absence.port';
import { ASSISTANT_AT_SIGNING } from '../../shared/clinical/assistant-at-signing.port';
import { ASSISTANT_SITE_SWITCH } from '../../shared/clinical/assistant-site-switch.port';
import { RECORDING_AUTHORIZATION } from '../../shared/clinical/recording-authorization.port';
import { assistantEnabledProvider } from '../../shared/config/assistant-enabled';
import { CODING_CONTEXT_READER } from '../../shared/clinical/coding-context.port';
import { NOTE_DRAFT_CONTEXT_READER } from '../../shared/clinical/note-draft-context.port';
import { SURVIVING_CHART_ALLERGY_READER } from '../../shared/clinical/patient-allergy.port';
import { ORDERING_CONTEXT_READER } from '../../shared/clinical/ordering-context.port';
import { PRESCRIBING_CONTEXT_READER } from '../../shared/clinical/prescribing-context.port';
import type { Env } from '../../shared/config/env.schema';
import { DomainError } from '../../shared/domain/errors/domain-error';
import { PrismaAccessAuditRecorder } from '../../shared/infrastructure/audit/prisma-access-audit.recorder';
import { PrismaCie10Lookup } from '../../shared/infrastructure/clinical/prisma-cie10.lookup';
import { PrismaActiveAllergyReader } from '../../shared/infrastructure/clinical/prisma-active-allergy.reader';
import { PrismaAssistantSiteSwitch } from '../../shared/infrastructure/clinical/prisma-assistant-site-switch';
import { PrismaRecordingAuthorization } from '../../shared/infrastructure/clinical/prisma-recording-authorization';
import { PrismaCodingContextReader } from '../../shared/infrastructure/clinical/prisma-coding-context.reader';
import { PrismaNoteDraftContextReader } from '../../shared/infrastructure/clinical/prisma-note-draft-context.reader';
import { PrismaOrderingContextReader } from '../../shared/infrastructure/clinical/prisma-ordering-context.reader';
import { PrismaPrescribingContextReader } from '../../shared/infrastructure/clinical/prisma-prescribing-context.reader';
import { PrismaAllergyAbsenceReader } from '../../shared/infrastructure/clinical/standing-allergy-absence';

import { AI_RUN_STORE, type AiRunStore } from './application/ai-run.store';
import {
  ASSISTANT_DEMO,
  DIAGNOSIS_PROPOSAL_CLOCK,
  DiagnosisProposalService,
} from './application/diagnosis-proposal.service';
import { LLM_CLIENT, type LlmClient } from './application/llm-client.port';
import {
  PSEUDONYMIZER,
  type Pseudonymizer,
} from './application/pseudonymizer.port';
import { RoutingLlmClient } from './application/routing-llm.client';
import { AssistantDiagnosisController } from './assistant-diagnosis.controller';
import { AssistantOrdersController } from './assistant-orders.controller';
import { AssistantPrescriptionController } from './assistant-prescription.controller';
import { OrderProposalService } from './application/order-proposal.service';
import { PrescriptionProposalService } from './application/prescription-proposal.service';
import { AssistantListeningController } from './assistant-listening.controller';
import { AssistantNoteDraftController } from './assistant-note-draft.controller';
import { AssistantNoteQuestionsController } from './assistant-note-questions.controller';
import {
  NOTE_DRAFT_CLOCK,
  NoteDraftService,
} from './application/note-draft.service';
import { NOTE_DRAFT_STORE } from './application/note-draft.store';
import { NOTE_QUESTION_CHECK_STORE } from './application/note-question-check.store';
import { NoteQuestionService } from './application/note-question.service';
import { TRANSCRIPT_OBSERVER } from './application/transcript-observer.port';
import { PrismaNoteDraftStore } from './infrastructure/prisma-note-draft.store';
import { PrismaNoteQuestionCheckStore } from './infrastructure/prisma-note-question-check.store';
import {
  SIGNING_REVIEW_CLOCK,
  SigningReviewService,
} from './application/signing-review.service';
import { SUGGESTION_REVIEW_STORE } from './application/suggestion-review.store';
import { PrismaSuggestionReviewStore } from './infrastructure/prisma-suggestion-review.store';
import { AssistantSwitchMiddleware } from './assistant-switch.middleware';
import { AssistantHistoryController } from './assistant-history.controller';
import {
  CLINICAL_HISTORY_CLOCK,
  CLINICAL_HISTORY_READER,
} from './application/clinical-history.reader';
import { ClinicalHistoryService } from './application/clinical-history.service';
import { PrismaClinicalHistoryReader } from './infrastructure/prisma-clinical-history.reader';
import {
  AssistantVitalsDictationController,
  MAX_DICTATION_BYTES,
} from './assistant-vitals-dictation.controller';
import {
  DICTATION_TRANSCRIBER,
  type DictationTranscriber,
} from './application/dictation-transcriber.port';
import { VitalsDictationService } from './application/vitals-dictation.service';
import { dictationTranscriberFor } from './infrastructure/clinica-ai.dictation-transcriber';
import { ListeningAccess } from './application/listening-access';
import {
  LISTENING_CLOCK,
  ListeningService,
  PREPARATION_LISTENING,
  type ListeningClock,
} from './application/listening.service';
import {
  LISTENING_STORE,
  PREPARATION_LISTENING_STORE,
  type ListeningStore,
} from './application/listening.store';
import {
  SPEECH_RECOGNIZER,
  type SpeechRecognizer,
} from './application/speech-recognizer.port';
import { ListeningUnavailableError } from './domain/assistant.errors';
import { ClinicaAiSpeechRecognizer } from './infrastructure/clinica-ai.speech-recognizer';
import {
  LISTENING_GATEWAY_OPTIONS,
  ListeningGateway,
} from './infrastructure/listening.gateway';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { AssistantPreparationController } from './assistant-preparation.controller';
import { PrismaListeningStore } from './infrastructure/prisma-listening.store';
import {
  SUGGESTION_CLOCK,
  SuggestionService,
} from './application/suggestion.service';
import { SUGGESTION_STORE } from './application/suggestion.store';
import {
  DEMO_PRICES,
  DemoLlmProvider,
} from './infrastructure/demo/demo-llm.provider';
import { DemoPseudonymizer } from './infrastructure/demo/demo.pseudonymizer';
import { LLM_PRICES } from './infrastructure/llm-pricing';
import { PrismaAiRunStore } from './infrastructure/prisma-ai-run.store';
import { PrismaSuggestionStore } from './infrastructure/prisma-suggestion.store';
import { pseudonymizerFor } from './infrastructure/clinica-ai.pseudonymizer';
import { buildProviderChain } from './infrastructure/provider-chain';

/**
 * The assistant (PLAN-ASISTENTE-IA.md). Composition root of the one door to a
 * language model: configuration decides which providers exist (AS-006), the
 * routing walks them (D-239 §5), and `ai_run` keeps every attempt.
 *
 * Its controllers are the CIE-10 of Diagnósticos (D1), the receta of
 * Receta (D2) and the exams of Exámenes (D3), behind
 * `ASSISTANT_ENABLED` and `assistant:use` (AS-026, D-244 §3).
 */
/** AS-015. Once a day: the retention is counted in days. */
const PURGE_EVERY_MS = 86_400_000;

/**
 * `@Global` FOR ONE TOKEN, `ASSISTANT_AT_SIGNING` (E1): `encounter` asks it
 * before a signature and tells it after, without importing this module — the
 * shape `billing` gives `CONSULTATION_REPRICER`.
 */
@Global()
@Module({
  controllers: [
    AssistantDiagnosisController,
    AssistantListeningController,
    AssistantNoteDraftController,
    AssistantNoteQuestionsController,
    AssistantPrescriptionController,
    AssistantOrdersController,
    // AS-200 (D-256 §1). Outside the switch: no model, nothing leaves.
    AssistantHistoryController,
    AssistantVitalsDictationController,
    AssistantPreparationController,
  ],
  providers: [
    { provide: AI_RUN_STORE, useClass: PrismaAiRunStore },
    // AS-020 to AS-024. The provenance of each proposal.
    { provide: SUGGESTION_STORE, useClass: PrismaSuggestionStore },
    { provide: SUGGESTION_CLOCK, useValue: () => new Date() },
    SuggestionService,
    {
      provide: LLM_CLIENT,
      inject: [ConfigService, AI_RUN_STORE],
      useFactory: buildLlmClient,
    },
    // AS-025, AS-029, AS-031. clinica-ai with its shared secret; without it,
    // MissingPseudonymizer: fails closed. The demonstration mode has its fake.
    {
      provide: PSEUDONYMIZER,
      inject: [ConfigService],
      useFactory: buildPseudonymizer,
    },
    // AS-027, AS-028, AS-035. What the assistant reads, through `shared/`.
    { provide: CODING_CONTEXT_READER, useClass: PrismaCodingContextReader },
    { provide: CIE10_LOOKUP, useClass: PrismaCie10Lookup },
    { provide: ACCESS_AUDIT_RECORDER, useClass: PrismaAccessAuditRecorder },
    { provide: DIAGNOSIS_PROPOSAL_CLOCK, useValue: () => new Date() },
    {
      provide: ASSISTANT_DEMO,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): boolean =>
        config.get('ASSISTANT_FAKE_PROVIDER', { infer: true }) === true,
    },
    assistantEnabledProvider,
    // AS-161 (A3). The sites with the assistant on, read on each request.
    { provide: ASSISTANT_SITE_SWITCH, useClass: PrismaAssistantSiteSwitch },
    // AS-165 to AS-168. The patient's authorization to record (D-221 §3).
    { provide: RECORDING_AUTHORIZATION, useClass: PrismaRecordingAuthorization }, // prettier-ignore
    DiagnosisProposalService,
    // AS-063 to AS-078 (D2). The receta: the cuadro and the receta of the
    // attention, and the allergies through the SAME reader the receta checks
    // with (PR-062, PR-118), so the two cannot disagree.
    { provide: PRESCRIBING_CONTEXT_READER, useClass: PrismaPrescribingContextReader }, // prettier-ignore
    { provide: SURVIVING_CHART_ALLERGY_READER, useClass: PrismaActiveAllergyReader }, // prettier-ignore
    { provide: ALLERGY_ABSENCE_READER, useClass: PrismaAllergyAbsenceReader },
    PrescriptionProposalService,
    // AS-103 to AS-113 (D3). The exams: the clinic's orderable catalogue and
    // the orders of the attention, read; the order is written by `orders`.
    { provide: ORDERING_CONTEXT_READER, useClass: PrismaOrderingContextReader }, // prettier-ignore
    OrderProposalService,
    CurrentUserService,
    // AS-045 to AS-058. The listening (C1).
    {
      provide: LISTENING_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaListeningStore(prisma, 'CONSULTATION'),
    },
    { provide: LISTENING_CLOCK, useValue: () => new Date() },
    {
      provide: SPEECH_RECOGNIZER,
      inject: [ConfigService],
      useFactory: buildSpeechRecognizer,
    },
    {
      provide: LISTENING_GATEWAY_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        origins: config.get('CORS_ORIGINS', { infer: true }),
      }),
    },
    ListeningService,
    // AS-240 to AS-244 (B3). The preparation: the same listening, over its own
    // store and without the draft's observer (AS-242).
    {
      provide: PREPARATION_LISTENING_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaListeningStore(prisma, 'PREPARATION'),
    },
    {
      provide: PREPARATION_LISTENING,
      inject: [SPEECH_RECOGNIZER, PREPARATION_LISTENING_STORE, LISTENING_CLOCK],
      useFactory: (
        recognizer: SpeechRecognizer,
        store: ListeningStore,
        clock: ListeningClock,
      ) => new ListeningService(recognizer, store, clock),
    },
    ListeningAccess,
    ListeningGateway,
    // AS-086 to AS-097. The draft of the note (C2), told by the listening.
    { provide: NOTE_DRAFT_STORE, useClass: PrismaNoteDraftStore },
    { provide: NOTE_DRAFT_CONTEXT_READER, useClass: PrismaNoteDraftContextReader }, // prettier-ignore
    { provide: NOTE_DRAFT_CLOCK, useValue: () => new Date() },
    NoteDraftService,
    { provide: TRANSCRIPT_OBSERVER, useExisting: NoteDraftService },
    { provide: NOTE_QUESTION_CHECK_STORE, useClass: PrismaNoteQuestionCheckStore }, // prettier-ignore
    NoteQuestionService,
    // AS-140 to AS-146 (E1). What a signature asks and tells.
    { provide: SUGGESTION_REVIEW_STORE, useClass: PrismaSuggestionReviewStore },
    { provide: SIGNING_REVIEW_CLOCK, useValue: () => new Date() },
    SigningReviewService,
    { provide: ASSISTANT_AT_SIGNING, useExisting: SigningReviewService },
    // AS-200 to AS-207 (B1). The history without a model.
    { provide: CLINICAL_HISTORY_READER, useClass: PrismaClinicalHistoryReader },
    { provide: CLINICAL_HISTORY_CLOCK, useValue: () => new Date() },
    ClinicalHistoryService,
    // AS-180 to AS-186 (B2). The dictated vital signs: clinica-ai transcribes,
    // a rule reads; no model, nothing kept.
    {
      provide: DICTATION_TRANSCRIBER,
      inject: [ConfigService],
      useFactory: buildDictationTranscriber,
    },
    VitalsDictationService,
  ],
  // Only the port `encounter` asks at a signature: `@Global` makes every
  // export injectable anywhere, and the model client is not for anyone else.
  exports: [ASSISTANT_AT_SIGNING],
})
export class AssistantModule
  implements NestModule, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AssistantModule.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(AI_RUN_STORE) private readonly store: AiRunStore,
    @Inject(LISTENING_STORE) private readonly listening: ListeningStore,
    private readonly signing: SigningReviewService,
  ) {}

  /** AS-026. The switch answers before the session and the permission do. */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AssistantSwitchMiddleware)
      .forRoutes(
        AssistantDiagnosisController,
        AssistantListeningController,
        AssistantNoteDraftController,
        AssistantNoteQuestionsController,
        AssistantPrescriptionController,
        AssistantOrdersController,
        AssistantVitalsDictationController,
        AssistantPreparationController,
      );
    // AS-186. The recording as raw bytes, whatever its type, capped at the
    // socket: a larger one is the parser's 413 before it reaches clinica-ai
    // (as DOC-052). Mounted after the switch, so an assistant that is off
    // still answers 404 first.
    consumer
      .apply(express.raw({ type: () => true, limit: MAX_DICTATION_BYTES }))
      .forRoutes(AssistantVitalsDictationController);
  }

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

  /**
   * AS-015, AS-057. The text of the exchanges and the transcripts past their
   * days, each on its own: one failing does not keep the other.
   */
  private async purge(): Promise<void> {
    await this.purgeTranscripts();
    await this.reviewSigned();
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

  /** AS-144. What a signature could not review, reviewed now. */
  private async reviewSigned(): Promise<void> {
    try {
      await this.signing.sweep();
    } catch (error) {
      this.logger.warn(
        {
          dependency: 'ai_suggestion_review',
          error_code: error instanceof DomainError ? error.code : 'unknown',
        },
        'signed notes could not be reviewed',
      );
    }
  }

  private async purgeTranscripts(): Promise<void> {
    try {
      await this.listening.purge(new Date());
    } catch (error) {
      this.logger.warn(
        {
          dependency: 'transcript_segment',
          error_code: error instanceof Error ? error.name : 'unknown',
        },
        'transcript purge failed',
      );
    }
  }
}

type Config = ConfigService<Env, true>;

/** AS-186. Long enough for two minutes of speech on this machine's recogniser. */
const DICTATION_TIMEOUT_MS = 60_000;

/**
 * AS-186. `clinica-ai`'s short dictation with the shared secret; without the
 * secret nothing is sent and «Dictar» says the recogniser is not available.
 */
export function buildDictationTranscriber(
  config: Config,
): DictationTranscriber {
  return dictationTranscriberFor({
    url: config.get('ASSISTANT_AI_SERVICE_URL', { infer: true }),
    secret:
      config.get('ASSISTANT_AI_SERVICE_SECRET', { infer: true }) || undefined,
    timeoutMs: DICTATION_TIMEOUT_MS,
  });
}

/**
 * AS-048. `clinica-ai`'s recogniser with the shared secret; without the
 * secret nothing can listen, and saying so is the answer to «Escuchar».
 */
export function buildSpeechRecognizer(config: Config): SpeechRecognizer {
  const secret = config.get('ASSISTANT_AI_SERVICE_SECRET', { infer: true });
  if (!secret) {
    return {
      open: () => Promise.reject(new ListeningUnavailableError('unreachable')),
    };
  }
  return new ClinicaAiSpeechRecognizer({
    baseUrl: config.get('ASSISTANT_AI_SERVICE_URL', { infer: true }),
    secret,
    timeoutMs: config.get('ASSISTANT_AI_SERVICE_TIMEOUT_MS', { infer: true }),
  });
}

/**
 * AS-006, AS-029. The one door to a model. In the demonstration mode the only
 * provider is the script, priced at zero; `validateEnv` has already refused
 * that mode with any road to a real provider.
 */
export function buildLlmClient(config: Config, store: AiRunStore): LlmClient {
  const demo = config.get('ASSISTANT_FAKE_PROVIDER', { infer: true });
  const ceiling = config.get('ASSISTANT_MONTHLY_SPEND_CEILING_USD', { infer: true }); // prettier-ignore
  return new RoutingLlmClient({
    providers: demo
      ? [new DemoLlmProvider()]
      : buildProviderChain({
          allowRemote: config.get('ASSISTANT_ALLOW_REMOTE', { infer: true }),
          keys: {
            gemini: config.get('ASSISTANT_GEMINI_API_KEY', { infer: true }),
            anthropic: config.get('ASSISTANT_ANTHROPIC_API_KEY', { infer: true }), // prettier-ignore
            openai: config.get('ASSISTANT_OPENAI_API_KEY', { infer: true }),
          },
        }),
    store,
    prices: demo ? DEMO_PRICES : LLM_PRICES,
    // The script costs nothing; a ceiling of zero still admits it.
    ceilingUsd: demo ? (ceiling ?? 0) : ceiling,
    timeoutMs: config.get('ASSISTANT_PROVIDER_TIMEOUT_MS', { infer: true }),
    exchangeLog: config.get('ASSISTANT_EXCHANGE_LOG', { infer: true }),
    clock: () => new Date(),
    newRequestId: randomUUID,
  });
}

/**
 * AS-025, AS-029, AS-031. The demonstration's fake, or clinica-ai —
 * `MissingPseudonymizer` while it has no shared secret.
 */
export function buildPseudonymizer(config: Config): Pseudonymizer {
  return config.get('ASSISTANT_FAKE_PROVIDER', { infer: true })
    ? new DemoPseudonymizer()
    : pseudonymizerFor({
        url: config.get('ASSISTANT_AI_SERVICE_URL', { infer: true }),
        secret: config.get('ASSISTANT_AI_SERVICE_SECRET', { infer: true }),
        timeoutMs: config.get('ASSISTANT_AI_SERVICE_TIMEOUT_MS', { infer: true }), // prettier-ignore
      });
}
