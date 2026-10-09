/**
 * What block K needs from storage: the diagnoses and the procedures of an
 * attention.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A THIRD PORT, AND THE REASON IS THE CATALOGUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The attention's port answers questions about the act; the note's port
 * answers questions about a chain of versions. Everything here is a question
 * about a CATALOGUE CONCEPT: what its code and description were, whether it
 * was in force on the day of care, and which catalogue it came from. That is a
 * different reason to change — the day the CIE-10 edition is replaced, or the
 * tariff is republished, this file is what moves and neither of the other two
 * does. ADR-008 §2 splits on exactly that.
 *
 * ⚠️ IT ASKS ABOUT `catalog_concept` AND DOES NOT IMPORT `catalogs`. No module
 * imports another. This module declares the three facts it needs about a
 * concept — its catalogue, its code and its description — and its own adapter
 * answers them, the route `agenda` took for AG-027 and this module already
 * took for the patient chart and the practitioner.
 *
 * ⚠️ AND THERE IS NO METHOD THAT PRICES ANYTHING. `encounter_procedure` has a
 * `tariff_amount` column and it is NOT exposed here: what a procedure costs is
 * `charge_item`, which belongs to `billing`, resolved from the price list of
 * the payer on the service date (EN-051, D-049). A clinical table that also
 * carries money is the separation EN-051 exists to keep — see the note on
 * `ProcedureView`.
 */

import type {
  CareModality,
  CarePlace,
  DiagnosisCertainty,
  DiagnosisOccurrence,
  VisitSequence,
} from './encounter';
import type { SiteScopeFilter } from './encounter.repository';
import type { AfterDischargeRefusal } from './practitioner-licence';

/**
 * One diagnosis of block K, as this module serves it.
 *
 * ⚠️ THIS IS THE ONE VIEW OF THE MODULE THAT CARRIES A DIAGNOSIS, which is the
 * most sensitive datum the system holds. It is why every read of it is audited
 * (EN-122) and why `EncounterView` deliberately carries none of it (EN-124):
 * the listing of attentions is opened by everybody with `record:read` over the
 * site and leaves no trail, so a diagnosis must never travel in it.
 */
export interface DiagnosisView {
  id: string;
  encounterId: string;
  /** EN-040. The exact VERSION of the concept, not just its code. */
  conceptId: string;
  /**
   * EN-041. The code and the description AS THEY WERE, written by
   * `trg_diagnosis_snapshot` and kept in step with the concept by it.
   *
   * Deliberately redundant with the catalogue: in fifteen years the catalogue
   * may have been migrated, pruned or reloaded and the record still has to say
   * what was diagnosed — the same reason an invoice stores the price and not
   * only the product id.
   */
  cie10Code: string;
  cie10Display: string;
  certainty: DiagnosisCertainty;
  occurrence: DiagnosisOccurrence;
  /** EN-043, EN-047. Priority order; 1 is the principal, at most one per attention. */
  rank: number;
  /**
   * EN-046. DERIVED FROM THE CODE and never stored — Z00 to Z99 is prevention,
   * everything else is morbidity.
   *
   * It travels in the view rather than being left to each client because the
   * rule belongs to the instructivo and not to a screen: two clients deriving
   * it themselves is two chances of disagreeing with columns 84 and 85 of the
   * monthly report.
   */
  careModality: CareModality;
  /** EN-049. Whether the code is of obligatory epidemiological notification. */
  notifiable: boolean;
  /**
   * EN-235 (D-147.3). Whether its concept may be the principal: `false` for
   * an asterisk or an external cause of the WHO's list. Read off the CONCEPT,
   * which is where the list says it; the screen stops offering «principal».
   */
  mayBePrincipal: boolean;
  note: string | null;
  recordedAt: Date;
  /**
   * EN-212. When it was last edited, or `null` if never: the previous
   * versions are in `record_version` (EN-212, D-127.2).
   */
  editedAt: Date | null;
}

/**
 * EN-212. One version of a diagnosis that an edit replaced, read with the
 * SAME mapping as the current one, with who replaced it, when and — if the
 * code changed while a paper printed it — why.
 */
export interface DiagnosisVersionView {
  version: number;
  replacedBy: { id: string; name: string };
  replacedAt: Date;
  reason: string | null;
  diagnosis: DiagnosisView;
}

/**
 * One procedure of block K.
 *
 * ⚠️ NO AMOUNT, AND THE ABSENCE IS THE REQUIREMENT (EN-051, D-049).
 * `encounter_procedure.tariff_amount` exists in the schema and nothing here
 * reads or writes it: freezing money inside a clinical table collides with the
 * separation «lo clínico no es lo económico», which is what `billing` is built
 * on. What a procedure costs is a `charge_item` — resolved from the price list
 * of the attention's payer on the service date, with the resolved price row
 * kept for audit. The tariff supplies the NOMENCLATURE (EN-050) and, since
 * A.M. 0046-2017, is only an applicable amount when the payer is the public
 * network. The column is dead weight and is left where it is rather than
 * propagated; the note is on EN-051.
 */
export interface ProcedureView {
  id: string;
  encounterId: string;
  conceptId: string;
  /**
   * EN-050. The tariff code and its description, frozen at the moment of
   * performing it.
   *
   * ⚠️ FROZEN BY THIS MODULE AND NOT BY A TRIGGER, which is the difference
   * from the diagnosis. `trg_diagnosis_snapshot` guards `encounter_diagnosis`
   * and there is no counterpart on `encounter_procedure`, so nothing in the
   * database stops the two from being made to disagree. The adapter copies
   * them from the concept it read in the same transaction; the note is on
   * EN-050.
   */
  procedureCode: string;
  procedureDisplay: string;
  /**
   * EN-050. How many times it was performed in this attention.
   *
   * The instructivo's own example is two extractions in one visit: «por cada
   * procedimiento se genera una o más actividades las cuales debe registrar la
   * cantidad realizada». Columns 95 to 100 of the form are this number.
   */
  quantity: number;
  performedAt: Date;
  note: string | null;
  /** EN-244. When it was last corrected; `null` if never. */
  editedAt: Date | null;
}

/** EN-244. One version a correction replaced, with who and when. */
export interface ProcedureVersionView {
  version: number;
  replacedBy: { id: string; name: string };
  replacedAt: Date;
  procedure: ProcedureView;
}

/** EN-245. A procedure taken off the attention, as the archive keeps it. */
export interface RetractedProcedureView {
  id: string;
  procedureCode: string;
  procedureDisplay: string;
  quantity: number;
  retractedAt: Date;
  retractedBy: { id: string; name: string };
  reason: string;
}

/** EN-244. A correction in place: only what is present changes. */
export interface ProcedureEdit {
  encounterId: string;
  procedureId: string;
  conceptId?: string;
  quantity?: number;
  /** `null` clears the note. */
  note?: string | null;
  editedById: string;
  sites: SiteScopeFilter;
}

/** EN-245. Removing a procedure: archived whole, with who, when and why. */
export interface ProcedureRetraction {
  encounterId: string;
  procedureId: string;
  reason: string;
  retractedById: string;
  sites: SiteScopeFilter;
}

/** EN-246. Bringing a removed procedure back, as a new row. */
export interface ProcedureRestoration {
  encounterId: string;
  retractionId: string;
  restoredById: string;
  sites: SiteScopeFilter;
}

/** EN-244. One procedure of one attention, inside the caller's scope. */
export interface ProcedureQuery {
  encounterId: string;
  procedureId: string;
  sites: SiteScopeFilter;
}

/** EN-040 to EN-049. What registering a diagnosis needs to be told. */
export interface NewDiagnosis {
  encounterId: string;
  conceptId: string;
  certainty: DiagnosisCertainty;
  /** EN-045. Asked for per diagnosis, never derived from the attention. */
  occurrence: DiagnosisOccurrence;
  /**
   * EN-043, EN-047. Absent means «detrás del último», so the FIRST diagnosis
   * of an attention becomes the principal and the comorbidities queue behind
   * it. A caller that wants another order states it and the partial unique
   * index arbitrates the collision.
   */
  rank?: number;
  /**
   * EN-049. ⚠️ A STOPGAP, and it is the requirement's own note. The list of
   * notifiable codes is a property of the CONCEPT and there is no column for
   * it, so today the only way the flag can be set is by hand — which is
   * exactly the failure EN-049 describes: a dengue nobody ticks is a dengue
   * nobody notifies. Accepted here so the datum is not lost, and never
   * pretended to be derived.
   */
  notifiable?: boolean;
  note?: string;
  /** EN-121. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  /**
   * EN-215 (D-117.12, D-117.13). After the discharge a new diagnosis is a
   * correction of the coding: asked again under the attention's lock.
   * Absent is «no»: closed by default.
   */
  mayCorrectAfterDischarge?: boolean;
  afterDischargeRefusal?: AfterDischargeRefusal;
}

/**
 * EN-187, EN-215. The attention's own coding, corrected in place: only what is
 * present changes, and the previous attention is the database's version.
 */
export interface EncounterCodingCorrection extends CorrectionAuthority {
  encounterId: string;
  careModality?: CareModality;
  visitSequence?: VisitSequence;
  /** EN-012. */
  carePlace?: CarePlace;
  /** EN-013. */
  medicoDelBarrio?: boolean;
  sites: SiteScopeFilter;
}

/** EN-187, EN-215. The attention's coding as it stands after a correction. */
export interface EncounterCodingView {
  careModality: CareModality;
  visitSequence: VisitSequence;
  carePlace: CarePlace;
  medicoDelBarrio: boolean;
}

/** EN-050. What registering a procedure needs to be told. */
export interface NewProcedure {
  encounterId: string;
  conceptId: string;
  quantity: number;
  /** EN-034. WHEN it was performed, which is not when it was typed. */
  performedAt?: Date;
  note?: string;
  sites: SiteScopeFilter;
}

/**
 * EN-180. A diagnosis taken off its attention, as the archive keeps it: the
 * trace that says it was there, who removed it, when and — once the note was
 * signed — why.
 */
export interface RetractedDiagnosisView {
  id: string;
  cie10Code: string;
  cie10Display: string;
  rank: number;
  retractedAt: Date;
  retractedBy: { id: string; name: string };
  reason: string | null;
}

/** EN-180, EN-213, EN-214. What removing a diagnosis needs to be told. */
export interface DiagnosisRetraction {
  encounterId: string;
  diagnosisId: string;
  /** EN-214. Owed when an issued certificate or receta printed the code. */
  reason: string | null;
  /** The account that removes it. Never a cedula (REQ-110). */
  retractedById: string;
  /** EN-213, D-117.13. Whether it may still be done after the discharge. */
  mayCorrectAfterDischarge: boolean;
  afterDischargeRefusal?: AfterDischargeRefusal;
  sites: SiteScopeFilter;
}

/** EN-213. «Deshacer»: which removed diagnosis comes back, and who asks. */
export interface DiagnosisRestoration {
  encounterId: string;
  /** The id the diagnosis had, which is the id of its archive row. */
  retractionId: string;
  restoredById: string;
  sites: SiteScopeFilter;
}

/**
 * EN-212, D-117.13. Whether the caller may correct the coding once the
 * attention has its discharge: `record:sign` at its site and an ACESS
 * registration in force. Decided by the service, and asked again by the
 * adapter UNDER THE ATTENTION'S LOCK — the discharge can land between the two.
 */
export interface CorrectionAuthority {
  editedById: string;
  mayCorrectAfterDischarge: boolean;
  /**
   * D-117.13. Why not, when it may not — the refusal the adapter raises if
   * it finds the discharge under the lock: not signing at the site, no
   * practitioner profile, or the ACESS registration not in force. Decided
   * whatever the state the service read, because the discharge can land
   * between that read and the lock.
   */
  afterDischargeRefusal?: AfterDischargeRefusal;
}

/** D-117.13. Re-exported: the rule that decides it lives with the licence. */
export type { AfterDischargeRefusal };

/** EN-183, EN-212. Which diagnosis becomes the principal. */
export interface PrimaryChange extends CorrectionAuthority {
  encounterId: string;
  diagnosisId: string;
  sites: SiteScopeFilter;
}

/**
 * EN-212. An edit in place: only what is present changes. The code changes
 * through the CONCEPT (EN-040), never a typed code.
 */
export interface DiagnosisEdit extends CorrectionAuthority {
  encounterId: string;
  diagnosisId: string;
  conceptId?: string;
  certainty?: DiagnosisCertainty;
  occurrence?: DiagnosisOccurrence;
  /** `true` makes it the principal; `false` takes the principal off it. */
  primary?: boolean;
  /** EN-212. Owed when the code changes and a paper printed the old one. */
  reason: string | null;
  sites: SiteScopeFilter;
}

/** EN-212. The versions of one diagnosis of one attention. */
export interface DiagnosisQuery {
  encounterId: string;
  diagnosisId: string;
  sites: SiteScopeFilter;
}

/** EN-121. Block K of one attention, within the caller's scope. */
export interface CodingQuery {
  encounterId: string;
  sites: SiteScopeFilter;
}

/**
 * Block K's port, described at the top of this file. Its questions are about
 * catalogue concepts, and none of them prices anything.
 */
export interface ClinicalCodingRepository {
  /**
   * EN-040 to EN-049. Writes one diagnosis.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * EVERY CHECK LIVES INSIDE THIS METHOD'S TRANSACTION, AND THAT IS THE POINT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The catalogue the concept belongs to, its validity on the clinical date of
   * the attention and the rank still free are three questions whose answer can
   * change between a read and a write: a catalogue release lands, a second
   * doctor codes the principal diagnosis. Exposing any of them as a question a
   * caller can ask first and act on later is the race AG-045 was left open by,
   * and the same one `open` closes with `FOR UPDATE`.
   *
   * ⚠️ THE DATABASE IS STILL THE GUARANTEE FOR TWO OF THEM.
   * `trg_diagnosis_concept_in_force` and `encounter_diagnosis_one_primary`
   * also stop an import and a `psql`; what the adapter adds is the sentence,
   * because the trigger raises a class code whose constraint name never
   * travels.
   */
  addDiagnosis(diagnosis: NewDiagnosis): Promise<DiagnosisView>;

  /** EN-047. The diagnoses of one attention, principal first. */
  diagnosesOf(query: CodingQuery): Promise<DiagnosisView[]>;

  /**
   * EN-189. The CIE-10 codes an issued certificate of the attention printed
   * —in force or revoked—, as `medical_certificate.diagnoses` froze them.
   */
  codesPrintedOnCertificates(query: CodingQuery): Promise<string[]>;

  /**
   * EN-214 (D-117.14). The CIE-10 codes an issued receta of the attention
   * printed —in force or annulled—, as `prescription.diagnoses` froze them.
   */
  codesPrintedOnPrescriptions(query: CodingQuery): Promise<string[]>;

  /**
   * ORD-121 (D-117.5). The CIE-10 codes an issued order of the attention
   * printed, as `service_order.diagnoses` froze them.
   */
  codesPrintedOnOrders(query: CodingQuery): Promise<string[]>;

  /**
   * EN-180 to EN-182. Archives the diagnosis and takes it off the attention,
   * in one transaction under the attention's lock: whether the note is signed
   * and whether a document cites the diagnoses can both change between a read
   * and the write. `trg_encounter_diagnosis_delete_archived` and the archive's
   * own trigger say it a second time for every other writer.
   */
  retractDiagnosis(retraction: DiagnosisRetraction): Promise<void>;

  /**
   * EN-183. Makes a diagnosis the principal and moves the previous principal,
   * if any, behind the last rank in use. Returns the attention's diagnoses as
   * they stand afterwards.
   */
  makePrimary(change: PrimaryChange): Promise<DiagnosisView[]>;

  /**
   * EN-213. Brings a removed diagnosis back as a NEW row, under the
   * attention's lock, and marks its archive restored once. Refuses with
   * `DIAGNOSIS_NOT_RESTORABLE` an archive already restored or a code that is
   * live again; a principal comes back behind if another took its place.
   */
  restoreDiagnosis(restoration: DiagnosisRestoration): Promise<DiagnosisView>;

  /**
   * EN-212. Edits a diagnosis in place under the attention's lock, stamping
   * every row it touches with an instant after its previous stamp: the
   * previous version goes to `record_version` in the same statement
   * (`trg_encounter_diagnosis_record_version`). The refusals the triggers
   * also make — a paper that printed the code, a maternity rest, a report
   * already sent — are asked first, so they are sentences.
   */
  editDiagnosis(edit: DiagnosisEdit): Promise<DiagnosisView>;

  /**
   * EN-212. The versions an edit replaced, most recent first. Refuses with
   * `DIAGNOSIS_NOT_FOUND` a diagnosis that never was on the attention.
   */
  diagnosisVersions(query: DiagnosisQuery): Promise<DiagnosisVersionView[]>;

  /**
   * EN-180, EN-213. What was removed from one attention and not brought back,
   * oldest first.
   */
  retractedDiagnosesOf(query: CodingQuery): Promise<RetractedDiagnosisView[]>;

  /**
   * EN-187, EN-215. Corrects what the attention says the patient came for
   * and whether it is first-time or subsequent, under the attention's lock:
   * while it is live, or after the discharge by whoever may correct then
   * (D-117.13), and never once reported (D-117.16). Stamped, so the database
   * keeps the previous attention in `record_version`.
   */
  correctEncounterCoding(
    correction: EncounterCodingCorrection,
  ): Promise<EncounterCodingView>;

  /**
   * EN-050. Writes one procedure with its quantity.
   *
   * ⚠️ IT FREEZES THE CODE AND THE DESCRIPTION ITSELF. There is no
   * `trg_procedure_snapshot` to match the diagnosis's, so the copy is made
   * from the concept read in this same transaction. That is weaker than
   * EN-041's guarantee and the difference is written on `ProcedureView`.
   *
   * ⚠️ AND IT WRITES NO AMOUNT (EN-051). The charge is `billing`'s.
   */
  addProcedure(procedure: NewProcedure): Promise<ProcedureView>;

  /** EN-050. The procedures of one attention, in the order they were performed. */
  proceduresOf(query: CodingQuery): Promise<ProcedureView[]>;

  /** EN-244. Corrects a procedure under the attention's lock, stamped. */
  editProcedure(edit: ProcedureEdit): Promise<ProcedureView>;

  /** EN-244. The versions corrections replaced, most recent first. */
  procedureVersions(query: ProcedureQuery): Promise<ProcedureVersionView[]>;

  /** EN-245. Archives and removes a procedure, in one transaction. */
  retractProcedure(retraction: ProcedureRetraction): Promise<void>;

  /** EN-246. Brings a removed procedure back as a new row; marks the archive. */
  restoreProcedure(restoration: ProcedureRestoration): Promise<ProcedureView>;

  /** EN-245. The archive of one attention, without what was restored. */
  retractedProceduresOf(query: CodingQuery): Promise<RetractedProcedureView[]>;
}

/** Injection token. The application never names the adapter. */
export const CLINICAL_CODING_REPOSITORY = Symbol('ClinicalCodingRepository');
