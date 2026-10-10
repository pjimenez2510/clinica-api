import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { ProcedureChargeSync } from '../../../shared/billing/procedure-charge-sync.port';

import {
  BILLING_ACCOUNT_REPOSITORY,
  BILLING_CATALOGUE_REPOSITORY,
  type BillingAccountRepository,
  type BillingCatalogueRepository,
} from '../domain/billing.repository';
import {
  CLINICAL_ACTS_REPOSITORY,
  type ClinicalActsRepository,
} from '../domain/clinical-acts.port';
import { Quantity } from '../domain/money';

import { EncounterCheckoutService } from './encounter-checkout.service';

/** BI-241. What the removed line says, so caja knows why it went. */
export const PROCEDURE_RETRACTED_REASON =
  'Procedimiento quitado de la atención';

/**
 * BI-240 to BI-242 (D-194.3). The charge a procedure raised follows the
 * procedure WHILE IT IS STILL A PROPOSAL: corrected, removed or proposed again
 * with it. A line caja confirmed or invoiced is caja's and is not touched —
 * the account says it no longer matches (BI-243, `proceduresOutdated`).
 *
 * A SERVICE OF ITS OWN (ADR-008 §2): it changes when the clinical side changes
 * what a procedure is, not when caja changes how it corrects a line.
 *
 * ⚠️ NEVER THROWS (`ProcedureChargeSync`). The clinical correction is already
 * committed; what cannot be followed here is logged and left for caja.
 */
@Injectable()
export class ProcedureChargeFollowService implements ProcedureChargeSync {
  constructor(
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    @Inject(CLINICAL_ACTS_REPOSITORY)
    private readonly acts: Pick<ClinicalActsRepository, 'findEncounterActs'>,
    private readonly checkout: EncounterCheckoutService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProcedureChargeFollowService.name);
  }

  async procedureChanged(command: {
    encounterId: string;
    siteId: string;
    changedById: string;
    procedureId: string;
    change: 'RECORDED' | 'EDITED' | 'RETRACTED' | 'RESTORED';
  }): Promise<void> {
    try {
      // BI-242. A new row — restored, or recorded after the discharge — has
      // no charge yet: with an open account it is proposed.
      if (command.change === 'RESTORED' || command.change === 'RECORDED') {
        await this.proposeRestored(command);
        return;
      }

      const charge = await this.accounts.findProcedureCharge(
        command.procedureId,
      );
      // BI-243. Only a proposal follows; confirmed and invoiced are caja's.
      if (charge === null || charge.status !== 'PLANNED') return;
      const account = await this.accounts.findAccount({
        accountId: charge.accountId,
        siteId: command.siteId,
      });
      if (account === null || account.status !== 'OPEN') return;

      const now = new Date();
      if (command.change === 'RETRACTED') {
        // BI-241. Removed with it; «Deshacer» in caja still works (BI-195).
        await this.accounts.voidCharge({
          chargeId: charge.id,
          voidedById: command.changedById,
          reason: PROCEDURE_RETRACTED_REASON,
          now,
          // A confirmation that lands between the read and the write wins.
          onlyIfStatus: 'PLANNED',
        });
        return;
      }

      // BI-240. The procedure as it is NOW.
      const acts = await this.acts.findEncounterActs({
        encounterId: command.encounterId,
        siteId: command.siteId,
      });
      const procedure = acts?.procedures.find(
        (each) => each.encounterProcedureId === command.procedureId,
      );
      if (!procedure) return;
      const services = await this.catalogue.findServicesByProcedureConcept([
        procedure.conceptId,
      ]);
      const service = services.get(procedure.conceptId);
      if (!service || !service.active) {
        this.logger.warn(
          { site_id: command.siteId, action: 'PROCEDURE_CHARGE_NOT_FOLLOWED' },
          'no active service for the corrected procedure',
        );
        return;
      }
      const quantity = Quantity.parse(String(procedure.quantity));
      const changesService =
        service.billableServiceId !== charge.billableServiceId;
      const changesQuantity =
        quantity.thousandths !== charge.quantity.thousandths;
      if (!changesService && !changesQuantity) return;

      await this.accounts.editCharge({
        chargeId: charge.id,
        changedById: command.changedById,
        now,
        onlyIfStatus: 'PLANNED',
        ...(changesService
          ? { billableServiceId: service.billableServiceId }
          : {}),
        ...(changesQuantity ? { quantity } : {}),
      });
    } catch (error) {
      this.logger.warn(
        {
          site_id: command.siteId,
          action: 'PROCEDURE_CHARGE_NOT_FOLLOWED',
          code: (error as { code?: string }).code,
        },
        'procedure charge left as it was',
      );
    }
  }

  /**
   * BI-242. The restored procedure — or one recorded after the discharge,
   * when caja may already hold the account (D-194.1) — is a new row: with an
   * open account it is
   * proposed as passing the visit to caja would, which is idempotent (BI-154)
   * and never re-proposes the line removed with the old row (BI-157).
   */
  private async proposeRestored(command: {
    encounterId: string;
    siteId: string;
    changedById: string;
  }): Promise<void> {
    const account = await this.accounts.findOpenAccountOfEncounter({
      encounterId: command.encounterId,
      siteId: command.siteId,
    });
    if (account === null) return;
    await this.checkout.sendToCashier({
      siteId: command.siteId,
      encounterId: command.encounterId,
      userId: command.changedById,
    });
  }
}
