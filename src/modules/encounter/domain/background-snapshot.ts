/**
 * EN-206, EN-207. The patient's background as it stood when a note was signed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A COPY, AND WHY INSIDE THE HASHED CONTENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Allergies and history are the PATIENT's state (EN-080, EN-085): they change
 * after the visit — an allergy is ruled out, a family history is added. A
 * signed note is the record of one ACT, and what the doctor had in front of
 * them at that act is part of what they signed. So the signature copies the
 * background into `content`, BEFORE the digest is computed (EN-027): if the
 * chart changes, the note does not; and if somebody edits the copy in the
 * database, the hash says so.
 *
 * THE SERVER WRITES IT, NEVER THE SCREEN. Whatever a caller sends under the
 * reserved key is replaced — a snapshot a client could compose would be a
 * statement about the chart nobody checked.
 *
 * PURE: plain JSON with ISO instants, so it round-trips through `jsonb` and
 * hashes the same before and after.
 */

import type { ActiveAllergy } from '../../../shared/clinical/patient-allergy.port';
import type { AllergyAbsenceAssertion } from './patient-allergy.repository';
import type { HistoryView } from './patient-history.repository';

/** A note's `content`; declared here so this file does not import the note. */
type NoteContent = Readonly<Record<string, unknown>>;

/** The reserved key in `content`. No template section may use it. */
export const BACKGROUND_SNAPSHOT_KEY = 'backgroundSnapshot';

/** EN-207. The section the snapshot can stand in for. */
export const BACKGROUND_SECTION = 'antecedentes';

export interface BackgroundSnapshot {
  takenAt: string;
  allergies: {
    substance: string;
    reaction: string | null;
    criticality: string;
    recordedAt: string;
  }[];
  noKnownAllergies: { assertedByName: string; assertedAt: string } | null;
  personalHistory: { description: string; recordedAt: string }[];
  familyHistory: {
    description: string;
    relative: string;
    recordedAt: string;
  }[];
}

/**
 * EN-206. The snapshot of what is active now. The readers already filter out
 * what was ruled out (EN-082) and read the whole chart scope (EN-084).
 */
export function backgroundSnapshotOf(input: {
  takenAt: Date;
  allergies: readonly ActiveAllergy[];
  noKnownAllergies: AllergyAbsenceAssertion | null;
  history: readonly HistoryView[];
}): BackgroundSnapshot {
  return {
    takenAt: input.takenAt.toISOString(),
    allergies: input.allergies.map((allergy) => ({
      substance: allergy.substanceText,
      reaction: allergy.reaction,
      criticality: allergy.criticality,
      recordedAt: allergy.recordedAt.toISOString(),
    })),
    noKnownAllergies: input.noKnownAllergies
      ? {
          assertedByName: input.noKnownAllergies.assertedByName,
          assertedAt: input.noKnownAllergies.assertedAt.toISOString(),
        }
      : null,
    personalHistory: input.history
      .filter((entry) => entry.kind === 'PERSONAL')
      .map((entry) => ({
        description: entry.description,
        recordedAt: entry.recordedAt.toISOString(),
      })),
    familyHistory: input.history
      .filter((entry) => entry.kind === 'FAMILY')
      .map((entry) => ({
        description: entry.description,
        relative: entry.relative ?? '',
        recordedAt: entry.recordedAt.toISOString(),
      })),
  };
}

/**
 * EN-206. The content with THIS snapshot under the reserved key, or with none
 * when `snapshot` is null — never with the one the caller sent.
 */
export function withBackgroundSnapshot(
  content: NoteContent,
  snapshot: BackgroundSnapshot | null,
): NoteContent {
  const rest = Object.fromEntries(
    Object.entries(content).filter(([key]) => key !== BACKGROUND_SNAPSHOT_KEY),
  );
  return snapshot ? { ...rest, [BACKGROUND_SNAPSHOT_KEY]: snapshot } : rest;
}

/** The snapshot a signed note carries, or `null` (notes signed before it). */
export function backgroundSnapshotIn(
  content: NoteContent,
): BackgroundSnapshot | null {
  const value = content[BACKGROUND_SNAPSHOT_KEY];
  return value && typeof value === 'object'
    ? (value as BackgroundSnapshot)
    : null;
}

/**
 * EN-207, D-125. An allergy or a history entry makes the «antecedentes»
 * section written. «Sin alergias conocidas» alone does NOT: it says nothing of
 * the personal and family history art. 6 asks for.
 */
export function coversBackgroundSection(
  snapshot: BackgroundSnapshot | null,
): boolean {
  if (!snapshot) return false;
  return (
    snapshot.allergies.length > 0 ||
    snapshot.personalHistory.length > 0 ||
    snapshot.familyHistory.length > 0
  );
}
