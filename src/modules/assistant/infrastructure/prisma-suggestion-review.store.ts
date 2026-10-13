import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { SuggestionReviewStore } from '../application/suggestion-review.store';
import type { SectionReview, SignedNote } from '../domain/signing-review';

const CONSULTATION_FORM = '002';

/**
 * AS-144, AS-145 over PostgreSQL. What a review may be is the table's
 * (`ai_suggestion_review_*`); this adapter reads the signed note and writes.
 */
@Injectable()
export class PrismaSuggestionReviewStore implements SuggestionReviewStore {
  constructor(private readonly prisma: PrismaService) {}

  async signedConsultation(encounterId: string): Promise<SignedNote | null> {
    // What was SIGNED, not what stands now: a sweep after an amendment
    // (EN-025) still measures the first signed version of the chain.
    const note = await this.prisma.clinicalNote.findFirst({
      where: {
        encounterId,
        formCode: CONSULTATION_FORM,
        signedAt: { not: null },
        status: { in: ['SIGNED', 'SUPERSEDED'] },
      },
      orderBy: { version: 'asc' },
      select: { id: true, content: true },
    });
    if (!note) return null;
    return {
      id: note.id,
      content: (note.content ?? {}) as Record<string, unknown>,
    };
  }

  async record(reviews: readonly SectionReview[], at: Date): Promise<number> {
    if (reviews.length === 0) return 0;
    // A review is written once (AS-145): one kept by a concurrent sweep is
    // left as it is.
    const { count } = await this.prisma.aiSuggestionReview.createMany({
      data: reviews.map((each) => ({
        suggestionId: each.suggestionId,
        clinicalNoteId: each.clinicalNoteId,
        statusAtSigning: each.statusAtSigning,
        distance: each.distance,
        reviewedAt: at,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  async unreviewed(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ encounter_id: string }[]>`
      SELECT DISTINCT n.encounter_id
        FROM clinical_note n
        JOIN note_draft d
          ON d.encounter_id = n.encounter_id AND d.status = 'DONE'
       WHERE n.form_code = ${CONSULTATION_FORM}
         AND n.signed_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM ai_suggestion s
            WHERE s.encounter_id = n.encounter_id
              AND s.kind = 'note-section'
              AND (s.proposal ->> 'draftId')::uuid = d.id)
         AND NOT EXISTS (
           SELECT 1 FROM ai_suggestion o
             JOIN ai_suggestion_review r ON r.suggestion_id = o.id
            WHERE o.encounter_id = n.encounter_id)`;
    return rows.map(({ encounter_id }) => encounter_id);
  }
}
