import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  NoteQuestionCheck,
  NoteQuestionCheckStore,
} from '../application/note-question-check.store';

/**
 * AS-121, AS-122 over PostgreSQL. The table refuses a review of an attempt of
 * another attention or one that did not answer, more than five questions, a
 * digest that is not one, and any rewrite (`note_question_check_*`).
 */
@Injectable()
export class PrismaNoteQuestionCheckStore implements NoteQuestionCheckStore {
  constructor(private readonly prisma: PrismaService) {}

  async record(check: NoteQuestionCheck): Promise<void> {
    await this.prisma.noteQuestionCheck.create({ data: check });
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
