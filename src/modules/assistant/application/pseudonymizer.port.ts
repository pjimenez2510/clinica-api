import { AssistantNotConfiguredError } from '../domain/assistant.errors';

import type { PseudonymizedText } from './llm-client.port';

/**
 * AS-025 (P4, D-239 §1). What goes to the pseudonymizer: the text of a
 * patient, who it is about, and the names the text may carry.
 *
 * The contract of `sigmai-ai` (`POST /v1/privacy/pseudonymize`), which A5
 * copies as `clinica-ai`: the names are passed so the service replaces them
 * even where its own recogniser would miss them. They are clinical data and
 * never reach a log.
 */
export interface PseudonymizeInput {
  text: string;
  /** Who the text is about: the chart id, so placeholders are stable per patient. */
  subject: string;
  /** The patient's names. */
  names?: string[];
  /** Places that identify the patient (address, parish). */
  places?: string[];
  /** The names of the staff in the room. */
  staff?: string[];
}

/** One replacement the pseudonymizer made: `[PERSONA_1]` stood for a name. */
export interface Replacement {
  placeholder: string;
  original: string;
  kind: string;
}

/**
 * AS-025. The text, cleared to leave the clinic, and what it takes to put the
 * original back in what the model answers about it.
 */
export interface Pseudonymized {
  cleared: PseudonymizedText;
  replacements: readonly Replacement[];
  /**
   * Dates are moved by this many days. Nothing moves them back yet: a quote
   * of D1 that carries a moved date is not in the note, so it is dropped
   * (AS-028), never shown with the wrong date. Whoever shows a dated phrase
   * (C2) moves it back first.
   */
  dateShiftDays: number;
}

/**
 * AS-025. The one production door into `PseudonymizedText` besides
 * `withContext`. The HTTP adapter to `clinica-ai` is A5's; this delivery only
 * declares the port, so both sides agree on it before either merges.
 *
 * A failure throws: a caller that cannot clear the text sends nothing.
 */
export interface Pseudonymizer {
  pseudonymize(
    input: PseudonymizeInput,
    signal?: AbortSignal,
  ): Promise<Pseudonymized>;
}

export const PSEUDONYMIZER = Symbol('PSEUDONYMIZER');

/**
 * AS-025. The installation has no pseudonymizer (until A5, every one): any
 * function that needs one fails closed, before any network call and before
 * any row of `ai_run`.
 */
export class MissingPseudonymizer implements Pseudonymizer {
  pseudonymize(): Promise<Pseudonymized> {
    return Promise.reject(new AssistantNotConfiguredError());
  }
}

/**
 * Puts the originals back in text the model wrote about cleared text: a quote
 * the physician reads must say what the note says, not `[PERSONA_1]`.
 * Longest placeholder first, so `[PERSONA_10]` is not read as `[PERSONA_1]`.
 */
export function restorePlaceholders(
  text: string,
  replacements: readonly Replacement[],
): string {
  return [...replacements]
    .sort((a, b) => b.placeholder.length - a.placeholder.length)
    .reduce(
      (restored, { placeholder, original }) =>
        restored.split(placeholder).join(original),
      text,
    );
}
