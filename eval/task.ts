import type { z } from 'zod';

import type { LlmRequest } from '../src/modules/assistant/application/llm-client.port.ts';

/**
 * PLAN-ASISTENTE-IA §5. A: no catalogue, nothing checks what the model
 * wrote. D: candidates searched in the catalogue go in the prompt, the model
 * chooses, and a deterministic barrier removes what the catalogue does not
 * have. B, C and E need structured histories and belong to phase F.
 */
export type Arm = 'A' | 'D';

export interface Metric {
  key: string;
  /** What the report prints, in Spanish. */
  label: string;
  /**
   * `binary`: 0 or 1 per case, reported with Wilson. `mean`: a fraction per
   * case (e.g. invented over proposed), reported with a bootstrap of cases.
   */
  kind: 'binary' | 'mean';
  /** True when higher is worse (invention, omission): only for the report. */
  lowerIsBetter?: boolean;
  /** Compared between arms and between providers, case by case. */
  primary?: boolean;
}

/** What one answer scored, per metric. Null: the metric does not apply to this case. */
export type Scores = Record<string, number | null>;

/**
 * Asks a model on behalf of a task: the judge of the note. Null when the
 * model gave no valid answer; it throws only to end the run (the ceiling).
 */
export type Ask = <Shape extends z.ZodType>(
  request: LlmRequest<Shape>,
) => Promise<z.infer<Shape> | null>;

export interface EvalCase {
  id: string;
  origin: 'invented' | 'codiesp';
}

/**
 * One task of D-239 §5. It builds the request for a case and an arm, and
 * scores the answer — after its own barrier, when the arm has one. What it
 * returns as `shown` is what a physician would see, kept in the result.
 */
export interface EvalTask<Case extends EvalCase, Value> {
  name: 'cie10' | 'cie10-problema' | 'prescription' | 'note';
  title: string;
  arms: readonly Arm[];
  /** EV-7. The version of each arm's prompt, stored with every result. */
  promptVersions: Readonly<Partial<Record<Arm, string>>>;
  metrics: readonly Metric[];
  /** PLAN-ASISTENTE-IA §5: the p90 the answer must stay under. */
  latencyBudgetMs: number;
  request(item: Case, arm: Arm): LlmRequest<z.ZodType<Value>>;
  evaluate(
    item: Case,
    arm: Arm,
    value: Value,
    judge: Ask | null,
  ): Promise<{ shown: unknown; scores: Scores }>;
}
