/**
 * What the prescription needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this and the Prisma adapter implements it.
 * `dependency-cruiser` enforces the direction.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE ARE QUESTIONS ABOUT ENCOUNTERS, PATIENTS, PRACTITIONERS AND SITES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 5 of the Resolución ACESS-2023-0030 puts on the document the patient's
 * name, their age, their diagnosis, their allergies, the establishment, its
 * city and the prescriber's ACESS registration. NONE of that is obtained by
 * importing `encounter`, `patients`, `staff` or `organization`: no module
 * imports another (CLAUDE.md §3), and the day that rule is bent «for just one
 * lookup» the modules stop being modules. This module declares the facts it
 * needs and its own adapter answers them — the route `agenda` took for AG-027
 * and `encounter` took for the chart, the practitioner and the appointment.
 *
 * WHAT IS DELIBERATELY ABSENT: any question that asks whether a prescription
 * COULD be issued. PR-060, PR-032 and PR-034 are all decided inside `issue`,
 * with the rows as they are at that instant, for the same reason `encounter`
 * keeps EN-005 inside `open`: a caller who can ask first and act later is a
 * race, and here the race writes a prescription for a substance an allergy was
 * recorded for one second earlier.
 */

import type { ItemContent } from './prescription-content';
import type { KnownAllergy } from './allergy-check';

import type { PrescriptionStatus } from './prescription';

/**
 * The caller's site scope, as `Principal.sitesFor` states it: every site, or an
 * explicit list.
 *
 * Declared here and not imported from `encounter`, for the reason above. The
 * DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];

/** PR-006. One prescription, by id, within the caller's scope. */
export interface PrescriptionQuery {
  prescriptionId: string;
  sites: SiteScopeFilter;
}

/** PR-001. The prescriptions of one attention, within the caller's scope. */
export interface EncounterPrescriptionsQuery {
  encounterId: string;
  sites: SiteScopeFilter;
}

/**
 * PR-001, PR-002, PR-025. The facts this module needs about an attention, and
 * no more.
 *
 * NOT THE DIAGNOSIS AND NOT THE NOTE. What the patient has travels only in the
 * DOCUMENT (PR-026), which is audited; this shape is what the write path uses,
 * and a field that is never loaded cannot end up in a log.
 */
export interface PrescribingEncounter {
  id: string;
  siteId: string;
  patientId: string;
  status: string;
  /** PR-007. The clinical date the CNMB concept has to be in force on. */
  startedAt: Date;
}

/** PR-004, PR-034. Who the caller is, clinically, and whether they may issue. */
export interface PrescriberIdentity {
  practitionerId: string;
  givenName: string;
  familyName: string;
  /**
   * PR-034. `null` when the practitioner has no registration on file, which
   * this module refuses — art. 5.d.ii prints the number ON the document.
   */
  acessRegistration: string | null;
  /**
   * A CALENDAR DATE AND NOT AN INSTANT (`acess_expires_on` is a `date`): a
   * registration lapses on a day, not at a moment, and turning it into an
   * instant is where the time-zone bugs come from.
   */
  acessExpiresOn: Date | null;
}

/** PR-008, PR-009. One line as it is written. */
export interface NewPrescriptionItem {
  /** PR-007. `null` prescribes outside the CNMB and demands PR-009. */
  conceptId: string | null;
  /**
   * PR-008. Only read when `conceptId` is `null`. With a concept the DCI is
   * copied FROM THE CONCEPT read in the write's own transaction, never from
   * the request.
   */
  genericName: string | null;
  presentation: string | null;
  concentration: string | null;
  routeCode: string | null;
  quantity: number | null;
  doseText: string | null;
  frequencyText: string | null;
  durationDays: number | null;
  instructions: string | null;
  offFormularyJustification: string | null;
}

/** PR-001 to PR-009. Everything a prescription is born with. */
export interface NewPrescription {
  encounterId: string;
  prescriberId: string;
  /** PR-038. Optional while composing; the issue demands it. */
  warningSigns: string | null;
  /** PR-039. Optional while composing; the issue demands it. */
  nonPharmacologicalAdvice: string | null;
  items: readonly NewPrescriptionItem[];
  /** PR-001, PR-006. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
}

/** One line, as this module serves it. */
export interface PrescriptionItemView {
  id: string;
  /** 1-based position in the prescription. The address an error uses. */
  line: number;
  conceptId: string | null;
  /** PR-008, PR-028. The DCI, frozen. */
  genericName: string;
  presentation: string | null;
  concentration: string | null;
  routeCode: string | null;
  quantity: number | null;
  doseText: string;
  frequencyText: string;
  durationDays: number | null;
  instructions: string | null;
  offFormularyJustification: string | null;
}

/**
 * A prescription as this module serves it on the write path.
 *
 * ⚠️ NO PATIENT NAME AND NO DIAGNOSIS. Those belong to the DOCUMENT
 * (`PrescriptionDocumentSource`), which is read through one audited route
 * (PR-092). A listing is opened by everybody holding `record:read` over the
 * site and leaves no trail, so the medicine may travel in it — it is what the
 * screen is for — but nothing that identifies the person does.
 */
export interface PrescriptionView {
  id: string;
  encounterId: string;
  prescriberId: string;
  status: PrescriptionStatus;
  issuedAt: Date | null;
  /**
   * PR-020. The short code a pharmacy checks the prescription with, WITHOUT
   * receiving any clinical datum. `null` while the prescription is a draft.
   *
   * ⚠️ IT IS NOT THE SEQUENTIAL NUMBER: that is `sequenceNumber`. The code is
   * random on purpose because it leaves the building on paper.
   */
  verificationCode: string | null;
  /**
   * PR-020 (art. 5.a.i). Consecutive per site, assigned by the database at the
   * issue. `null` while DRAFT or DISCARDED.
   */
  sequenceNumber: number | null;
  /** PR-038 (art. 5.e.iv). Demanded at the issue, not at composition. */
  warningSigns: string | null;
  /** PR-039 (art. 5.e.v). Demanded at the issue, not at composition. */
  nonPharmacologicalAdvice: string | null;
  createdAt: Date;
  /**
   * PR-011. When the draft was discarded, and why.
   *
   * ⚠️ THE REASON TRAVELS AND IS NOT KEPT BACK, because a register nobody can
   * read is not a register. `prescription_discard_states_who_when_and_why`
   * refuses the row unless all three are present, so a `DISCARDED` prescription
   * with a blank reason cannot exist — and the next doctor opening the chart is
   * exactly who has to be able to see that this line was a typing mistake and
   * not medication that was stopped.
   *
   * WHO discarded it is deliberately NOT here: the listing is not audited
   * (PR-092), and the accountable «quién» belongs in the trail rather than on
   * every screen that lists a prescription.
   */
  discardedAt: Date | null;
  discardReason: string | null;
  items: readonly PrescriptionItemView[];
}

/**
 * PR-021, PR-032, PR-034, PR-060. Everything the ISSUE has to judge, read
 * inside the transaction that writes.
 *
 * ⚠️ IT IS ONE SHAPE AND NOT FOUR QUESTIONS, and that is the whole point. Every
 * one of these can change between a read and a write: an allergy is recorded, a
 * registration lapses at midnight, a colleague issues the same draft. Handing
 * them to the policy as a snapshot taken INSIDE the transaction is what makes
 * the refusal true at the instant the row would land.
 */
export interface IssueSnapshot {
  status: PrescriptionStatus;
  /** PR-038, PR-039. The indications of art. 5.e, judged with the lines. */
  warningSigns: string | null;
  nonPharmacologicalAdvice: string | null;
  /** PR-032. The lines as art. 5.c has to find them. */
  items: readonly ItemContent[];
  /** PR-062. The chart's allergies AND those of every chart it absorbed. */
  allergies: readonly KnownAllergy[];
  /** PR-021. The canton of the site's DPA parish; `null` when unconfigured. */
  cityOfPrescription: string | null;
  /** PR-034. Read again here: a registration lapses without anybody writing. */
  prescriber: {
    acessRegistration: string | null;
    acessExpiresOn: Date | null;
  };
}

/** PR-005. What the issue writes, once the policy has accepted it. */
export interface IssuePlan {
  issuedAt: Date;
  verificationCode: string;
}

/**
 * PR-011. What discarding a draft writes: who, when and why, the three
 * together.
 *
 * ⚠️ THE THREE ARE ONE SHAPE BECAUSE THE DATABASE TREATS THEM AS ONE.
 * `prescription_discard_states_who_when_and_why` is
 * `status <> 'DISCARDED' OR (discarded_at IS NOT NULL AND discarded_by_id IS
 * NOT NULL AND discard_reason IS NOT NULL)`, so a plan able to carry two of
 * them would be a plan the `CHECK` refuses. Making them optional here would
 * move a guarantee that already exists into a place where it can be forgotten.
 */
export interface DiscardPlan {
  discardedAt: Date;
  /** The ACCOUNT that discarded it: `discarded_by_id` targets `app_user`. */
  discardedById: string;
  /** PR-011. Obligatory. Without it, discarding is a way of making it vanish. */
  discardReason: string;
}

/**
 * PR-020 to PR-040. Everything the DOCUMENT carries, as storage answers it.
 *
 * ⚠️ THIS IS THE ONE SHAPE OF THE MODULE THAT CARRIES A PATIENT AND A
 * DIAGNOSIS, which is why every read of it is audited (PR-092) and why
 * `PrescriptionView` deliberately carries neither.
 */
export interface PrescriptionDocumentSource {
  prescription: PrescriptionView;
  /** PR-022. The establishment, and PR-021 its city. */
  site: { id: string; name: string; mspUnicode: string; city: string | null };
  /** PR-024, PR-025. */
  patient: {
    familyName: string;
    givenName: string;
    /** PR-025. The FROZEN age of the attention, never today's. */
    ageYears: number | null;
    ageMonths: number | null;
    ageDays: number | null;
  };
  /** PR-026. The diagnoses of the attention, principal first, frozen. */
  diagnoses: readonly { code: string; display: string }[];
  /**
   * PR-027. Non-refuted allergies of the chart and of the absorbed ones.
   *
   * ⚠️ THEY DO NOT COME FROM THIS MODULE'S ADAPTER. The service fills them from
   * `ActiveAllergyReader`, the one statement in the system that answers «¿a qué
   * es alérgica esta persona?» — see `PrescriptionRecordSource` below.
   */
  allergies: readonly { substanceText: string }[];
  /** PR-033, PR-034. */
  prescriber: {
    givenName: string;
    familyName: string;
    acessRegistration: string | null;
  };
}

/**
 * PR-020 to PR-040. What STORAGE answers for the document: everything above
 * except the allergies.
 *
 * ⚠️ THE ALLERGIES ARE THE ONE PIECE THIS MODULE DOES NOT READ ITSELF, and the
 * split is the point. `ActiveAllergyReader` in `shared/clinical` is the single
 * statement that resolves «la ficha y las que absorbió»; a second copy here
 * would be the second chance to forget `chartScope`, which is the defect
 * `patient-chart-scope.ts` opens with — with a prescription at the end of it.
 * The service asks the reader with `chartId` and hands the pair to
 * `composeDocument`.
 */
export interface PrescriptionRecordSource extends Omit<
  PrescriptionDocumentSource,
  'allergies'
> {
  /** PR-027, PR-062. The chart whose allergies the shared reader is asked for. */
  chartId: string;
}

/**
 * The port the prescription services depend on; `PrismaPrescriptionRepository`
 * implements it.
 */
export interface PrescriptionRepository {
  /** PR-001, PR-002. The attention within the caller's scope, or `null`. */
  findEncounterForPrescribing(
    query: EncounterPrescriptionsQuery,
  ): Promise<PrescribingEncounter | null>;

  /** PR-004, PR-034. The caller's clinical identity, or `null` if they have none. */
  findPrescriberByUser(userId: string): Promise<PrescriberIdentity | null>;

  /**
   * ⚠️ THERE IS NO `activeAllergiesOf` HERE, AND THE ABSENCE IS DELIBERATE.
   * «Las alergias activas de una ficha» is answered by ONE statement for the
   * whole system — `ActiveAllergyReader` in `shared/clinical` — because the
   * predicate is not the obvious one: it is the chart AND the charts it
   * absorbed (`chartScope`, PA-055), and a second copy of it is a second chance
   * to forget the link. The service reads through that port; this one only
   * answers what belongs to the prescription itself.
   */

  /**
   * PR-003, PR-007 to PR-009. Writes the prescription and its lines.
   *
   * ⚠️ PR-007 AND PR-008 ARE PART OF THIS METHOD AND CANNOT BE ANYTHING ELSE.
   * The adapter resolves each CNMB concept inside the same transaction —
   * which catalogue it is from and whether it was in force on the clinical date
   * of the attention — and copies the DCI from what it read. Exposing «¿es este
   * concepto recetable?» as a separate question would let a caller check first
   * and insert later, across a catalogue release.
   *
   * IT IS BORN `DRAFT` WITH NO `issued_at`, which `prescription_issued_coherence`
   * also guarantees.
   */
  create(prescription: NewPrescription): Promise<PrescriptionView>;

  /** PR-006. One prescription within the caller's scope, or `null`. */
  findById(query: PrescriptionQuery): Promise<PrescriptionView | null>;

  /** PR-006, PR-092. The prescriptions of one attention, newest first. */
  listOfEncounter(
    query: EncounterPrescriptionsQuery,
  ): Promise<PrescriptionView[]>;

  /**
   * PR-005, PR-021, PR-032, PR-034, PR-060. One issue, one transaction.
   *
   * THE POLICY TRAVELS AS A FUNCTION, exactly as `encounter.close` does and for
   * the same reason: the rules have to judge the rows AS THEY ARE INSIDE the
   * transaction, not a read from a moment earlier. The adapter reads, hands the
   * snapshot to `decide`, and applies whatever it returns; `decide` throws to
   * refuse and nothing is written.
   *
   * The race two people can still run — both read `DRAFT`, both decide — is
   * closed by a CONDITIONAL update on the status that was read: the loser
   * matches zero rows and is refused with the WINNER's status, never with a
   * stale acceptance.
   */
  issue(
    query: PrescriptionQuery,
    decide: (snapshot: IssueSnapshot) => IssuePlan,
  ): Promise<PrescriptionView>;

  /**
   * PR-010. Annuls the prescription. NOTHING IS DELETED.
   *
   * ⚠️ NO REASON IS TAKEN, AND THE ABSENCE IS THE REQUIREMENT rather than an
   * omission: there is no column for it (⚠️ **Falta esquema**, PR-010), and a
   * reason accepted here would be text the caller believes was recorded and
   * that nothing keeps. Art. 70 asks for that register; PR-073 says what it
   * needs.
   */
  cancel(
    query: PrescriptionQuery,
    decide: (status: PrescriptionStatus) => void,
  ): Promise<PrescriptionView>;

  /**
   * PR-011. Discards a DRAFT. NOTHING IS DELETED.
   *
   * ⚠️ IT IS A DIFFERENT ACT FROM `cancel`, NOT A SECOND NAME FOR IT. Annulling
   * bears on an EMITTED prescription — there is a paper in somebody's hand and
   * art. 70 describes the procedure — while discarding closes a draft that
   * never left the room. `prescription_discard_only_from_draft` (`discarded_at
   * IS NULL OR status = 'DISCARDED'`) and the reworked
   * `prescription_issued_coherence` (`status IN ('DRAFT','DISCARDED')` iff no
   * instant of issue) keep the two paths apart in the database.
   *
   * ⚠️ AND A REASON IS TAKEN HERE PRECISELY BECAUSE IT IS STORED, which is what
   * `cancel` cannot say. `discard_reason` exists as a column, so asking for it
   * is a promise the system keeps; on the annulment there is no column, so
   * asking would be text the caller believes was recorded and nothing keeps
   * (⚠️ **Falta esquema**, PR-010).
   *
   * The policy travels as a function for the same reason as `issue`: the state
   * has to be judged as it stands INSIDE the transaction, and the conditional
   * update closes the race two callers can still run.
   */
  discard(
    query: PrescriptionQuery,
    plan: DiscardPlan,
    decide: (status: PrescriptionStatus) => void,
  ): Promise<PrescriptionView>;

  /**
   * PR-020 to PR-040, PR-092. Everything the printed prescription carries.
   *
   * ONE STATEMENT AND NOT FIVE, because the answers have to describe the same
   * instant. The ALLERGIES are the exception and they are not here: they come
   * from `ActiveAllergyReader`, so that «la ficha y las que absorbió» is
   * written once for the whole system rather than once per module.
   */
  documentOf(
    query: PrescriptionQuery,
  ): Promise<PrescriptionRecordSource | null>;
}

/** Injection token. The application never names the adapter. */
export const PRESCRIPTION_REPOSITORY = Symbol('PrescriptionRepository');
