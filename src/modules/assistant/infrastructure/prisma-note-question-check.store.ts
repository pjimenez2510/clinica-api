import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  NoteQuestionCheck,
  NoteQuestionCheckStore,
} from '../application/note-question-check.store';
import type { NewSuggestion } from '../application/suggestion.store';
import type { SiteScopeFilter } from '../domain/suggestion';

import { proposeLocked } from './prisma-suggestion.store';
import { suggestionErrorFrom } from './suggestion-database-errors';

/**
 * AS-121, AS-122 over PostgreSQL. The table refuses a review of an attempt of
 * another attention or one that did not answer, more than five questions, a
 * digest that is not one, and any rewrite (`note_question_check_*`); and,
 * once the 002 is signed, any review at all (`note_question_of_a_draft`, AS-124).
 */
@Injectable()
export class PrismaNoteQuestionCheckStore implements NoteQuestionCheckStore {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    check: NoteQuestionCheck,
    questions: readonly NewSuggestion[],
    sites: SiteScopeFilter,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await proposeLocked(tx, questions, check.checkedAt, sites, [check.encounterId]); // prettier-ignore
      await tx.noteQuestionCheck
        .create({ data: check })
        .catch((error: unknown) => {
          throw suggestionErrorFrom(error) ?? error;
        });
    });
  }

  async latest(encounterId: string): Promise<NoteQuestionCheck | null> {
    const row = await this.prisma.noteQuestionCheck.findFirst({
      where: { encounterId },
      // uuidv7 breaks a tie of the same instant in the order it was written.
      orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
      select: {
        encounterId: true,
        aiRunId: true,
        upToMs: true,
        noteDigest: true,
        asked: true,
        dropped: true,
        requestedBy: true,
        checkedAt: true,
      },
    });
    return row;
  }
}
