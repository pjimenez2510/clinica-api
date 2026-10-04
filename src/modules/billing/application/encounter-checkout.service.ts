import { Inject, Injectable } from '@nestjs/common';

import {
  BILLING_ACCOUNT_REPOSITORY,
  BILLING_CATALOGUE_REPOSITORY,
  type AccountView,
  type BillingAccountRepository,
  type BillingCatalogueRepository,
} from '../domain/billing.repository';
import {
  ActAlreadyChargedError,
  BillingEncounterNotFoundError,
  PayerRequiredToOpenAccountError,
  PriceNotFoundError,
} from '../domain/billing.errors';
import {
  type AlreadyCharged,
  type ChargeMapping,
  type ProposedCharge,
  type SkippedAct,
  consultationKeyOf,
  proposeCharges,
} from '../domain/charge-proposal';
import { awaitingCheckoutSince } from '../domain/awaiting-checkout';
import {
  type AwaitingCheckout,
  CLINICAL_ACTS_REPOSITORY,
  type ClinicalActsRepository,
  type EncounterActs,
} from '../domain/clinical-acts.port';

import {
  type AccountStatement,
  PatientAccountService,
} from './patient-account.service';

/** What the cashier gets back from one press of «enviar a caja». */
export interface CheckoutResult {
  statement: AccountStatement;
  /** The charges this press raised — empty on the second press (BI-154). */
  raisedChargeIds: string[];
  /** BI-155. Acts that produced no line, each with its reason. */
  skipped: SkippedAct[];
}

/**
 * THE STEP FROM THE CONSULTATION TO THE CASHIER — BI-150 to BI-158.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT A GATE, AND NOTHING CLINICAL CALLS IT. Ley 77 art. 9.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is forbidden to demand payment or a payment document before receiving and
 * stabilising a patient, and art. 13 backs it with prison. So: closing the
 * visit does NOT wait for this to succeed, this does NOT require the visit to
 * be closed, and no method here answers a clinical question (BI-003, BI-073,
 * BI-120, BI-156). A doctor who presses «terminar» has finished; whether a
 * cashier ever presses «enviar a caja» changes nothing about the care that was
 * given or about the note that records it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ AND IT WRITES NOTHING CLINICAL, EVER. BI-004.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «What was done» and «what is charged» are two records. This service READS
 * the acts and writes charges beside them; it cannot delete a procedure, and
 * removing a charge later cannot delete one either. The port it reads through
 * has no write method at all, which is what stops that from being a matter of
 * discipline.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT PROPOSES. IT DOES NOT BILL. BI-152.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every derived charge is born `PLANNED`, and `issueInvoice` only ever takes
 * `BILLABLE` rows. So a visit that goes through here is NOT invoiceable until
 * a person has looked at each proposed line and confirmed it. A system that
 * billed what it deduced, with nobody looking, would overcharge the day the
 * catalogue is wrong — and the person overcharged is a patient with no way of
 * knowing.
 */
@Injectable()
export class EncounterCheckoutService {
  constructor(
    @Inject(CLINICAL_ACTS_REPOSITORY)
    private readonly acts: ClinicalActsRepository,
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    private readonly patientAccounts: PatientAccountService,
  ) {}

  /**
   * BI-150, BI-151, BI-154. Opens or recovers the account of a visit and
   * proposes what it did.
   *
   * IDEMPOTENT, AND ON BOTH HALVES:
   *
   *   · The account. `patient_account_one_open_per_encounter` admits one open
   *     account per visit, so «open or recover» has one answer even when two
   *     people press at the same second.
   *   · The charges. Each derived line names the act it came from, and three
   *     partial unique indexes refuse a second charge for the same act. The
   *     read of what is already charged is the comfortable half; the index is
   *     the guarantee.
   */
  async sendToCashier(command: {
    siteId: string;
    encounterId: string;
    /** Only needed the first time: an existing account already has its payer. */
    payerId?: string;
    userId: string;
  }): Promise<CheckoutResult> {
    const acts = await this.acts.findEncounterActs({
      encounterId: command.encounterId,
      siteId: command.siteId,
    });
    if (acts === null) throw new BillingEncounterNotFoundError();

    const account = await this.accountOf(acts, command.payerId);
    const mapping = await this.mappingFor(acts);
    const proposal = proposeCharges(
      acts,
      mapping,
      await this.chargedActs(acts),
    );

    const raisedChargeIds: string[] = [];
    const skipped = [...proposal.skipped];

    for (const line of proposal.proposed) {
      const outcome = await this.raise(account, line, command.userId);
      if (outcome.chargeId === null) skipped.push(outcome.skipped);
      else raisedChargeIds.push(outcome.chargeId);
    }

    return {
      statement: await this.patientAccounts.statement({
        accountId: account.id,
        siteId: command.siteId,
      }),
      raisedChargeIds,
      skipped,
    };
  }

  /**
   * BI-181 to BI-183. The site's ended visits caja still has to look at, in
   * the seven-day window counted in Ecuador from `now`.
   */
  async awaitingCheckout(query: {
    siteId: string;
    now: Date;
    /** D-119: the older ones too, when caja follows the notice. */
    includeOlder?: boolean;
  }): Promise<{ visits: AwaitingCheckout[]; olderCount: number }> {
    if (query.includeOlder) {
      const visits = await this.acts.listAwaitingCheckout({
        siteId: query.siteId,
        endedFrom: new Date(0),
      });
      return { visits, olderCount: 0 };
    }
    const since = awaitingCheckoutSince(query.now);
    const [visits, olderCount] = await Promise.all([
      this.acts.listAwaitingCheckout({
        siteId: query.siteId,
        endedFrom: since,
      }),
      // D-119: what fell out of the window is said, not dropped in silence.
      this.acts.countAwaitingBefore({ siteId: query.siteId, endedBefore: since }), // prettier-ignore
    ]);
    return { visits, olderCount };
  }

  /**
   * BI-150. The visit's open account, opening one if there is none.
   *
   * ⚠️ THE PATIENT COMES FROM THE VISIT AND NEVER FROM THE REQUEST. Taking it
   * from the body would let a caller open the account of one person's visit on
   * another person's chart — and an account is what an invoice is made out
   * from, so the mistake would end up on a tax document with somebody else's
   * cédula on it (BI-082).
   */
  private async accountOf(
    acts: EncounterActs,
    payerId: string | undefined,
  ): Promise<AccountView> {
    const existing = await this.accounts.findOpenAccountOfEncounter({
      encounterId: acts.encounterId,
      siteId: acts.siteId,
    });
    if (existing !== null) return existing;

    if (payerId === undefined) throw new PayerRequiredToOpenAccountError();

    return this.patientAccounts.openAccount({
      siteId: acts.siteId,
      patientId: acts.patientId,
      encounterId: acts.encounterId,
      payerId,
    });
  }

  /**
   * BI-151, BI-158. What the catalogue says each act costs — IN THREE QUERIES,
   * not one per line.
   *
   * The three are independent, so they go together: a visit with a
   * consultation, four procedures and six exams still costs one round trip's
   * worth of waiting at the counter.
   */
  private async mappingFor(acts: EncounterActs): Promise<ChargeMapping> {
    const consultationKey = consultationKeyOf(acts);

    const [consultation, byProcedureConcept, byExamCode] = await Promise.all([
      consultationKey === null
        ? Promise.resolve(null)
        : this.catalogue.findConsultationService(consultationKey),
      this.catalogue.findServicesByProcedureConcept(
        distinct(acts.procedures.map((procedure) => procedure.conceptId)),
      ),
      this.catalogue.findServicesByExamCode(
        distinct(acts.exams.map((exam) => exam.testCode)),
      ),
    ]);

    return { consultation, byProcedureConcept, byExamCode };
  }

  /** BI-154, BI-157. Sets, so the derivation asks in constant time per line. */
  private async chargedActs(acts: EncounterActs): Promise<AlreadyCharged> {
    const charged = await this.accounts.listChargedActs(acts.encounterId);

    return {
      consultation: charged.consultation,
      encounterProcedureIds: new Set(charged.encounterProcedureIds),
      serviceOrderItemIds: new Set(charged.serviceOrderItemIds),
    };
  }

  /**
   * BI-155. One line that cannot be written must not cost the clinic the rest.
   *
   * Two refusals are ANSWERS and not failures, and both are reported instead
   * of thrown:
   *
   *   · No price in force on the service date (BI-047). The act happened and
   *     nobody has priced it for that day; the cashier sees which one and
   *     types it. Aborting the whole proposal would leave a visit with six
   *     billable lines and nothing on the account.
   *   · The act is already charged. Under two simultaneous presses the index
   *     rejects the second write, which is the guarantee working — reporting
   *     it as a duplicate is the honest answer, not an incident.
   */
  private async raise(
    account: AccountView,
    line: ProposedCharge,
    userId: string,
  ): Promise<{ chargeId: string | null; skipped: SkippedAct }> {
    const asSkipped = (reason: SkippedAct['reason']): SkippedAct => ({
      origin: line.origin,
      encounterProcedureId: line.encounterProcedureId,
      serviceOrderItemId: line.serviceOrderItemId,
      reason,
    });

    try {
      const charge = await this.accounts.addCharge({
        accountId: account.id,
        billableServiceId: line.billableServiceId,
        encounterId: account.encounterId,
        serviceDate: line.serviceDate,
        quantity: line.quantity,
        createdById: userId,
        origin: line.origin,
        encounterProcedureId: line.encounterProcedureId,
        serviceOrderItemId: line.serviceOrderItemId,
        // BI-152. Derived lines are proposals until somebody confirms them.
        status: 'PLANNED',
      });
      return { chargeId: charge.id, skipped: asSkipped('ALREADY_CHARGED') };
    } catch (error) {
      if (error instanceof PriceNotFoundError) {
        return { chargeId: null, skipped: asSkipped('NO_PRICE_FOR_DATE') };
      }
      if (error instanceof ActAlreadyChargedError) {
        return { chargeId: null, skipped: asSkipped('ALREADY_CHARGED') };
      }
      throw error;
    }
  }
}

/**
 * Removes repeats before a batched lookup: two procedures of the same concept
 * ask the catalogue once.
 */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}
