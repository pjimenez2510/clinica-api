import type { PseudonymizedText } from '../../application/llm-client.port';
import type {
  Pseudonymized,
  PseudonymizeInput,
  Pseudonymizer,
  Replacement,
} from '../../application/pseudonymizer.port';

/**
 * AS-029. The pseudonymizer of the demonstration mode: it replaces the names
 * it is given with `[PERSONA_n]`, so the screen shows the placeholders being
 * put back, and nothing else.
 *
 * ⚠️ IT IS NOT A PSEUDONYMIZER. It knows no recogniser, no dates, no places.
 * It is safe ONLY because the demonstration mode has no road to a provider:
 * `validateEnv` refuses it in production, beside `ASSISTANT_ALLOW_REMOTE` and
 * beside any provider key, and `AssistantModule` builds it only with the
 * demonstration provider. The one cast to `PseudonymizedText` outside the
 * port, allowed by name in the AS-001 scan for that reason.
 */
export class DemoPseudonymizer implements Pseudonymizer {
  pseudonymize(input: PseudonymizeInput): Promise<Pseudonymized> {
    const names = [...(input.names ?? []), ...(input.staff ?? [])]
      .filter((name) => name.trim().length > 1)
      .sort((a, b) => b.length - a.length);
    const replacements: Replacement[] = [];
    let text = input.text;
    for (const original of names) {
      if (!text.includes(original)) continue;
      const placeholder = `[PERSONA_${replacements.length + 1}]`;
      text = text.split(original).join(placeholder);
      replacements.push({ placeholder, original, kind: 'name' });
    }
    return Promise.resolve({
      cleared: text as PseudonymizedText,
      replacements,
      dateShiftDays: 0,
    });
  }
}
