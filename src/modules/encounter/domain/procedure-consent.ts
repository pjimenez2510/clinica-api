/**
 * The informed consent of a major-risk procedure — the MSP form 024
 * (EN-152 to EN-154, D-159, A.M. 5316).
 *
 * THE PAPER IS THE CONSENT; THIS IS ITS INDEX. The form 024 is signed on paper
 * with the text the clinic approved for that intervention (D-159.2), and what
 * the system keeps is who signed, who informed and when, tied to the
 * procedure. Scanning the paper and printing it from here are later work.
 *
 * Three kinds, one row each, never edited:
 *  - SIGNED — the patient, or their representative, signed it;
 *  - EXCEPTION — performed without it, with the written ground of the
 *    emergency or of the unexpected procedure during another (D-159.3);
 *  - REFUSED — the patient refused: no procedure, and the external witness
 *    when nobody signs (EN-153).
 * A revocation (EN-154) is a row of its own, so the consent it revokes stays
 * exactly what it was.
 */

/** Who signed the paper: the patient, or their representative. */
export const CONSENT_SIGNERS = ['PATIENT', 'REPRESENTATIVE'] as const;
export type ConsentSigner = (typeof CONSENT_SIGNERS)[number];

/** EN-153. Who refused — or nobody signed, and a witness did. */
export const REFUSAL_SIGNERS = ['PATIENT', 'REPRESENTATIVE', 'NONE'] as const;
export type RefusalSigner = (typeof REFUSAL_SIGNERS)[number];

/**
 * The representative's relationship to the patient, from a list and never
 * free text: the anexo asks for «parentesco», and a list is what keeps
 * «mamá», «Madre» and «madre» from being three answers.
 */
export const REPRESENTATIVE_RELATIONSHIPS = [
  'MOTHER',
  'FATHER',
  'SPOUSE',
  'CHILD',
  'SIBLING',
  'LEGAL_GUARDIAN',
  'OTHER_RELATIVE',
] as const;
export type RepresentativeRelationship =
  (typeof REPRESENTATIVE_RELATIONSHIPS)[number];

/** D-159.3. The two exceptions of the anexo the clinic admits. */
export const CONSENT_EXCEPTION_KINDS = [
  'EMERGENCY',
  'UNEXPECTED_DURING_PROCEDURE',
] as const;
export type ConsentExceptionKind = (typeof CONSENT_EXCEPTION_KINDS)[number];

export interface Representative {
  name: string;
  relationship: RepresentativeRelationship;
  /** Optional: the paper carries it; the system indexes the paper. */
  document: string | null;
}

/** EN-152. What travels with a procedure that needs its 024. */
export type ProcedureConsentInput =
  | {
      kind: 'SIGNED';
      signer: ConsentSigner;
      representative: Representative | null;
      /** Absent means «ahora», the application's clock. */
      signedAt?: Date;
    }
  | {
      kind: 'EXCEPTION';
      exceptionKind: ConsentExceptionKind;
      reason: string;
    };

/** EN-153. A refusal: the intervention, who refused, or the witness. */
export interface RefusalInput {
  conceptId: string;
  signer: RefusalSigner;
  representative: Representative | null;
  witness: { name: string; document: string } | null;
  /** Absent means «ahora». */
  refusedAt?: Date;
}

/** EN-154. Who expressed the revocation. */
export interface RevocationInput {
  signer: ConsentSigner;
  representative: Representative | null;
}

export interface PersonRef {
  id: string;
  name: string;
}

/** EN-154. The revocation, beside the consent it revokes. */
export interface RevocationView {
  signer: ConsentSigner;
  representative: Representative | null;
  revokedAt: Date;
  revokedBy: PersonRef;
}

/** EN-152. The 024 of a procedure, as the attention serves it. */
export interface ProcedureConsentView {
  id: string;
  kind: 'SIGNED' | 'EXCEPTION';
  signer: ConsentSigner | null;
  representative: Representative | null;
  exceptionKind: ConsentExceptionKind | null;
  exceptionReason: string | null;
  informedBy: PersonRef | null;
  signedAt: Date | null;
  recordedAt: Date;
  recordedBy: PersonRef;
  revocation: RevocationView | null;
}

/** EN-153. A refusal, with the intervention it refused. */
export interface RefusalView {
  id: string;
  conceptId: string;
  procedureCode: string;
  procedureDisplay: string;
  signer: RefusalSigner;
  representative: Representative | null;
  witness: { name: string; document: string } | null;
  informedBy: PersonRef;
  refusedAt: Date;
  recordedBy: PersonRef;
}

/** Why a consent payload cannot stand, named for the error to raise. */
export type ConsentProblem =
  | 'SIGNED_AFTER_PROCEDURE'
  | 'REPRESENTATIVE_REQUIRED'
  | 'EXCEPTION_REASON_REQUIRED';

/**
 * EN-152. What a consent must say before it is written; `null` when it says
 * it. The paper is signed BEFORE the procedure: a signature after the act
 * is not the consent the norm describes, whatever the paper says.
 */
export function consentProblem(
  consent: ProcedureConsentInput,
  performedAt: Date,
  signedAt: Date,
): ConsentProblem | null {
  if (consent.kind === 'EXCEPTION') {
    return consent.reason.trim() === '' ? 'EXCEPTION_REASON_REQUIRED' : null;
  }
  if (
    consent.signer === 'REPRESENTATIVE' &&
    !hasRepresentative(consent.representative)
  ) {
    return 'REPRESENTATIVE_REQUIRED';
  }
  return signedAt.getTime() > performedAt.getTime()
    ? 'SIGNED_AFTER_PROCEDURE'
    : null;
}

/** Why a refusal cannot stand; `null` when it says who refused. */
export type RefusalProblem = 'WITNESS_REQUIRED' | 'REPRESENTATIVE_REQUIRED';

/**
 * EN-153. Nobody signs → the external witness, with name and document (the
 * anexo, literal h); the representative signs → their name and relationship.
 */
export function refusalProblem(refusal: RefusalInput): RefusalProblem | null {
  if (refusal.signer === 'NONE') {
    const witness = refusal.witness;
    return witness === null ||
      witness.name.trim() === '' ||
      witness.document.trim() === ''
      ? 'WITNESS_REQUIRED'
      : null;
  }
  if (
    refusal.signer === 'REPRESENTATIVE' &&
    !hasRepresentative(refusal.representative)
  ) {
    return 'REPRESENTATIVE_REQUIRED';
  }
  return null;
}

/** EN-154. A representative who revokes says who they are. */
export function revocationProblem(
  revocation: RevocationInput,
): 'REPRESENTATIVE_REQUIRED' | null {
  return revocation.signer === 'REPRESENTATIVE' &&
    !hasRepresentative(revocation.representative)
    ? 'REPRESENTATIVE_REQUIRED'
    : null;
}

function hasRepresentative(
  representative: Representative | null,
): representative is Representative {
  return representative !== null && representative.name.trim() !== '';
}
