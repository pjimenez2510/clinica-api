import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CLINIC_TIME_ZONE } from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  AssistantQualityReader,
  ProposalSums,
  QualityEncounter,
  QualityEncounterRow,
  QualityScope,
  QualityWindow,
} from '../application/assistant-quality.reader';
import type { SiteWeekSums, TaskFigures } from '../domain/assistant-quality';
import { parseClinicalDate } from '../../../shared/domain/clinic-time';

/**
 * E19 (AS-345 to AS-351) over PostgreSQL: counted by SQL, read by nobody.
 *
 * ⚠️ NOTHING OF THE TEXT LEAVES THE DATABASE (AS-349). `ai_exchange` is never
 * joined; `ai_suggestion.proposal` is only ASKED a question —whether a phrase
 * or a field says «Nadie lo dijo» (AS-347), and which section it is—, and the
 * answer is a boolean or a section code. A select that returns `proposal`,
 * `sources` or a note's content here is the leak AS-349 forbids.
 *
 * Every read hangs off `scoped`: the attentions of the caller's sites, or of
 * the caller as practitioner, never an annulled one (AS-350).
 */

const EMPTY = Prisma.empty;

/** AS-347. Something of the proposal says «Nadie lo dijo». */
const AMBER = Prisma.sql`(
  (s.kind = 'note-section'
    AND jsonb_path_exists(s.proposal, '$.phrases[*] ? (@.unsaid == true)'))
  OR (s.kind = 'prescription-item'
    AND jsonb_typeof(s.proposal -> 'unsaid') = 'array'
    AND s.proposal -> 'unsaid' <> '[]'::jsonb)
)`;

/** A note draft that finished: only its sections reached the screen (AS-090). */
const DONE_DRAFT = (alias: string) => Prisma.sql`EXISTS (
  SELECT 1 FROM note_draft d
  WHERE d.id::text = ${Prisma.raw(alias)}.proposal ->> 'draftId' AND d.status = 'DONE'
)`;

/**
 * AS-346. A proposal the physician had in front of them: decided, or still
 * undecided AND on screen. The same rule the product shows by —
 * `shownSections` (AS-090, as `sectionsToReview` reviews at the signature,
 * AS-144) for the note, `currentReading` (AS-036) for the rest—. An undecided
 * proposal a later draft or reading replaced was never seen: counting it as
 * «sin tocar» would sink the acceptance of every re-asked consultation.
 */
const SHOWN = Prisma.sql`(
  s.status <> 'PROPOSED'
  OR CASE WHEN s.kind = 'note-section' THEN
    ${DONE_DRAFT('s')}
    AND NOT EXISTS (
      SELECT 1 FROM ai_suggestion n
      WHERE n.encounter_id = s.encounter_id AND n.kind = 'note-section'
        AND n.proposal ->> 'section' = s.proposal ->> 'section'
        AND (n.proposed_at, n.id) > (s.proposed_at, s.id)
        AND ${DONE_DRAFT('n')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ai_suggestion e
      WHERE e.encounter_id = s.encounter_id AND e.kind = 'note-section'
        AND e.proposal ->> 'section' = s.proposal ->> 'section'
        AND e.status <> 'PROPOSED'
        AND e.proposal ->> 'text' = s.proposal ->> 'text'
        AND (e.proposed_at, e.id) < (s.proposed_at, s.id)
    )
  ELSE
    s.ai_run_id = (
      SELECT l.ai_run_id FROM ai_suggestion l
      WHERE l.encounter_id = s.encounter_id AND l.kind = s.kind
      ORDER BY l.proposed_at DESC, l.id DESC
      LIMIT 1
    )
  END
)`;

/** AS-350. The attentions the caller may count, optionally of a window or one. */
function scoped(
  scope: QualityScope,
  narrow: { window?: QualityWindow; encounterId?: string },
): Prisma.Sql {
  const { window, encounterId } = narrow;
  return Prisma.sql`
    SELECT e.id, e.site_id, e.started_at, e.status::text AS status, e.practitioner_id
    FROM encounter e
    JOIN practitioner p ON p.id = e.practitioner_id
    WHERE e.status <> 'ENTERED_IN_ERROR'
    ${scope.sites === 'all' ? EMPTY : Prisma.sql`AND e.site_id = ANY(${[...scope.sites]}::uuid[])`}
    ${scope.practitionerUserId === null ? EMPTY : Prisma.sql`AND p.user_id = ${scope.practitionerUserId}::uuid`}
    ${window ? Prisma.sql`AND e.started_at >= ${window.startsAt} AND e.started_at < ${window.endsAtExclusive}` : EMPTY}
    ${window?.siteId ? Prisma.sql`AND e.site_id = ${window.siteId}::uuid` : EMPTY}
    ${encounterId ? Prisma.sql`AND e.id = ${encounterId}::uuid` : EMPTY}
  `;
}

/** The week of an attention, Monday, in the clinic's calendar (AS-348). */
const WEEK = Prisma.sql`(date_trunc('week', x.started_at AT TIME ZONE ${CLINIC_TIME_ZONE}))::date`;

interface TaskRow {
  purpose: string;
  attempts: number;
  answered: number;
  input_tokens: bigint;
  output_tokens: bigint;
  cache_read_tokens: bigint;
  cache_write_tokens: bigint;
  cost_usd: string;
  without_cost: number;
  median_latency: number | null;
  max_latency: number | null;
}

interface ProposalRow {
  kind: string;
  section: string | null;
  proposals: number;
  accepted: number;
  edited: number;
  discarded: number;
  untouched: number;
  superseded: number;
  amber: number;
  reviewed: number;
  median_distance: number | null;
}

const TASK_COLUMNS = Prisma.sql`
  r.purpose,
  count(*)::int AS attempts,
  count(*) FILTER (WHERE r.outcome = 'ok')::int AS answered,
  coalesce(sum(r.input_tokens), 0)::bigint AS input_tokens,
  coalesce(sum(r.output_tokens), 0)::bigint AS output_tokens,
  coalesce(sum(r.cache_read_tokens), 0)::bigint AS cache_read_tokens,
  coalesce(sum(r.cache_write_tokens), 0)::bigint AS cache_write_tokens,
  coalesce(sum(r.cost_usd), 0)::numeric(14, 8)::text AS cost_usd,
  count(*) FILTER (WHERE r.cost_usd IS NULL)::int AS without_cost,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r.latency_ms) AS median_latency,
  max(r.latency_ms) AS max_latency
`;

const PROPOSAL_COLUMNS = Prisma.sql`
  s.kind,
  CASE WHEN s.kind = 'note-section' THEN s.proposal ->> 'section' END AS section,
  count(*) FILTER (WHERE ${SHOWN})::int AS proposals,
  count(*) FILTER (WHERE s.status = 'ACCEPTED')::int AS accepted,
  count(*) FILTER (WHERE s.status = 'ACCEPTED_WITH_CHANGES')::int AS edited,
  count(*) FILTER (WHERE s.status = 'DISCARDED')::int AS discarded,
  count(*) FILTER (WHERE s.status = 'PROPOSED' AND ${SHOWN})::int AS untouched,
  count(*) FILTER (WHERE NOT ${SHOWN})::int AS superseded,
  count(*) FILTER (WHERE ${AMBER} AND ${SHOWN})::int AS amber,
  count(v.suggestion_id)::int AS reviewed,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY v.distance) AS median_distance
`;

function task(row: TaskRow): TaskFigures {
  return {
    purpose: row.purpose,
    attempts: row.attempts,
    answered: row.answered,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    costUsd: row.cost_usd,
    attemptsWithoutCost: row.without_cost,
    medianLatencyMs: row.median_latency,
    maxLatencyMs: row.max_latency,
  };
}

function proposal(row: ProposalRow): ProposalSums {
  return {
    kind: row.kind,
    section: row.section,
    proposals: row.proposals,
    accepted: row.accepted,
    edited: row.edited,
    discarded: row.discarded,
    untouched: row.untouched,
    superseded: row.superseded,
    amber: row.amber,
    reviewed: row.reviewed,
    medianDistance: row.median_distance,
  };
}

@Injectable()
export class PrismaAssistantQualityReader implements AssistantQualityReader {
  constructor(private readonly prisma: PrismaService) {}

  async encounter(
    encounterId: string,
    scope: QualityScope,
  ): Promise<QualityEncounter | null> {
    const [row] = await this.prisma.$queryRaw<
      {
        id: string;
        started_at: Date;
        site_id: string;
        site_name: string;
        practitioner_name: string;
        status: string;
      }[]
    >`
      WITH scoped AS (${scoped(scope, { encounterId })})
      SELECT x.id, x.started_at, x.site_id, site.name AS site_name,
             u.first_name || ' ' || u.last_name AS practitioner_name, x.status
      FROM scoped x
      JOIN site ON site.id = x.site_id
      JOIN practitioner p ON p.id = x.practitioner_id
      JOIN app_user u ON u.id = p.user_id
    `;
    if (!row) return null;
    return {
      encounterId: row.id,
      startedAt: row.started_at,
      siteId: row.site_id,
      siteName: row.site_name,
      practitionerName: row.practitioner_name,
      status: row.status,
    };
  }

  async tasksOf(encounterId: string): Promise<TaskFigures[]> {
    const rows = await this.prisma.$queryRaw<TaskRow[]>`
      SELECT ${TASK_COLUMNS}
      FROM ai_run r
      WHERE r.encounter_id = ${encounterId}::uuid
      GROUP BY r.purpose
      ORDER BY r.purpose
    `;
    return rows.map(task);
  }

  async tasks(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<TaskFigures[]> {
    const rows = await this.prisma.$queryRaw<TaskRow[]>`
      WITH scoped AS (${scoped(scope, { window })})
      SELECT ${TASK_COLUMNS}
      FROM ai_run r
      JOIN scoped x ON x.id = r.encounter_id
      GROUP BY r.purpose
      ORDER BY r.purpose
    `;
    return rows.map(task);
  }

  async proposalsOf(encounterId: string): Promise<ProposalSums[]> {
    const rows = await this.prisma.$queryRaw<ProposalRow[]>`
      SELECT ${PROPOSAL_COLUMNS}
      FROM ai_suggestion s
      LEFT JOIN ai_suggestion_review v ON v.suggestion_id = s.id
      WHERE s.encounter_id = ${encounterId}::uuid
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    return rows.map(proposal);
  }

  async proposals(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<ProposalSums[]> {
    const rows = await this.prisma.$queryRaw<ProposalRow[]>`
      WITH scoped AS (${scoped(scope, { window })})
      SELECT ${PROPOSAL_COLUMNS}
      FROM ai_suggestion s
      JOIN scoped x ON x.id = s.encounter_id
      LEFT JOIN ai_suggestion_review v ON v.suggestion_id = s.id
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    return rows.map(proposal);
  }

  /**
   * AS-348, AS-352. Three aggregates over the same attentions —the
   * attentions, their attempts, their proposals—, each by week and site and
   * by week alone (`GROUPING SETS`), so the medians of «all the sites» are
   * medians of the rows and not of the sites' medians.
   */
  async siteWeeks(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<SiteWeekSums[]> {
    const rows = await this.prisma.$queryRaw<
      (Omit<TaskRow, 'purpose' | 'max_latency'> &
        Omit<ProposalRow, 'kind' | 'section'> & {
          week: string;
          site_id: string | null;
          site_name: string | null;
          encounters: number;
          assisted: number;
        })[]
    >`
      WITH scoped AS (${scoped(scope, { window })}),
      enc AS (
        SELECT x.id, x.site_id, ${WEEK} AS week,
               EXISTS (SELECT 1 FROM ai_run r WHERE r.encounter_id = x.id) AS assisted
        FROM scoped x
      ),
      e_agg AS (
        SELECT week, site_id, GROUPING(site_id) AS g,
               count(*)::int AS encounters,
               count(*) FILTER (WHERE assisted)::int AS assisted
        FROM enc
        GROUP BY GROUPING SETS ((week, site_id), (week))
      ),
      r_agg AS (
        SELECT enc.week, enc.site_id, GROUPING(enc.site_id) AS g,
               count(*)::int AS attempts,
               count(*) FILTER (WHERE r.outcome = 'ok')::int AS answered,
               coalesce(sum(r.input_tokens), 0)::bigint AS input_tokens,
               coalesce(sum(r.output_tokens), 0)::bigint AS output_tokens,
               coalesce(sum(r.cache_read_tokens), 0)::bigint AS cache_read_tokens,
               coalesce(sum(r.cache_write_tokens), 0)::bigint AS cache_write_tokens,
               coalesce(sum(r.cost_usd), 0)::numeric(14, 8) AS cost_usd,
               count(*) FILTER (WHERE r.cost_usd IS NULL)::int AS without_cost,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY r.latency_ms) AS median_latency
        FROM ai_run r
        JOIN enc ON enc.id = r.encounter_id
        GROUP BY GROUPING SETS ((enc.week, enc.site_id), (enc.week))
      ),
      s_agg AS (
        SELECT enc.week, enc.site_id, GROUPING(enc.site_id) AS g,
               count(*) FILTER (WHERE ${SHOWN})::int AS proposals,
               count(*) FILTER (WHERE s.status = 'ACCEPTED')::int AS accepted,
               count(*) FILTER (WHERE s.status = 'ACCEPTED_WITH_CHANGES')::int AS edited,
               count(*) FILTER (WHERE s.status = 'DISCARDED')::int AS discarded,
               count(*) FILTER (WHERE s.status = 'PROPOSED' AND ${SHOWN})::int AS untouched,
               count(*) FILTER (WHERE NOT ${SHOWN})::int AS superseded,
               count(*) FILTER (WHERE ${AMBER} AND ${SHOWN})::int AS amber,
               count(v.suggestion_id)::int AS reviewed,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY v.distance) AS median_distance
        FROM ai_suggestion s
        JOIN enc ON enc.id = s.encounter_id
        LEFT JOIN ai_suggestion_review v ON v.suggestion_id = s.id
        GROUP BY GROUPING SETS ((enc.week, enc.site_id), (enc.week))
      )
      SELECT to_char(e.week, 'YYYY-MM-DD') AS week, e.site_id, site.name AS site_name,
             e.encounters, e.assisted,
             coalesce(r.attempts, 0) AS attempts,
             coalesce(r.answered, 0) AS answered,
             coalesce(r.input_tokens, 0) AS input_tokens,
             coalesce(r.output_tokens, 0) AS output_tokens,
             coalesce(r.cache_read_tokens, 0) AS cache_read_tokens,
             coalesce(r.cache_write_tokens, 0) AS cache_write_tokens,
             coalesce(r.cost_usd, 0)::numeric(14, 8)::text AS cost_usd,
             coalesce(r.without_cost, 0) AS without_cost,
             r.median_latency,
             coalesce(s.proposals, 0) AS proposals,
             coalesce(s.accepted, 0) AS accepted,
             coalesce(s.edited, 0) AS edited,
             coalesce(s.discarded, 0) AS discarded,
             coalesce(s.untouched, 0) AS untouched,
             coalesce(s.superseded, 0) AS superseded,
             coalesce(s.amber, 0) AS amber,
             coalesce(s.reviewed, 0) AS reviewed,
             s.median_distance
      FROM e_agg e
      LEFT JOIN r_agg r ON r.week = e.week AND r.g = e.g AND r.site_id IS NOT DISTINCT FROM e.site_id
      LEFT JOIN s_agg s ON s.week = e.week AND s.g = e.g AND s.site_id IS NOT DISTINCT FROM e.site_id
      LEFT JOIN site ON site.id = e.site_id
      ORDER BY e.week, e.g DESC, site.name
    `;
    return rows.map((row) => ({
      week: parseClinicalDate(row.week),
      siteId: row.site_id,
      siteName: row.site_name,
      encounters: row.encounters,
      assisted: row.assisted,
      attempts: row.attempts,
      answered: row.answered,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      costUsd: row.cost_usd,
      attemptsWithoutCost: row.without_cost,
      medianLatencyMs: row.median_latency,
      proposals: row.proposals,
      accepted: row.accepted,
      edited: row.edited,
      discarded: row.discarded,
      untouched: row.untouched,
      superseded: row.superseded,
      amber: row.amber,
      reviewed: row.reviewed,
      medianDistance: row.median_distance,
    }));
  }

  async assistedEncounters(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<QualityEncounterRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        started_at: Date;
        site_id: string;
        site_name: string;
        practitioner_name: string;
        status: string;
        attempts: number;
        cost_usd: string;
        proposals: number;
        accepted: number;
        edited: number;
      }[]
    >`
      WITH scoped AS (${scoped(scope, { window })})
      SELECT x.id, x.started_at, x.site_id, site.name AS site_name,
             u.first_name || ' ' || u.last_name AS practitioner_name, x.status,
             r.attempts, r.cost_usd,
             coalesce(s.proposals, 0) AS proposals,
             coalesce(s.accepted, 0) AS accepted,
             coalesce(s.edited, 0) AS edited
      FROM scoped x
      JOIN site ON site.id = x.site_id
      JOIN practitioner p ON p.id = x.practitioner_id
      JOIN app_user u ON u.id = p.user_id
      JOIN LATERAL (
        SELECT count(*)::int AS attempts,
               coalesce(sum(cost_usd), 0)::numeric(14, 8)::text AS cost_usd
        FROM ai_run WHERE encounter_id = x.id
      ) r ON r.attempts > 0
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE ${SHOWN})::int AS proposals,
               count(*) FILTER (WHERE s.status = 'ACCEPTED')::int AS accepted,
               count(*) FILTER (WHERE s.status = 'ACCEPTED_WITH_CHANGES')::int AS edited
        FROM ai_suggestion s WHERE s.encounter_id = x.id
      ) s ON TRUE
      ORDER BY x.started_at, x.id
    `;
    return rows.map((row) => ({
      encounterId: row.id,
      startedAt: row.started_at,
      siteId: row.site_id,
      siteName: row.site_name,
      practitionerName: row.practitioner_name,
      status: row.status,
      attempts: row.attempts,
      costUsd: row.cost_usd,
      proposals: row.proposals,
      accepted: row.accepted,
      edited: row.edited,
    }));
  }

  async sites(scope: QualityScope): Promise<{ id: string; name: string }[]> {
    return this.prisma.site.findMany({
      where: scope.sites === 'all' ? {} : { id: { in: [...scope.sites] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
}
