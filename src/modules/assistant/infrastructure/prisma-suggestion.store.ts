import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  NewSuggestion,
  SuggestionStore,
} from '../application/suggestion.store';
import { SuggestionNotFoundError } from '../domain/assistant.errors';
import type {
  SiteScopeFilter,
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
    sites: SiteScopeFilter,
  ): Promise<SuggestionView[]> {
    const rows = await this.prisma.$transaction(async (tx) => {
      // Out of scope reads as absent: no telling «exists elsewhere».
      const encounters = [...new Set(suggestions.map((each) => each.encounterId))]; // prettier-ignore
      const inScope = await tx.encounter.count({
        where: { id: { in: encounters }, ...siteFilter(sites) },
      });
      if (inScope !== encounters.length) throw new SuggestionNotFoundError();
      const created: SuggestionRow[] = [];
      for (const suggestion of suggestions) {
        created.push(
          await tx.aiSuggestion.create({
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
        );
      }
      return created;
    });
    return rows.map(toView);
  }

  async decide(
    query: {
      suggestionId: string;
      sites: SiteScopeFilter;
      recordId: string | null;
    },
    stamp: { decidedBy: string; decidedAt: Date },
    decide: (
      suggestion: SuggestionView,
      saved: string | null,
    ) => SuggestionDecision,
  ): Promise<SuggestionView> {
    const { suggestionId } = query;
    const row = await this.prisma.$transaction(async (tx) => {
      // AS-023. Two decisions at once queue here; the second reads the first.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "ai_suggestion" WHERE id = ${suggestionId}::uuid FOR UPDATE`;
      if (!locked) throw new SuggestionNotFoundError();

      const current = await tx.aiSuggestion.findFirst({
        where: { id: suggestionId, encounter: siteFilter(query.sites) },
        select: SUGGESTION_SELECT,
      });
      // Out of scope reads as absent: no telling «exists elsewhere».
      if (!current) throw new SuggestionNotFoundError();
      const view = toView(current);
      const saved =
        query.recordId === null
          ? null
          : await savedIn(tx, view, query.recordId);
      const decision = decide(view, saved);

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
    sites: SiteScopeFilter,
    kind?: SuggestionKind,
  ): Promise<SuggestionView[]> {
    const rows = await this.prisma.aiSuggestion.findMany({
      where: {
        encounterId,
        encounter: siteFilter(sites),
        ...(kind ? { kind } : {}),
      },
      orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
      select: SUGGESTION_SELECT,
    });
    return rows.map(toView);
  }
}

const siteFilter = (sites: SiteScopeFilter) =>
  sites === 'all' ? {} : { siteId: { in: [...sites] } };

/**
 * AS-022. What the linked record holds for the proposed field, read in the
 * deciding transaction: the note's section (empty when it has none) or the
 * diagnosis' code. `null` for a line of a receta or an order, which has no
 * identity of its own yet (D-243 §5). A record that is not there yields `''`,
 * and the database refuses the link anyway.
 */
async function savedIn(
  tx: Prisma.TransactionClient,
  suggestion: SuggestionView,
  recordId: string,
): Promise<string | null> {
  if (suggestion.kind === 'note-section') {
    const note = await tx.clinicalNote.findUnique({
      where: { id: recordId },
      select: { content: true },
    });
    const section = suggestion.proposal.section;
    const text =
      typeof section === 'string'
        ? (note?.content as Record<string, unknown> | null)?.[section]
        : undefined;
    return typeof text === 'string' ? text : '';
  }
  if (suggestion.kind === 'diagnosis') {
    const diagnosis = await tx.encounterDiagnosis.findUnique({
      where: { id: recordId },
      select: { cie10Code: true },
    });
    return diagnosis?.cie10Code ?? '';
  }
  return null;
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
