/**
 * What the attention needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this and the Prisma adapter implements
 * it. `dependency-cruiser` enforces the direction.
 *
 * WHY THERE ARE QUESTIONS ABOUT PATIENTS, PRACTITIONERS AND APPOINTMENTS HERE.
 * EN-001 has to refuse a chart that does not exist or was absorbed by a merge,
 * EN-005 has to refuse an appointment that was annulled, and EN-029 has to
 * refuse a signature from a practitioner whose ACESS registration lapsed. NONE
 * of that is done by importing `patients`, `agenda` or `staff`: no module
 * imports another, and the day that rule is bent «for just one lookup» the
 * modules stop being modules. This module declares the fields it needs and its
 * own adapter answers them — the route `agenda` already took for AG-027 and
 * AG-090.
 *
 * WHAT IS DELIBERATELY ABSENT: anything that asks whether an appointment is
 * still attendable BEFORE creating the attention. EN-005 demands the check
 * happen «dentro de la misma transacción y con la fila de agenda bloqueada»,
 * so it is part of `open` and never a question a caller can ask first and act
 * on later — which is precisely the race AG-045 was left open by.
 */

import type {
  CareModality,
  CareSetting,
  DischargeCondition,
  DiscontinuedOrigin,
  EncounterStatus,
  VisitSequence,
} from './encounter';
import type { StateChange } from './encounter-state';
import type { ClosurePlan } from './encounter-closure';
import type { VitalSigns } from './vital-signs';
import type { TriggeringFact } from './patient-flow';

/**
 * An attention as this module serves it.
 *
 * ⚠️ NO CLINICAL CONTENT AND NO PATIENT NAME. The identifiers, the instants,
 * the state and the frozen age — nothing that says what the person has
 * (EN-124, SC-016). A listing is read by everybody holding `record:read` over
 * the site and leaves no row in `access_audit` (EN-123), so a value that is
 * never loaded cannot leak into a response, a log or a support screenshot.
 */
export interface EncounterView {
  id: string;
  siteId: string;
  practitionerId: string;
  patientId: string;
  /** `null` on a walk-in: EN-003 refuses to invent a cita to make one fit. */
  agendaEntryId: string | null;
  startedAt: Date;
  /** EN-010, EN-126. Present exactly on the four states that ended the act. */
  endedAt: Date | null;
  status: EncounterStatus;
  careModality: CareModality;
  careSetting: CareSetting;
  visitSequence: VisitSequence;
  /**
   * EN-008. The age the patient HAD that day, written by
   * `trg_encounter_freeze_age` and never recomputed.
   */
  ageYears: number | null;
  ageMonths: number | null;
  ageDays: number | null;
  dischargeCondition: DischargeCondition | null;
  /** EN-131, EN-147. Who settled the account, and why it was not the author. */
  closedById: string | null;
  closedAt: Date | null;
  closedBySubstituteReason: string | null;
  /** EN-166. Why and when it was annulled; `null` unless `ENTERED_IN_ERROR`. */
  annulment: { reason: string; at: Date } | null;
  /** EN-167. Why, from where and when it was interrupted; `null` unless `DISCONTINUED`. */
  interruption: { reason: string; origin: DiscontinuedOrigin; at: Date } | null;
}

/**
 * EN-001. The two facts this module needs about a chart, and no more.
 *
 * NOT THE NAME, NOT THE DOCUMENT, NOT THE BIRTH DATE. The age is frozen by a
 * trigger that reads `patient` itself (EN-008), so nothing here needs to carry
 * a birth date across the boundary — and a field that is never loaded is a
 * field that cannot end up in a log.
 */
export interface PatientChartStatus {
  id: string;
  /** Non-null when a merge absorbed this chart: it no longer opens (PA-045). */
  mergedIntoId: string | null;
}

/** EN-011, EN-029. Who the caller is, clinically, and whether they may sign. */
export interface PractitionerIdentity {
  practitionerId: string;
  /**
   * EN-029, REQ-041. `null` when the practitioner has no registration on file.
   *
   * A CALENDAR DATE AND NOT AN INSTANT (`acess_expires_on` is a `date`): a
   * registration lapses on a day, not at a moment, and turning it into an
   * instant is where the time-zone bugs come from.
   */
  acessExpiresOn: Date | null;
}

/** EN-003, EN-127. Everything an attention is born with. Nothing is optional by accident. */
export interface NewEncounter {
  siteId: string;
  practitionerId: string;
  patientId: string;
  /**
   * EN-003. Absent on a walk-in, and that is half the consultation: forcing a
   * cita to exist produces fictitious appointments with falsified hours, which
   * is what destroys the inasistencia metric of AG-080.
   */
  agendaEntryId?: string;
  /**
   * EN-034. A DATUM and not `now()`. Art. 5 asks the history to be filled «de
   * forma simultánea a la atención, CUANDO SEA POSIBLE», and that clause is a
   * permission: the home visit and the network outage exist. What the
   * requirement forbids is the opposite — recording a 10:00 consultation at
   * 20:00 and having it stored as 20:00, which moves the neonate's frozen age
   * by a whole day.
   */
  startedAt: Date;
  careModality: CareModality;
  careSetting: CareSetting;
  visitSequence: VisitSequence;
}

/** EN-015, EN-162. One page of a chart's attentions, in chronological order. */
export interface ChartHistoryQuery {
  /**
   * The chart asked about. The adapter resolves it AND the charts it absorbed
   * (PA-055): a read by the bare id makes half a history disappear the day
   * admissions repairs a duplicate, and `patient-chart-scope.spec.ts` fails
   * the build over exactly that.
   */
  patientId: string;
  /** EN-121. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  /**
   * EN-208. Only the attentions born of this appointment, in any state but
   * annulled in error — the closed ones included, so they can be READ.
   */
  agendaEntryId?: string;
  /**
   * EN-162. Which page, 1-based, and how many rows it holds.
   *
   * ⚠️ THE WINDOW IS NOT OPTIONAL AND HAS NO DEFAULT HERE. A port with an
   * optional page is a port that answers «todas» to whoever forgets it, which
   * is the whole of the defect: the chronic patient of ten years is the case
   * that breaks it, and the caller who forgets is never the one who tests it.
   * The DTO is where the default lives, because that is where a caller who
   * said nothing can be answered with something.
   */
  page: number;
  pageSize: number;
}

/**
 * EN-162. One page of a chart's history, with how many there are in all.
 *
 * ⚠️ THE `total` IS THE HALF THAT MAKES A PAGE READABLE. Without it a screen
 * showing twenty cannot tell «son veinte» from «son las veinte primeras de
 * ciento treinta y siete», and the only way to find out is to ask for
 * everything — which is what the pagination exists to stop. Same shape as the
 * patient register (PA-006) and the catalogue tree; a third form of the same
 * answer is a third thing every client has to learn.
 */
export interface EncounterPage {
  items: readonly EncounterView[];
  total: number;
}

/**
 * The caller's site scope, as `Principal.sitesFor` states it: every site, or
 * an explicit list. Declared here so the port does not import authorisation
 * machinery — the DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];

/** EN-146. The attentions one practitioner has not closed. */
export interface OpenEncountersQuery {
  /** Absent means «everyone in my scope», which is what a supervisor reads. */
  practitionerId?: string;
  sites: SiteScopeFilter;
}

/** EN-121. One attention, by id, within the caller's scope. */
export interface EncounterQuery {
  encounterId: string;
  sites: SiteScopeFilter;
}

/**
 * EN-060, EN-067. The vital signs of one attention, as they come back.
 *
 * THE BMI IS HERE AND IS NEVER AN INPUT (EN-061): `trg_encounter_vitals_bmi`
 * writes it, and this is the field that carries it back so the screen can show
 * the number that is actually stored rather than one it computed itself.
 */
export interface VitalSignsView extends VitalSigns {
  encounterId: string;
  /** `null` while either the weight or the height is missing. */
  bmi: number | null;
  measuredAt: Date;
  /**
   * EN-143. Who took the current reading, IN the datum (D-048). `null` only
   * for takings older than the column, which nobody can give an author to.
   */
  recordedBy: { id: string; name: string } | null;
  /** EN-143. Who corrected the taking last, and when; `null` if nobody did. */
  correctedBy: { id: string; name: string } | null;
  correctedAt: Date | null;
}

/**
 * EN-135 to EN-139. What the board is told, and by which documented fact.
 *
 * ⚠️ IT WRITES A COLUMN OF `agenda_entry`, WHICH IS ANOTHER MODULE'S TABLE,
 * AND THAT IS WHY IT IS A PORT. EN-134 puts the subject status there on
 * purpose — the patient is in the waiting room before any attention exists —
 * so this module owns the VERBS and `agenda` owns the ROW. The boundary the
 * architecture protects is the import graph, and nothing here imports
 * `modules/agenda`: the adapter of THIS module writes the column, inside the
 * same transaction as the fact that justifies it.
 *
 * WHY IN THE SAME TRANSACTION: a board updated after the fact commits is a
 * board that can disagree with the record when the second statement fails, and
 * D-A-008's whole argument is that a board which can be wrong stops being
 * believed.
 */
export interface SubjectStatusStamp {
  encounterId: string;
  fact: TriggeringFact;
  now: Date;
}

/** The attention's port, described at the top of this file. */
export interface EncounterRepository {
  /**
   * EN-001. The chart's merge state, or `null` when no such chart exists.
   *
   * BOTH ANSWER THE SAME REFUSAL (`PATIENT_CHART_NOT_OPEN`) and the port still
   * distinguishes them, because the port describes storage and the policy is
   * the service's: a port that returned a boolean would have decided, here,
   * that «no existe» and «la absorbieron» are the same thing — and they are
   * only the same thing on THIS route.
   */
  findPatientChart(patientId: string): Promise<PatientChartStatus | null>;

  /** EN-011, EN-029. The caller's clinical identity, or `null` if they have none. */
  findPractitionerByUser(userId: string): Promise<PractitionerIdentity | null>;

  /**
   * EN-003 to EN-006, EN-017, EN-127. Writes the attention.
   *
   * ⚠️ EN-005 IS PART OF THIS METHOD AND CANNOT BE ANYTHING ELSE. When the
   * attention names a cita, the adapter LOCKS that agenda row inside the same
   * transaction and refuses an annulled or absent one. Exposing «¿se puede
   * atender esta cita?» as a separate question would let a caller check first
   * and insert afterwards, which is the race that leaves a cancelled
   * appointment holding a registered attention — two facts, both true, that
   * contradict each other.
   *
   * ⚠️ AND IT DOES NOT CHECK FOR A SECOND ATTENTION THAT DAY (EN-006). The
   * ministry demands «tantas consultas como atenciones médicas recibidas», so
   * there is no uniqueness by patient and date to enforce and no method here
   * that could be mistaken for one. The real duplicate — two rows for one
   * consultation — is prevented by `encounter_one_live_per_agenda_entry`: one
   * LIVE attention per appointment (EN-168); an annulled one stays as trail.
   */
  open(encounter: NewEncounter): Promise<EncounterView>;

  /** EN-121, EN-122. One attention within the caller's scope, or `null`. */
  findById(query: EncounterQuery): Promise<EncounterView | null>;

  /**
   * EN-015. One chart's attentions — and its absorbed charts' — newest first.
   *
   * CHRONOLOGICAL IS ART. 5 OF THE A.M. 00115-2021, and «incluidas las
   * absorbidas» is D-038 applied here: a merge re-points nothing (D-031), so
   * the attentions of the absorbed chart keep their `patient_id` and are only
   * reachable through the link.
   *
   * EN-162. ONE PAGE AND THE TOTAL, never the whole history. The count is over
   * the SAME predicate as the page — chart scope and site scope included — or
   * the screen would offer pages of attentions it is not allowed to read.
   */
  historyOf(query: ChartHistoryQuery): Promise<EncounterPage>;

  /**
   * EN-146. What nobody has closed, oldest first.
   *
   * ⚠️ THIS IS WHAT REPLACES THE AUTOMATIC CLOSURE, and there is no other half
   * (EN-145, D-A-010). It is served by the partial index
   * `encounter_still_open_by_practitioner`, partial so it stays small BY
   * CONSTRUCTION: rows leave the index when they close, exactly like
   * `encounter_pending_report`.
   *
   * OLDEST FIRST because the list is read to find what is being forgotten, and
   * the thing being forgotten is the oldest one.
   */
  listStillOpen(query: OpenEncountersQuery): Promise<EncounterView[]>;

  /**
   * EN-009, EN-131, EN-132, EN-144, EN-147. One closure, one transaction.
   *
   * THE POLICY TRAVELS AS A FUNCTION, exactly as `agenda.transition` does and
   * for the same reason: the rules have to judge the row AS IT IS INSIDE the
   * transaction, not a read from a moment earlier. The adapter reads, hands
   * the row to `decide`, and applies whatever it returns in the same
   * transaction; `decide` throws to refuse and nothing is written.
   *
   * The race two people can still run — both read `DISCHARGED`, both decide —
   * is closed by a CONDITIONAL update on the status that was read: the loser
   * matches zero rows and is refused with the WINNER's status, never with a
   * stale acceptance.
   */
  close(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => ClosurePlan,
  ): Promise<EncounterView>;

  /**
   * EN-130, EN-138. Moves the attention to `DISCHARGED` because a note was
   * signed, in the SAME transaction as the signature.
   *
   * ⚠️ IT IS ON THE NOTE'S PORT AND NOT ON THIS ONE — see
   * `clinical-note.repository.ts`. Stated here so the absence is a decision
   * that was written down: a discharge that could commit without its signature
   * would be an attention declared clinically finished with nothing signed,
   * which is the record art. 5 calls «estadística y no historia».
   */

  /**
   * EN-060 to EN-063, EN-067, EN-136. Writes the ONE set of vital signs an
   * attention has, creating it or replacing it.
   *
   * AN UPSERT AND NOT AN INSERT, because `encounter_vitals.encounter_id` is
   * the primary key: there is at most one taking per attention (EN-067), the
   * route is a `PUT`, and asking twice must not create a second row. The
   * consequence is stated in the requirement and worth repeating: a second
   * taking OVERWRITES the first and there is no history of the two. For
   * outpatient care that is right; the day the clinic monitors blood pressure
   * for an hour it needs another table.
   *
   * EN-143. `authorId` is the session's account: the AUTHOR of a first
   * taking, the CORRECTOR of a later one. A correction never replaces who
   * took the reading, nor when (unless the caller names a new instant).
   */
  saveVitals(
    query: EncounterQuery,
    vitals: VitalSigns,
    authorId: string,
  ): Promise<VitalSignsView>;

  /** EN-068. The vital signs of one attention, or `null` when none were taken. */
  findVitals(query: EncounterQuery): Promise<VitalSignsView | null>;

  /**
   * EN-135. Records that the vital-signs form was OPENED — nothing clinical is
   * written, only the board moves.
   *
   * A METHOD OF ITS OWN AND NOT A FLAG ON `saveVitals`: opening the form and
   * saving it are two facts that prove two different things (EN-135, EN-136),
   * and half an hour can pass between them. That gap is precisely what the
   * board is for — it is how «la están preparando» is told apart from «lista
   * para pasar».
   */
  stampSubjectStatus(stamp: SubjectStatusStamp): Promise<void>;
}

/**
 * What a state change writes, shared with the pure machine.
 *
 * Re-exported from the port so an adapter or a double does not have to know
 * which domain file the machine happens to live in — the same courtesy
 * `agenda.repository.ts` extends for `AgendaEntryStatus`.
 */
export type { StateChange };

/** Injection token. The application never names the adapter. */
export const ENCOUNTER_REPOSITORY = Symbol('EncounterRepository');
