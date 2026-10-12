/**
 * AS-027, AS-028, AS-039. What the assistant reads of an attention to propose
 * its CIE-10 codes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SHARED PORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The attention, its note and its diagnoses are `encounter`'s, and no module
 * imports another (ADR-011): `assistant` reads them through here, like
 * `prescription` reads the allergies through `patient-allergy.port.ts`. The
 * reader lives in `shared/infrastructure/clinical` and carries the two rules
 * that a second copy would forget: the site scope of whoever asks (EN-121)
 * and the chart scope of the person (PA-055).
 *
 * ⚠️ IT READS AND IT NEVER WRITES. A diagnosis is recorded through its own
 * route (EN-040), by the physician; the assistant only proposes (P1).
 *
 * Written as unions and plain types, not imported from `@prisma/client`: the
 * assistant's domain reads them.
 */

/** The states of `encounter_status`, as the reader serves them. */
export type CodingEncounterStatus =
  | 'OPEN'
  | 'ON_HOLD'
  | 'DISCONTINUED'
  | 'DISCHARGED'
  | 'COMPLETED'
  | 'ENTERED_IN_ERROR';

/**
 * AS-039. Whether new clinical content may enter the attention.
 *
 * ⚠️ THE SAME PREDICATE AS `acceptsNewClinicalContent` in `encounter`, which
 * this module cannot import. `encounter-state.spec.ts` compares the two over
 * every state, so they cannot drift apart unnoticed.
 */
export function acceptsNewContent(status: CodingEncounterStatus): boolean {
  return status === 'OPEN' || status === 'ON_HOLD';
}

/** The attention, within the requester's sites. */
export interface CodingEncounter {
  id: string;
  patientId: string;
  siteId: string;
  /** AS-039. The user behind the attention's practitioner: the only one who asks. */
  practitionerUserId: string;
  status: CodingEncounterStatus;
  /** `YYYY-MM-DD` in America/Guayaquil: the day the catalogue must be in force. */
  clinicalDate: string;
}

/** One section of the consultation note that has text, in the template's order. */
export interface NoteSectionText {
  key: string;
  /** What the template calls it; the key when the template does not say. */
  label: string;
  text: string;
}

export interface ConsultationNote {
  id: string;
  sections: NoteSectionText[];
}

/**
 * AS-025. Who the text may name, for the pseudonymizer only. Clinical data:
 * it never reaches a log, an `ai_run` row or an answer.
 */
export interface CodingPeople {
  patient: string[];
  staff: string[];
}

/**
 * AS-027. A code and how often, and when last, it was recorded. Its name and
 * whether it is still in force come from the catalogue (`Cie10Lookup`), not
 * from the snapshot of an old diagnosis.
 */
export interface CodeUse {
  code: string;
  times: number;
  /** `YYYY-MM-DD` in America/Guayaquil of the last attention that recorded it. */
  lastUsedOn: string;
}

export interface CodingContextReader {
  /**
   * EN-121. The attention, or null when it does not exist OR is of a site the
   * requester cannot reach — one answer for both.
   */
  encounter(
    encounterId: string,
    sites: 'all' | readonly string[],
  ): Promise<CodingEncounter | null>;
  /**
   * AS-028. The attention's consultation note (002): its id, which a proposal
   * cites as its source (P2), and its text by section; null without a note.
   */
  consultationNote(encounterId: string): Promise<ConsultationNote | null>;
  /** AS-025. The names the note may carry. */
  people(encounterId: string): Promise<CodingPeople>;
  /** AS-027. The codes this attention already has. */
  recordedCodes(encounterId: string): Promise<string[]>;
  /** AS-037. A diagnosis of THIS attention, or null when it is of another or gone. */
  diagnosisOf(
    encounterId: string,
    diagnosisId: string,
  ): Promise<{ id: string; code: string } | null>;
  /**
   * AS-027, PA-055. What this person was coded with in OTHER attentions, of
   * every chart that is hers, most used first and the most recent on a tie.
   */
  patientHistory(
    patientId: string,
    exceptEncounterId: string,
    limit: number,
  ): Promise<CodeUse[]>;
  /**
   * AS-027, D-245 §4. What the clinic records most since `since`, every site,
   * annulled attentions left out. An aggregate: no patient in it.
   */
  clinicFrequency(since: Date, limit: number): Promise<CodeUse[]>;
}

export const CODING_CONTEXT_READER = Symbol('CODING_CONTEXT_READER');
