import type { HistoryView } from '../domain/patient-history.repository';

import type { HistoryResponse } from './patient-history.dto';

/** Shared with the chart summary, so the two reads cannot disagree. */
export function toHistoryResponse(entry: HistoryView): HistoryResponse {
  return {
    id: entry.id,
    patientId: entry.patientId,
    kind: entry.kind,
    description: entry.description,
    relative: entry.relative,
    recordedAt: entry.recordedAt.toISOString(),
    recordedBy: entry.recordedBy,
    refutedAt: entry.refutedAt?.toISOString() ?? null,
    refutedNotes: entry.refutedNotes,
    refutedBy: entry.refutedBy,
  };
}
