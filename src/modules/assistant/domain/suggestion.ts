import {
  SuggestionAlreadyDecidedError,
  SuggestionInvalidError,
} from './assistant.errors';

/**
 * AS-020 to AS-024. A proposal of the assistant and what whoever received it
 * did with it (PLAN-ASISTENTE-IA.md §4, P1 and P2).
 *
 * The table `ai_suggestion` guarantees the shape of every decision; this file
 * decides WHICH one a given acceptance is — tal cual or con cambios — because
 * that is a judgement on the content, and the database cannot read it.
 */
export type SuggestionKind =
  'note-section' | 'diagnosis' | 'prescription-item' | 'order-item';

export type SuggestionStatus =
  'PROPOSED' | 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'DISCARDED';

/**
 * P2. Where a part of the proposal comes from: a stretch of the conversation
 * or a datum of the chart. A list, so the screen can point at each one.
 */
export type SuggestionSource =
  | { kind: 'transcript'; fromMs: number; toMs: number }
  | { kind: 'chart'; table: string; id: string };

/** The caller's resolved site scope, never a site they named. */
export type SiteScopeFilter = 'all' | readonly string[];

/**
 * AS-020. The tables a chart source may name: what the chart shows. A closed
 * list, so a source never names an arbitrary table — whoever resolves one to
 * point at it (phase B/C) reads it with the patient's scope, never by
 * interpolating `table`.
 */
export const CHART_SOURCE_TABLES = [
  'patient_allergy',
  'patient_history',
  'encounter_vitals',
  'encounter_diagnosis',
  'clinical_note',
  'prescription',
  'service_order',
  'observation_result',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AS-020. The sources as the assistant sent them, checked one by one:
 * a stretch of the conversation (`fromMs ≤ toMs`, whole non-negative
 * milliseconds) or a datum of the chart (a known table and a uuid).
 */
export function validSources(sources: unknown): SuggestionSource[] {
  if (!Array.isArray(sources)) throw new SuggestionInvalidError('sources');
  return sources.map((source: unknown) => {
    const each = (source ?? {}) as Record<string, unknown>;
    if (
      each.kind === 'transcript' &&
      Number.isSafeInteger(each.fromMs) &&
      Number.isSafeInteger(each.toMs) &&
      (each.fromMs as number) >= 0 &&
      (each.fromMs as number) <= (each.toMs as number) &&
      Object.keys(each).length === 3
    ) {
      return { kind: 'transcript', fromMs: each.fromMs as number, toMs: each.toMs as number }; // prettier-ignore
    }
    if (
      each.kind === 'chart' &&
      (CHART_SOURCE_TABLES as readonly unknown[]).includes(each.table) &&
      typeof each.id === 'string' &&
      UUID.test(each.id) &&
      Object.keys(each).length === 3
    ) {
      return { kind: 'chart', table: each.table as string, id: each.id };
    }
    throw new SuggestionInvalidError('source');
  });
}

/** The record an accepted proposal became, by the table that holds it. */
export interface SuggestionRecord {
  kind:
    'clinical_note' | 'encounter_diagnosis' | 'prescription' | 'service_order';
  id: string;
}

export interface SuggestionView {
  id: string;
  encounterId: string;
  aiRunId: string;
  kind: SuggestionKind;
  proposal: Readonly<Record<string, unknown>>;
  sources: readonly SuggestionSource[];
  status: SuggestionStatus;
  distance: number | null;
  record: SuggestionRecord | null;
  proposedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/**
 * What the doctor did. `saved` is what was finally written for the field:
 * the text of the section or line, or the CIE-10 code of the diagnosis —
 * READ FROM THE RECORD by the adapter for a section and a diagnosis (AS-022),
 * so a caller cannot make a changed one look «tal cual».
 */
export type SuggestionVerdict =
  | { outcome: 'accept'; recordId: string; saved: string }
  | { outcome: 'discard' };

export interface SuggestionDecision {
  status: Exclude<SuggestionStatus, 'PROPOSED'>;
  distance: number | null;
  record: SuggestionRecord | null;
}

const RECORD_OF: Readonly<Record<SuggestionKind, SuggestionRecord['kind']>> = {
  'note-section': 'clinical_note',
  diagnosis: 'encounter_diagnosis',
  'prescription-item': 'prescription',
  'order-item': 'service_order',
};

/**
 * AS-021 to AS-023. The decision a verdict makes of a proposal: final, linked
 * to the record of the proposal's own kind, and «con cambios» exactly when the
 * distance says so — never because the caller says so.
 */
export function decisionOf(
  suggestion: SuggestionView,
  verdict: SuggestionVerdict,
): SuggestionDecision {
  if (suggestion.status !== 'PROPOSED') {
    throw new SuggestionAlreadyDecidedError();
  }
  if (verdict.outcome === 'discard') {
    return { status: 'DISCARDED', distance: null, record: null };
  }
  const distance = distanceOf(suggestion, verdict.saved);
  return {
    status: distance === 0 ? 'ACCEPTED' : 'ACCEPTED_WITH_CHANGES',
    distance,
    record: { kind: RECORD_OF[suggestion.kind], id: verdict.recordId },
  };
}

/**
 * AS-022, AS-109. A diagnosis and an exam are a choice among codes: 0 when
 * the saved code is one of those proposed, 1 when it is not (a nearby code
 * is not «almost right»). Everything else is text: the edit distance to
 * `proposal.text`.
 */
function distanceOf(suggestion: SuggestionView, saved: string): number {
  if (suggestion.kind === 'diagnosis' || suggestion.kind === 'order-item') {
    return proposedCodes(suggestion.proposal).includes(saved.trim()) ? 0 : 1;
  }
  const text = suggestion.proposal.text;
  return normalisedEditDistance(typeof text === 'string' ? text : '', saved);
}

function proposedCodes(proposal: Readonly<Record<string, unknown>>): string[] {
  const { codes, code } = proposal;
  if (Array.isArray(codes)) {
    return codes.filter((each): each is string => typeof each === 'string');
  }
  return typeof code === 'string' ? [code] : [];
}

/**
 * Past this length the quadratic comparison would hold the event loop for
 * seconds; a section that long is either the same text (0) or not (1).
 */
export const EDIT_DISTANCE_LIMIT = 4_000;

/**
 * AS-022. Levenshtein distance divided by the length of the longer text,
 * rounded to the four decimals the column keeps — and never rounded down to 0
 * when the texts differ, which would turn «con cambios» into «tal cual».
 */
export function normalisedEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  const longer = Math.max(a.length, b.length);
  if (longer > EDIT_DISTANCE_LIMIT) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  const edits = previous[b.length]!;
  if (edits === 0) return 0;
  return Math.max(0.0001, Math.round((edits / longer) * 10_000) / 10_000);
}
