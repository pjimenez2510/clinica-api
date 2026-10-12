import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  NewSuggestion,
  SuggestionStore,
} from '../application/suggestion.store';
import { SuggestionNotFoundError } from '../domain/assistant.errors';
import type {
  SuggestionDecision,
  SuggestionKind,
  SuggestionRecord,
  SuggestionSource,
  SuggestionStatus,
  SuggestionView,
} from '../domain/suggestion';

const SUGGESTION_SELECT = {
  id: true,
  encounterId: true,
  aiRunId: true,
  kind: true,
  proposal: true,
  sources: true,
  status: true,
  distance: true,
  clinicalNoteId: true,
  encounterDiagnosisId: true,
  prescriptionId: true,
  serviceOrderId: true,
  proposedAt: true,
  decidedBy: true,
  decidedAt: true,
} satisfies Prisma.AiSuggestionSelect;

type SuggestionRow = Prisma.AiSuggestionGetPayload<{
  select: typeof SUGGESTION_SELECT;
}>;

/** The column each record kind lives in (AS-021). */
const COLUMN_OF = {
  clinical_note: 'clinicalNoteId',
  encounter_diagnosis: 'encounterDiagnosisId',
  prescription: 'prescriptionId',
  service_order: 'serviceOrderId',
} as const satisfies Record<SuggestionRecord['kind'], keyof SuggestionRow>;

/**
 * AS-020 to AS-024 over PostgreSQL. What a decision may look like is the
 * table's (`ai_suggestion_*` CHECKs and triggers); this adapter only reads
 * and writes, and decides under the row's lock.
 */
@Injectable()
export class PrismaSuggestionStore implements SuggestionStore {
  constructor(private readonly prisma: PrismaService) {}

  async propose(
    suggestions: readonly NewSuggestion[],
    proposedAt: Date,
  ): Promise<SuggestionView[]> {
    const rows = await this.prisma.$transaction(
      suggestions.map((suggestion) =>
        this.prisma.aiSuggestion.create({
          data: {
            encounterId: suggestion.encounterId,
            aiRunId: suggestion.aiRunId,
            kind: suggestion.kind,
            proposal: suggestion.proposal as Prisma.InputJsonObject,
            sources: suggestion.sources,
            proposedAt,
          },
          select: SUGGESTION_SELECT,
        }),
      ),
    );
    return rows.map(toView);
  }

  async decide(
    suggestionId: string,
    stamp: { decidedBy: string; decidedAt: Date },
    decide: (suggestion: SuggestionView) => SuggestionDecision,
  ): Promise<SuggestionView> {
    const row = await this.prisma.$transaction(async (tx) => {
      // AS-023. Two decisions at once queue here; the second reads the first.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "ai_suggestion" WHERE id = ${suggestionId}::uuid FOR UPDATE`;
      if (!locked) throw new SuggestionNotFoundError();

      const current = await tx.aiSuggestion.findUniqueOrThrow({
        where: { id: suggestionId },
        select: SUGGESTION_SELECT,
      });
      const decision = decide(toView(current));

      return tx.aiSuggestion.update({
        where: { id: suggestionId },
        data: {
          status: decision.status,
          distance: decision.distance,
          ...(decision.record
            ? { [COLUMN_OF[decision.record.kind]]: decision.record.id }
            : {}),
          // AS-024. The stamp `record_version_archive` demands.
          decidedBy: stamp.decidedBy,
          decidedAt: stamp.decidedAt,
        },
        select: SUGGESTION_SELECT,
      });
    });
    return toView(row);
  }

  async listOfEncounter(
    encounterId: string,
    kind?: SuggestionKind,
  ): Promise<SuggestionView[]> {
    const rows = await this.prisma.aiSuggestion.findMany({
      where: { encounterId, ...(kind ? { kind } : {}) },
      orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
      select: SUGGESTION_SELECT,
    });
    return rows.map(toView);
  }
}

function toView(row: SuggestionRow): SuggestionView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    aiRunId: row.aiRunId,
    // The CHECKs admit only these: the casts record that.
    kind: row.kind as SuggestionKind,
    proposal: row.proposal as Record<string, unknown>,
    sources: row.sources as unknown as SuggestionSource[],
    status: row.status as SuggestionStatus,
    distance: row.distance === null ? null : Number(row.distance),
    record: recordOf(row),
    proposedAt: row.proposedAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
  };
}

function recordOf(row: SuggestionRow): SuggestionRecord | null {
  for (const [kind, column] of Object.entries(COLUMN_OF) as [
    SuggestionRecord['kind'],
    keyof SuggestionRow,
  ][]) {
    const id = row[column];
    if (typeof id === 'string') return { kind, id };
  }
  return null;
}
