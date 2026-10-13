/** AS-197. A token as the recogniser wrote it, and how sure it was (0 to 1). */
export interface HeardWord {
  text: string;
  probability: number;
}

/** What SigmAI's reading already takes as a doubt: a pause (`dictation.ts`). */
const DOUBT = ' … ';

/**
 * AS-197. What was heard, with every token the recogniser was not sure of
 * turned into a doubt, so the reading leaves its field empty and names it
 * (AS-182) instead of proposing a number nobody may have said. SigmAI's
 * reading is not touched: it already empties a field with a pause in it.
 *
 * Without the tokens there is no confidence to go by, and it fails closed:
 * every field named is in doubt, and the nurse types them.
 */
export function withDoubts(
  text: string,
  words: readonly HeardWord[],
  minProbability: number,
): string {
  if (words.length === 0) return text.trim().split(/\s+/).join(DOUBT);
  return words
    .map((word) => (word.probability < minProbability ? DOUBT : word.text))
    .join('')
    .trim();
}
