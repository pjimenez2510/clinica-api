/**
 * The clinical note: which forms exist, what each one must contain, what the
 * signature freezes, and how a correction is added instead of applied.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE SENTENCE THIS FILE EXISTS FOR (REQ-005, EN-023, EN-025)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A SIGNED NOTE IS NEVER EDITED. A correction is an AMENDMENT that is ADDED —
 * a new version that points back at the one it replaces, with a written reason
 * — and the previous version stays readable and printable for ever. That is
 * the only thing in this system that defends the clinic in front of a judge,
 * and it is guaranteed by `trg_clinical_note_immutable` in the database, not
 * by these functions. What lives here is the part a database cannot express:
 * which correction is admissible and what the refusal should say.
 *
 * PURE. `node:crypto` is a core module, not a framework, and the digest is a
 * deterministic function of its input — which is what lets SC-012 recompute
 * the hash of every signed note of the last year without booting anything.
 */

import { createHash } from 'node:crypto';

import {
  AmendmentReasonRequiredError,
  NoteAlreadySignedError,
  NoteNotAmendableError,
  UnknownClinicalFormError,
} from './encounter.errors';
import type { NoteStatus } from './encounter';

/**
 * EN-021. A form of the MSP, identified BY DATA and never by an enum.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE CODE IS DATA AND THE SHAPE IS CODE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `clinical_note.form_code` is a `VarChar(8)` and `form_version` travels with
 * it, so the day the ministry renumbers a form it costs an UPDATE and not a
 * migration — and the A.M. 00115-2021 went from **16 forms to 51**, which is
 * exactly the size of the problem an enum would have created. This clinic does
 * not need the 51; the difference is the reason.
 *
 * What is NOT free is which shapes can be validated: a note stored under a
 * code nobody declared is a note nothing can check, and it is discovered years
 * later by whoever has to produce it. So the CODE is a column and the CONTENT
 * RULE is a row of this registry, keyed by `(form_code, form_version)`.
 */
export interface ClinicalForm {
  /** `002`, `020`, `005` — the MSP's own numbering, as a string. */
  code: string;
  /** Versioned apart, so a revised 002 is a new key and not a new table. */
  version: string;
  /** What the screen calls it. Spanish, because a person reads it. */
  name: string;
  /**
   * EN-020. The sections art. 6 of the A.M. 00115-2021 lists as MINIMUM
   * content, enumerated rather than referenced.
   *
   * «El contenido mínimo del reglamento» specifies nothing; this list does.
   */
  mandatorySections: readonly string[];
  /**
   * EN-130, EN-138. Whether SIGNING this form is the clinical discharge.
   *
   * ⚠️ ONLY THE CONSULTATION NOTE DISCHARGES, and the distinction is the whole
   * of D-A-008 applied here: signing the vital-signs form means nursing
   * finished the preparation, and signing the consultation note means the
   * DOCTOR finished. Treating them the same would discharge the patient the
   * moment their weight was recorded — before anybody had seen them.
   */
  dischargesTheEncounter: boolean;
}

/**
 * The forms this delivery knows how to validate.
 *
 * ⚠️ IT IS DELIBERATELY SHORT. Adding one is a row here plus its mandatory
 * sections, never a migration — that is the whole point of EN-021 — and adding
 * one that nothing writes would be a promise the system does not keep. The
 * nursing forms **120** (intervenciones de enfermería) and **022**
 * (administración de medicamentos) are NOT here: they are written with
 * `nursing:write` through routes this delivery does not build (EN-142), and
 * declaring them now would make them reachable through the doctor's route,
 * which is precisely the separation of functions the LOS art. 198 demands.
 *
 * ⚠️ AND **020** IS NOT HERE EITHER, for a different reason: the vital signs
 * are a TYPED TABLE (`encounter_vitals`, EN-060), not prose in a JSON column.
 * The form number is what the paper is called; the storage is block D. See the
 * header of `vital-signs.ts`.
 */
export const CLINICAL_FORMS: readonly ClinicalForm[] = [
  {
    code: '002',
    version: '1',
    name: 'Consulta externa',
    /**
     * EN-020, art. 6 of the A.M. 00115-2021, written out in full.
     *
     * ⚠️ TWO OF THE EIGHT THE ARTICLE LISTS ARE NOT HERE, and their absence is
     * the frontier the schema comment already fixed: «constantes vitales y
     * antropometría» are `encounter_vitals` (EN-060) and «diagnóstico» is
     * `encounter_diagnosis` (EN-040), because the ministry REPORTS on both and
     * the system QUERIES both. The other six are prose that is only read and
     * printed, and prose lives in `content`.
     *
     * Moving the reason for the visit into a column would buy nothing; moving
     * the diagnosis into this JSON would make the monthly report impossible.
     */
    mandatorySections: [
      'motivoConsulta',
      'antecedentes',
      'enfermedadActual',
      'revisionOrganosSistemas',
      'examenFisico',
      'planTratamiento',
    ],
    dischargesTheEncounter: true,
  },
  {
    code: '005',
    version: '1',
    name: 'Evolución y prescripciones',
    /**
     * The evolution note carries one narrative and no fixed skeleton: it is
     * written during the attention, several times, and demanding six sections
     * of it would turn a two-line note about a dressing change into a form.
     * Art. 6 governs the HISTORY's minimum content and the 002 is where this
     * system satisfies it.
     */
    mandatorySections: ['evolucion'],
    /**
     * An evolution note does not end the attention: a patient can have three
     * of them in one visit. The discharge is the 002 being signed.
     */
    dischargesTheEncounter: false,
  },
];

/** `002@1` — the key of the registry, and what a refusal names. */
const keyOf = (code: string, version: string): string => `${code}@${version}`;

const BY_KEY = new Map(
  CLINICAL_FORMS.map((form) => [keyOf(form.code, form.version), form]),
);

/**
 * EN-021. The form, or a refusal naming the ones that exist.
 *
 * A REFUSAL AND NOT A DEFAULT: falling back to «002» for an unknown code would
 * store a consultation note under whatever number the caller typed, and
 * `form_code` is what a printed history is filed by.
 */
export function requireForm(code: string, version: string): ClinicalForm {
  const form = BY_KEY.get(keyOf(code, version));
  if (!form) {
    throw new UnknownClinicalFormError(
      CLINICAL_FORMS.map((known) => keyOf(known.code, known.version)),
    );
  }
  return form;
}

/** The narrative sections of a form, as they are stored in `content`. */
export type NoteContent = Readonly<Record<string, unknown>>;

/**
 * EN-027. The cryptographic digest of the content plus the signing metadata.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT EXISTS SO THE PROOF DOES NOT DEPEND ON THE TRIGGER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The schema comment says it outright: the hash proves the content has not
 * changed since the signature **without relying on the immutability trigger
 * never having been disabled**. It is what SC-012 recomputes over every signed
 * note of the last year, and a figure of zero mismatches is the only evidence
 * that survives somebody having had superuser on the database for an afternoon.
 *
 * THE SIGNER AND THE INSTANT ARE INSIDE THE DIGEST, not beside it. Hashing the
 * content alone would let a note be re-attributed to another doctor with the
 * hash still checking out — and «quién firmó» is half of what art. 4 demands
 * be made to appear.
 *
 * CANONICALISED FIRST, because `JSON.stringify` of an object depends on the
 * insertion order of its keys: the same note read back through a different
 * code path would serialise differently and the digest would report a forgery
 * that never happened.
 */
export function contentHashOf(input: {
  content: NoteContent;
  signedById: string;
  signedAt: Date;
}): string {
  return createHash('sha256')
    .update(
      [
        canonicalise(input.content),
        input.signedById,
        input.signedAt.toISOString(),
      ].join('\n'),
    )
    .digest('hex');
}

/**
 * A JSON value written so that two equal values always produce the same text.
 *
 * Object keys sorted, arrays kept in order — order is meaning in an array and
 * noise in an object. `undefined` members are dropped exactly as
 * `JSON.stringify` drops them, so a value that round-trips through PostgreSQL
 * hashes the same before and after.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'; // prettier-ignore
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalise(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalise(member)}`);

  return `{${entries.join(',')}}`;
}

/**
 * EN-023. A note that may still be edited in place.
 *
 * ONLY A DRAFT, and the database says the same thing from the other side:
 * `clinical_note_immutable_when_signed` returns `NEW` unchanged when
 * `OLD.status = 'DRAFT'` and raises `insufficient_privilege` for everything
 * else. This is what lets the service answer «esa nota ya está firmada»
 * instead of letting a 42501 come out as «no tiene permisos».
 */
export function assertEditable(status: NoteStatus): void {
  if (status !== 'DRAFT') throw new NoteAlreadySignedError();
}

/**
 * EN-025, EN-026. Only a SIGNED version may be amended or retracted.
 *
 * The three refusals — a draft, an already superseded version and a retracted
 * one — share a code because what the caller does next is the same in all of
 * them: go to the version that is current. See `NoteNotAmendableError`.
 */
export function assertAmendable(status: NoteStatus): void {
  if (status !== 'SIGNED') throw new NoteNotAmendableError(status);
}

/**
 * EN-025. The written reason, trimmed, or a refusal.
 *
 * IN THE DOMAIN AND NOT ONLY IN THE DTO: the DTO already refuses an empty
 * `amendmentReason` per field over HTTP, and this is for the caller that does
 * not come through it. A `DEBERÁ` only the transport enforces stops being true
 * the first time somebody amends a note from inside the service — which is the
 * lesson `CancellationReasonRequiredError` left in the agenda.
 */
export function requireAmendmentReason(reason: string | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed === '') throw new AmendmentReasonRequiredError();
  return trimmed;
}

/** EN-025. What one amendment writes, decided before anything is stored. */
export interface AmendmentPlan {
  /** Constant across every version of the note (EN-024). */
  chainId: string;
  /** `clinical_note_chain_version_unique` refuses a repeat. */
  version: number;
  /** `@unique`, so a version cannot be amended twice in parallel (EN-025). */
  supersedesId: string;
  reason: string;
}

/**
 * EN-024, EN-025. The next version of a chain.
 *
 * THE PREVIOUS VERSION IS NOT COPIED FORWARD. The new note carries the content
 * the amendment states, and the old one keeps its own — that is what «la
 * versión anterior DEBERÁ seguir siendo legible e imprimible» means. An
 * amendment that inherited the old content and patched it would make the two
 * rows differ by whatever the caller forgot to send.
 */
export function planAmendment(input: {
  previous: {
    id: string;
    chainId: string;
    version: number;
    status: NoteStatus;
  };
  reason: string | undefined;
}): AmendmentPlan {
  assertAmendable(input.previous.status);

  return {
    chainId: input.previous.chainId,
    version: input.previous.version + 1,
    supersedesId: input.previous.id,
    reason: requireAmendmentReason(input.reason),
  };
}
