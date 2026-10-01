import { admitsPrescribing } from '../domain/prescription';
import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ACTIVE_ALLERGY_READER,
  type ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import { exactAllergyMatches } from '../domain/allergy-check';
import { assertPrescriptionComplete } from '../domain/prescription-content';
import { composeDocument } from '../domain/prescription-document';
import {
  AllergyContraindicationError,
  PrescriberContactRequiredError,
  PrescriberNotLicensedError,
  PrescriberProfileRequiredError,
  PrescriptionEncounterNotFoundError,
  PrescriptionEncounterNotOpenError,
  PrescriptionDiagnosisRequiredError,
  PrescriptionEstablishmentIncompleteError,
  PrescriptionNotEditableError,
  PrescriptionNotFoundError,
} from '../domain/prescription.errors';
import {
  PRESCRIPTION_REPOSITORY,
  type NewPrescriptionItem,
  type PrescriptionRepository,
  type PrescriptionView,
  type SiteScopeFilter,
} from '../domain/prescription.repository';
import type { AllergyAlert } from '../domain/allergy-check';
import type { PrescriptionDocument } from '../domain/prescription-document';
import type { PrescriptionStatus } from '../domain/prescription';

/**
 * Its own resource type in the trail, and not `'encounter'`.
 *
 * «¿Quién abrió la atención?» and «¿quién imprimió la receta?» are two
 * questions, and the second is the one an investigation into a leak of
 * medication asks. A prescription IS a diagnosis said differently — metformin
 * says diabetes, efavirenz says HIV — so recording it under the attention's
 * type would bury exactly the disclosure that has to be reconstructible.
 */
const RESOURCE_TYPE = 'prescription';

/**
 * PR-004, PR-091. Who is asking.
 *
 * Declared here and not imported from `encounter`: no module imports another.
 * The shape is identical because the question is — and that is not duplication
 * worth removing, it is the price of the boundary.
 */
export interface Requester {
  /** The account id. Never a cedula (REQ-110). */
  userId: string;
  /** PR-091. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  ip?: string;
  userAgent?: string;
}

/** PR-001 to PR-009. What composing a prescription needs to be told. */
export interface ComposePrescriptionRequest {
  encounterId: string;
  /** PR-038, PR-039. Optional while composing; the issue demands them. */
  warningSigns?: string | null;
  nonPharmacologicalAdvice?: string | null;
  items: readonly NewPrescriptionItem[];
}

/**
 * PR-067. What comes back from composing: the draft, and what the chart says
 * about it.
 *
 * ⚠️ THE ALERTS TRAVEL WITH THE DRAFT AND BLOCK NOTHING. Interrupting here
 * would interrupt a doctor who is still typing, and PR-067 is explicit that
 * only the issue interrupts: an alert fired while somebody is composing is an
 * alert fired at a moment when there is nothing to prevent yet.
 */
export interface ComposedPrescription {
  prescription: PrescriptionView;
  allergyAlerts: readonly AllergyAlert[];
}

/**
 * The prescription: composing it, issuing it, discarding the draft, annulling
 * the emitted one and serving the document art. 5 obliges.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SERVICE, ONE AGGREGATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-008 §2 splits a service when it crosses one of three limits: more than
 * ~8 public use cases, two groups of methods with no dependencies in common, or
 * two reasons to change. This has six use cases, they all revolve around one
 * row and its lines, and they change for one reason — the norm of the receta.
 * Splitting the document out «because it reads and the rest writes» would be a
 * pattern by symmetry, which CLAUDE.md §9 refuses.
 *
 * ⚠️ WHAT THIS SERVICE NEVER DOES, AND EACH ABSENCE IS A REQUIREMENT:
 *
 *  - IT DOES NOT ISSUE A PRESCRIPTION FOR A CONTROLLED SUBSTANCE (PR-070).
 *    That document is a pre-printed pad the ACESS sells, under the doctor's
 *    nominal custody, whose original stays at the pharmacy. A PDF we produced
 *    would not be that prescription, and a clinic believing otherwise would
 *    find out during an inspection.
 *  - IT DOES NOT OFFER AN «EMITIR DE TODAS FORMAS» (PR-061). There is no column
 *    to keep the reason in, and a justification that is not stored is worse
 *    than none. The way past an allergy alert is to REFUTE the allergy, which
 *    leaves a row, an author and notes.
 *  - IT DOES NOT WARN ABOUT THERAPEUTIC CLASS OR CROSS-REACTIVITY (PR-065,
 *    PR-066). The first needs an ATC code nothing populates; the second is a
 *    commercial knowledge base, and simulating one produces warnings nobody can
 *    audit and everybody learns to close.
 *  - IT DOES NOT PRICE ANYTHING. What a medicine costs is `billing`'s, and this
 *    clinic dispenses nothing.
 */
@Injectable()
export class PrescriptionService {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly prescriptions: PrescriptionRepository,
    /**
     * PR-027, PR-062. THE ONE STATEMENT IN THE SYSTEM that answers «¿a qué es
     * alérgica esta persona?», shared with `encounter` through `shared/`.
     *
     * ⚠️ NOT A METHOD OF THIS MODULE'S PORT, and the reason is the predicate:
     * «las alergias activas de una ficha» means the chart AND the charts it
     * absorbed (`chartScope`, PA-055), because a merge re-points nothing
     * (D-031). A second copy of it here would be a second chance to forget the
     * link, and the half it would drop is the penicillin allergy of the
     * absorbed chart — `patient-chart-scope.ts` opens with that scene, and this
     * module is the one where it ends in a prescription.
     */
    @Inject(ACTIVE_ALLERGY_READER)
    private readonly allergies: ActiveAllergyReader,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrescriptionService.name);
  }

  /**
   * PR-001 to PR-009, PR-067. Composes a prescription as a draft.
   *
   * WHAT IS CHECKED HERE is the pair no constraint can see: that the attention
   * exists inside the caller's scope, and that it still admits new clinical
   * content. Everything else — the catalogue of each concept, its validity on
   * the clinical date, the frozen DCI — is arbitrated INSIDE the write, because
   * a catalogue release landing between a read and an insert is a real race and
   * the row that matters is the one that lands.
   */
  async compose(
    request: ComposePrescriptionRequest,
    requester: Requester,
  ): Promise<ComposedPrescription> {
    const prescriber = await this.requirePrescriber(requester.userId);
    const encounter = await this.requireOpenEncounter(
      request.encounterId,
      requester,
    );

    const prescription = await this.prescriptions.create({
      encounterId: encounter.id,
      prescriberId: prescriber.practitionerId,
      warningSigns: request.warningSigns ?? null,
      nonPharmacologicalAdvice: request.nonPharmacologicalAdvice ?? null,
      items: request.items,
      sites: requester.sites,
    });

    /**
     * PR-062, PR-067. The chart's allergies AND those of every chart it
     * absorbed, informative at this point. Read AFTER the write on purpose: the
     * draft exists either way, and the alert is about what was actually
     * written, with the DCI frozen from the concept the adapter resolved.
     */
    const allergies = await this.allergies.activeFor(encounter.patientId);
    const allergyAlerts = exactAllergyMatches(
      prescription.items.map((item) => ({
        line: item.line,
        conceptId: item.conceptId,
      })),
      allergies,
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: prescription.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    /**
     * PR-094. THE SITE AND THE FACT, AND NOT THE MEDICINE. A drug name in a log
     * line is the diagnosis of an identifiable person sitting in a file nobody
     * treats as clinical — and nothing is interpolated, because the logger
     * prunes by allowlist and a template string walks past it.
     */
    this.logger.info(
      { site_id: encounter.siteId, action: 'PRESCRIPTION_COMPOSED' },
      'prescription composed',
    );

    return { prescription, allergyAlerts };
  }

  /**
   * PR-005, PR-021, PR-032 to PR-034, PR-060, PR-093. Issues the prescription.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * EVERY REFUSAL IS DECIDED INSIDE THE TRANSACTION THAT WRITES
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The four things this judges can all change between a read and a write: an
   * allergy is recorded while the doctor types, an ACESS registration lapses at
   * midnight, a colleague issues the same draft, an administrator fixes the
   * site's parish. The policy travels as a closure and judges the snapshot the
   * adapter read in the same transaction — the shape `encounter.close` already
   * uses, and for the same reason.
   */
  async issue(
    prescriptionId: string,
    requester: Requester,
  ): Promise<PrescriptionView> {
    const now = new Date();
    // PR-034. The Ecuadorian calendar date and never `Date.now()` against a
    // timestamp: `acess_expires_on` is a `date`, and a prescription issued at
    // 20:00 read in UTC would be judged against tomorrow.
    const today = clinicalDateOf(now);
    const verificationCode = newVerificationCode();

    const issued = await this.prescriptions.issue(
      { prescriptionId, sites: requester.sites },
      (snapshot) => {
        // PR-005. A prescription that is not a draft is not issuable, and the
        // answer names the state it is in.
        assertDraft(snapshot.status);

        /**
         * PR-034. Art. 5.d.ii prints the ACESS registration ON the document, so
         * a prescriber without one has no prescription to issue. That is
         * STRICTER than EN-029, which deliberately lets a practitioner with no
         * registration on file sign the record — «whether they must have one»
         * is `staff`'s question, and this one is the norm's.
         */
        const { acessRegistration, acessExpiresOn } = snapshot.prescriber;
        if (acessRegistration === null || acessRegistration.trim() === '') {
          throw new PrescriberNotLicensedError();
        }
        if (
          acessExpiresOn !== null &&
          acessExpiresOn.toISOString().slice(0, 10) < today
        ) {
          throw new PrescriberNotLicensedError();
        }

        // PR-040. Art. 5.e.vi prints a number to call beside the warning
        // signs; without one there is no prescription to issue.
        const { contactPhone } = snapshot.prescriber;
        if (contactPhone === null || contactPhone.trim() === '') {
          throw new PrescriberContactRequiredError();
        }

        // PR-021. Art. 5.a.ii wants the city, and there is none to print.
        if (snapshot.cityOfPrescription === null) {
          throw new PrescriptionEstablishmentIncompleteError();
        }

        // PR-095. Art. 5.b.iii wants the CIE diagnosis, read from the
        // attention (PR-026): a receta with «Diagnóstico: —» is not issued.
        if (snapshot.diagnosisCount === 0) {
          throw new PrescriptionDiagnosisRequiredError();
        }

        // PR-032, PR-038, PR-039. The indications of art. 5.e and the whole
        // of art. 5.c on every line, in one answer.
        assertPrescriptionComplete(snapshot);

        /**
         * PR-060. The one alert that interrupts. It is checked LAST of the
         * refusals on purpose: a doctor whose form is half empty should be told
         * about the empty boxes, not about an allergy on a line they have not
         * finished writing.
         */
        const alerts = exactAllergyMatches(
          snapshot.items.map((item) => ({
            line: item.line,
            conceptId: item.conceptId,
          })),
          snapshot.allergies,
        );
        if (alerts.length > 0) {
          throw new AllergyContraindicationError(
            [...new Set(alerts.map((alert) => alert.line))].sort(
              (a, b) => a - b,
            ),
          );
        }

        return { issuedAt: now, verificationCode };
      },
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: issued.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // PR-094. The fact only: no patient, no medicine, nothing interpolated.
    this.logger.info({ action: 'PRESCRIPTION_ISSUED' }, 'prescription issued');

    return issued;
  }

  /**
   * PR-010, PR-093. Annuls an ISSUED prescription. NOTHING IS DELETED.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ANNULLING IS AN ACT ON AN EMITTED PRESCRIPTION, AND THE SCHEMA SAYS SO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `prescription_issued_coherence` — `(status IN ('DRAFT','DISCARDED')) =
   * (issued_at IS NULL)` — makes every state past the draft require an instant
   * of issue, so a prescription that was never issued cannot become `CANCELLED`
   * without inventing one. That is also the norm's own shape: art. 70 is about
   * the receta that WAS emitted and then lost, altered or must not be
   * dispensed. A wrong draft has no legal act to annul.
   *
   * ⚠️ THE WAY OUT OF A WRONG DRAFT IS `discard` (PR-011), NOT THIS. It is a
   * different act with a different state, and the database keeps them apart:
   * `prescription_discard_only_from_draft` refuses a discard on anything that
   * was issued.
   *
   * ⚠️ NO REASON IS ASKED FOR, AND THE ABSENCE IS THE REQUIREMENT. Art. 70 wants
   * a register of annulled and lost prescriptions and there is no column for it
   * (⚠️ **Falta esquema**, PR-010, PR-073). Asking for a reason and dropping it
   * would make everybody believe there is a record. What there IS, until the
   * columns exist, is the audit row this leaves.
   */
  async cancel(
    prescriptionId: string,
    requester: Requester,
  ): Promise<PrescriptionView> {
    const cancelled = await this.prescriptions.cancel(
      { prescriptionId, sites: requester.sites },
      // PR-010. Only an issued prescription is annullable — see above.
      (status) => assertIssued(status),
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: cancelled.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return cancelled;
  }

  /**
   * PR-011, PR-093. Discards a DRAFT. NOTHING IS DELETED.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * DISCARDING IS NOT ANNULLING, AND THE TWO ROUTES ARE TWO ACTS
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A draft typed by mistake never left the room: there is no paper in
   * anybody's hand, no pharmacy could have dispensed against it, and there is
   * no legal act to undo. Annulling (art. 70) is the opposite situation, and
   * collapsing the two would leave «esta receta se anuló» unable to say which
   * of them happened — the defect `ENTERED_IN_ERROR` exists to avoid in the
   * agenda.
   *
   * ⚠️ AND THE REASON IS OBLIGATORY HERE, WHICH IS EXACTLY WHAT `cancel` CANNOT
   * DO. `discard_reason` is a column, so what the caller writes is kept; on the
   * annulment there is none (⚠️ **Falta esquema**, PR-010), and a mandatory
   * reason that is dropped on the floor makes everybody believe there is a
   * record. Here the register is real, and the database refuses the row without
   * it: `prescription_discard_states_who_when_and_why` demands who, when and
   * why together.
   *
   * ⚠️ WHY IT STAYS IN THE CHART. Nothing is deleted, so the discarded draft is
   * still there — and that is the point rather than a limitation: the next
   * doctor can tell it apart from medication the patient is taking, which is
   * precisely what a `DRAFT` with no way out could not do.
   */
  async discard(
    prescriptionId: string,
    reason: string,
    requester: Requester,
  ): Promise<PrescriptionView> {
    const discarded = await this.prescriptions.discard(
      { prescriptionId, sites: requester.sites },
      {
        discardedAt: new Date(),
        // `discarded_by_id` targets `app_user`: the ACCOUNT that discarded it,
        // never a cedula and never the practitioner (REQ-110).
        discardedById: requester.userId,
        discardReason: reason,
      },
      // PR-011. Only a draft is discarded — an emitted prescription is annulled.
      (status) => assertDraft(status),
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: discarded.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // PR-094. The fact only: no patient, no medicine, no reason interpolated —
    // the reason is free text a doctor wrote and belongs in the row, not in a
    // log file nobody treats as clinical.
    this.logger.info(
      { action: 'PRESCRIPTION_DISCARDED' },
      'prescription draft discarded',
    );

    return discarded;
  }

  /**
   * PR-006, PR-092. The prescriptions of one attention, newest first.
   *
   * NOT AUDITED, unlike the document (PR-092), and the difference is what
   * travels: a listing carries identifiers, states and medicines; the document
   * carries the person, their age, their diagnosis and their allergies. A row
   * per listed prescription would bury the accountable act exactly as a row per
   * listed appointment would (EN-123).
   */
  async listOfEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<PrescriptionView[]> {
    // PR-001. Refuses an attention outside the caller's scope before serving
    // anything that hangs off it.
    await this.requireEncounter(encounterId, requester);
    return this.prescriptions.listOfEncounter({
      encounterId,
      sites: requester.sites,
    });
  }

  /**
   * PR-020 to PR-053, PR-092. The prescription as art. 5 obliges it, composed.
   *
   * ⚠️ AUDITED, AND IT IS THE ONLY READ OF THIS MODULE THAT IS. What comes back
   * is the name, the age, the diagnoses, the allergies and the medication of an
   * identifiable person: it is what is printed and handed over, and «¿quién
   * abrió esta receta?» has to be answerable.
   */
  async document(
    prescriptionId: string,
    requester: Requester,
  ): Promise<PrescriptionDocument> {
    const source = await this.prescriptions.documentOf({
      prescriptionId,
      sites: requester.sites,
    });
    if (!source) throw new PrescriptionNotFoundError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: source.prescription.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    /**
     * PR-027, PR-062. The allergies of the chart AND of the charts it absorbed,
     * from the shared reader — the same statement the doctor's screen reads, so
     * the printed prescription and the consultation cannot disagree about what
     * the person reacts to.
     */
    const allergies = await this.allergies.activeFor(source.chartId);

    /**
     * PR-050, PR-051. `AMBULATORY` because that is the only modality this
     * clinic has (supuesto 1) and the only one the schema could distinguish —
     * ⚠️ **Falta esquema**. Passed rather than defaulted inside the domain so
     * the day an emergency exists the call site is what changes, and it is
     * findable.
     */
    return composeDocument({ ...source, allergies }, { context: 'AMBULATORY' });
  }

  /** PR-004. The caller's clinical identity, or a refusal naming nothing. */
  private async requirePrescriber(userId: string) {
    const identity = await this.prescriptions.findPrescriberByUser(userId);
    if (!identity) throw new PrescriberProfileRequiredError();
    return identity;
  }

  /** PR-001. The attention, or the one refusal that covers both cases. */
  private async requireEncounter(encounterId: string, requester: Requester) {
    const encounter = await this.prescriptions.findEncounterForPrescribing({
      encounterId,
      sites: requester.sites,
    });
    if (!encounter) throw new PrescriptionEncounterNotFoundError();
    return encounter;
  }

  /**
   * PR-002. A prescription is written INSIDE a live attention.
   *
   * The five states that refuse it are the four terminal ones plus the
   * discharge: once the doctor signed, the act is over, and a medicine
   * prescribed afterwards would change what the consultation said with no trace
   * of a correction. The way to add one is a new attention (EN-006).
   */
  private async requireOpenEncounter(
    encounterId: string,
    requester: Requester,
  ) {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!admitsPrescribing(encounter.status)) {
      throw new PrescriptionEncounterNotOpenError(encounter.status);
    }
    return encounter;
  }
}

/**
 * PR-005, PR-011. Only a draft can be issued — and only a draft can be
 * discarded.
 *
 * ONE FUNCTION FOR BOTH BECAUSE IT IS ONE QUESTION: «¿sigue esto sin emitirse?»
 * The two acts differ in what they write, not in what they require, and the
 * refusal already names the state and what can be done from it.
 */
function assertDraft(status: PrescriptionStatus): void {
  if (status !== 'DRAFT') throw new PrescriptionNotEditableError(status);
}

/** PR-010. Only an issued prescription can be annulled (art. 70). */
function assertIssued(status: PrescriptionStatus): void {
  if (status !== 'ACTIVE') throw new PrescriptionNotEditableError(status);
}

/**
 * PR-020. The short code a pharmacy verifies the prescription with.
 *
 * ⚠️ IT IS NOT THE SEQUENTIAL NUMBER OF ART. 5.a.i (⚠️ **Falta esquema**). It
 * is deliberately RANDOM and not sequential, because it is handed to a third
 * party: a sequential code printed on a paper that leaves the building lets
 * whoever holds one enumerate the others. The sequence art. 5 asks for is an
 * internal control the ACESS reads to notice a gap, and the two must not be the
 * same number.
 *
 * Sixteen hexadecimal characters, which is exactly what
 * `prescription.verification_code` holds, and `@unique` is what arbitrates the
 * collision that will not happen.
 */
function newVerificationCode(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}
