import type { PseudonymizedText } from '../src/modules/assistant/application/llm-client.port.ts';

/**
 * EV-2. THE ONE DOOR of the harness into `PseudonymizedText`.
 *
 * The port admits only text that went through the pseudonymizer (AS-001), and
 * in `src/` nothing may mint it but the pseudonymizer of A5. The harness is
 * the one place where the text is allowed to leave without it, because no
 * case here is about a person: every case is invented, or published by
 * CodiEsp (EV-1), and `cases.ts` refuses any other before a call is built.
 * It is still a single named function so the exception is one line to
 * review, and a test of `eval/` fails on any other cast.
 *
 * Never pass it anything read from a database, a dump or a record.
 */
export function caseText(text: string): PseudonymizedText {
  return text as PseudonymizedText;
}
