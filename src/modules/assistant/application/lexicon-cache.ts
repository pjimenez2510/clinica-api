import type { Logger } from '@nestjs/common';

import type { NoteDraftContextReader } from '../../../shared/clinical/note-draft-context.port';
import { buildLexicon, type Lexicon } from '../domain/lexicon';

/** AS-092. The vocabulary is read again after an hour. */
const VOCABULARY_TTL_MS = 3_600_000;

/**
 * AS-092. The lexicon the draft (C2) and the questions (C3) correct with,
 * read once an hour; when it cannot be read, nothing is corrected.
 */
export class LexiconCache {
  private cached: { value: Lexicon | null; readAt: number } | null = null;

  constructor(
    private readonly reader: Pick<NoteDraftContextReader, 'vocabulary'>,
    private readonly clock: () => Date,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly codeOf: (error: unknown) => string,
  ) {}

  async get(): Promise<Lexicon | null> {
    const now = this.clock().getTime();
    if (this.cached && now - this.cached.readAt < VOCABULARY_TTL_MS) {
      return this.cached.value;
    }
    try {
      const { principles, protectedWords } = await this.reader.vocabulary();
      this.cached = {
        value: buildLexicon({ targets: principles, protectedWords }),
        readAt: now,
      };
    } catch (error) {
      this.logger.warn({ error_code: this.codeOf(error) }, 'the lexicon could not be read'); // prettier-ignore
      this.cached = { value: null, readAt: now };
    }
    return this.cached.value;
  }
}
