import type { z } from 'zod';

import type {
  LlmProvider,
  LlmRequest,
  ProviderAnswer,
} from '../src/modules/assistant/application/llm-client.port.ts';
import type {
  ModelTier,
  ProviderName,
} from '../src/modules/assistant/domain/llm-outcome.ts';
import {
  type FakeReply,
  FakeLlmProvider,
} from '../src/modules/assistant/infrastructure/fake-llm.provider.ts';

import type { NoteCase, PrescriptionCase } from './cases.ts';
import type { Catalogues } from './catalogue.ts';
import type { CallKey } from './runner.ts';
import { seeded } from './stats.ts';
import type { EvalCase } from './task.ts';
import type { Cie10EvalCase } from './tasks/cie10.ts';

/**
 * How a fake provider behaves: the chance of a right answer, how often it is
 * not available, and how long it takes. Invented, and chosen so the fake run
 * shows every column of the report moving — never read as a measurement.
 */
export interface FakeProfile {
  right: number;
  /** Extra chance of being right with the catalogue (arm D). */
  catalogueGain: number;
  unavailable503: number;
  rateLimited429: number;
  latencyMs: number;
}

export const FAKE_PROFILES: Readonly<
  Record<Exclude<ProviderName, 'fake'>, FakeProfile>
> = {
  gemini: { right: 0.7, catalogueGain: 0.15, unavailable503: 0.25, rateLimited429: 0.05, latencyMs: 4_000 }, // prettier-ignore
  anthropic: { right: 0.8, catalogueGain: 0.1, unavailable503: 0.02, rateLimited429: 0, latencyMs: 9_000 }, // prettier-ignore
  openai: { right: 0.75, catalogueGain: 0.1, unavailable503: 0.05, rateLimited429: 0.02, latencyMs: 6_000 }, // prettier-ignore
};

/**
 * EV-8. A world of fake providers that answer the cases of the harness, so a
 * whole run — routing, ceiling, retries, scores, intervals, report — goes
 * through without the network. Each answer goes through A4's own
 * `FakeLlmProvider`, so outcomes and parsing are the application's. The world
 * moves its own clock by each answer's latency.
 */
export class FakeWorld {
  private current: { key: CallKey; item: EvalCase } | null = null;
  private now: number;
  private readonly random: () => number;

  constructor(
    private readonly catalogues: Catalogues,
    seed: number,
    start: Date,
  ) {
    this.random = seeded(seed);
    this.now = start.getTime();
  }

  readonly clock = (): Date => new Date(this.now);

  /** The runner tells the world which case the next request plays. */
  readonly beforeCall = (key: CallKey, item: EvalCase): void => {
    this.current = { key, item };
  };

  /** Waiting between retries moves the world's clock, not the test's. */
  readonly sleep = (ms: number): Promise<void> => {
    this.now += ms;
    return Promise.resolve();
  };

  provider(name: Exclude<ProviderName, 'fake'>): LlmProvider {
    return this.make(name, `fake-${name}`, FAKE_PROFILES[name]);
  }

  /** The judge always answers; it says present or supported three times in four. */
  judge(): LlmProvider {
    return this.make('fake', 'fake-judge', {
      right: 0.75,
      catalogueGain: 0,
      unavailable503: 0,
      rateLimited429: 0,
      latencyMs: 3_000,
    });
  }

  private make(
    name: ProviderName,
    model: string,
    profile: FakeProfile,
  ): LlmProvider {
    const models: Record<ModelTier, string> = { fast: model, quality: model };
    return {
      name,
      modelFor: (tier) => models[tier],
      generate: <Shape extends z.ZodType>(
        request: LlmRequest<Shape>,
      ): Promise<ProviderAnswer<z.infer<Shape>>> => {
        const reply = this.reply(profile, request);
        this.now += Math.round(profile.latencyMs * (0.5 + this.random()));
        return new FakeLlmProvider([reply], name, models).generate(request);
      },
    };
  }

  private reply(
    profile: FakeProfile,
    request: LlmRequest<z.ZodType>,
  ): FakeReply {
    const roll = this.random();
    if (roll < profile.unavailable503) return { kind: 'status', status: 503 };
    if (roll < profile.unavailable503 + profile.rateLimited429) {
      return { kind: 'status', status: 429 };
    }
    if (this.current === null) throw new Error('FakeWorld: no case announced');
    const { key, item } = this.current;
    const right =
      this.random() <
      profile.right + (key.arm === 'D' ? profile.catalogueGain : 0);
    const usage = {
      inputTokens: Math.ceil(
        (request.system.length + request.prompt.length) / 4,
      ),
      outputTokens: 120,
    };
    const answer = (value: unknown): FakeReply => ({
      kind: 'answer',
      text: JSON.stringify(value),
      usage,
    });

    if (key.role === 'judge')
      return answer(this.verdicts(request.prompt, profile.right));
    switch (key.task) {
      case 'cie10':
        return answer(this.cie10(item as Cie10EvalCase, key.arm, right));
      case 'prescription':
        return answer(
          this.prescription(item as PrescriptionCase, key.arm, right),
        );
      case 'note':
        return answer(this.note(item as NoteCase, right));
    }
  }

  private cie10(item: Cie10EvalCase, arm: 'A' | 'D', right: boolean) {
    const category = item.code.slice(0, 3);
    const sibling = [...this.catalogues.cie10.keys()].find(
      (code) => code.startsWith(category) && code !== item.code,
    );
    if (right) return { codes: [item.code, ...(sibling ? [sibling] : [])] };
    // Wrong: a code that does not exist first (A has nothing to stop it), then a sibling.
    return {
      codes: [
        ...(arm === 'A' ? ['A00.5'] : []),
        ...(sibling ? [sibling] : []),
        'R69.X',
      ],
    };
  }

  private prescription(item: PrescriptionCase, arm: 'A' | 'D', right: boolean) {
    const e = item.expected;
    const schedule = {
      dose: e.dose,
      route: e.route.normalize('NFD').replace(/\p{Diacritic}/gu, ''),
      everyHours: e.everyHours,
      days: right ? e.days : null,
    };
    if (arm === 'A') {
      return {
        medicine: {
          substance: e.substance,
          form: e.form,
          concentration: right ? e.concentration : null,
          ...schedule,
        },
      };
    }
    const medicine = this.catalogues.cnmb.find((m) => m.code === e.cnmbCode);
    const index = medicine?.presentations.findIndex(
      (p) => p.form === e.form && p.concentration === e.concentration,
    );
    return {
      cnmbCode: right ? e.cnmbCode : 'ZZ99',
      presentation: index === undefined || index < 0 ? null : index + 1,
      ...schedule,
    };
  }

  private note(item: NoteCase, right: boolean) {
    const kept = right
      ? item.facts
      : item.facts.slice(0, Math.ceil(item.facts.length / 2));
    const sections = new Map<
      string,
      { text: string; source: number | null }[]
    >();
    for (const fact of kept) {
      sections.set(fact.section, [
        ...(sections.get(fact.section) ?? []),
        { text: fact.fact, source: 1 },
      ]);
    }
    if (!right)
      sections.set('plan', [
        ...(sections.get('plan') ?? []),
        { text: 'Reposo', source: null },
      ]);
    return {
      sections: [...sections].map(([section, segments]) => ({
        section,
        segments,
      })),
    };
  }

  /** Reads how many facts and phrases the judge's prompt numbers. */
  private verdicts(prompt: string, yes: number) {
    const count = (heading: string) => {
      const block = prompt.split(`${heading}:\n`)[1]?.split('\n\n')[0] ?? '';
      return block.split('\n').filter((line) => /^\d+\. /.test(line)).length;
    };
    return {
      facts: Array.from({ length: count('Hechos') }, (_, i) => ({
        n: i + 1,
        present: this.random() < yes,
      })),
      segments: Array.from({ length: count('Nota') }, (_, i) => ({
        n: i + 1,
        supported: this.random() < yes,
      })),
    };
  }
}
