import { shownSections, type StoredDraftSection } from './note-draft';
import { normalisedEditDistance, type SuggestionStatus } from './suggestion';

/** AS-144. A section of the draft reviewed against the signed note. No text (AS-146). */
export interface SectionReview {
  suggestionId: string;
  clinicalNoteId: string;
  statusAtSigning: SuggestionStatus;
  distance: number;
}

/** The consultation note as it was signed: its id and its sections. */
export interface SignedNote {
  id: string;
  content: Readonly<Record<string, unknown>>;
}

/**
 * AS-144 (SigmAI RF-I02, `note-distance.ts`). What the physician had in front
 * of them when signing —every section they decided, and the undecided ones
 * the screen showed (AS-090)— each with the distance of AS-022 between what
 * was proposed and what the signed note says in that section. A version a
 * later draft replaced before anybody decided it was never the one on screen,
 * and a draft that did not finish was never shown: neither is reviewed.
 */
export function reviewAtSigning(
  stored: readonly StoredDraftSection[],
  doneDraftIds: ReadonlySet<string>,
  signed: SignedNote,
): SectionReview[] {
  const shown = new Set(
    shownSections(stored, doneDraftIds).map((each) => each.section.id),
  );
  return stored
    .filter(
      (each) =>
        doneDraftIds.has(each.draftId) &&
        (each.status !== 'PROPOSED' || shown.has(each.id)),
    )
    .map((each) => ({
      suggestionId: each.id,
      clinicalNoteId: signed.id,
      statusAtSigning: each.status,
      distance: normalisedEditDistance(each.text, textOf(signed, each.section)),
    }));
}

/** A section that is not text (a choice, the background snapshot) says nothing. */
function textOf(signed: SignedNote, section: string): string {
  const value = signed.content[section];
  return typeof value === 'string' ? value : '';
}
