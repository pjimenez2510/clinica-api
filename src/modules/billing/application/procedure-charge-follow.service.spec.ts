import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  BillingAccountRepository,
  BillingCatalogueRepository,
  ChargeView,
} from '../domain/billing.repository';
import type { ChargeStatus } from '../domain/charge';
import { Money, Percentage, Quantity } from '../domain/money';
import type { EncounterCheckoutService } from './encounter-checkout.service';
import {
  PROCEDURE_RETRACTED_REASON,
  ProcedureChargeFollowService,
} from './procedure-charge-follow.service';

const SITE = 'site-1';
const SERVICE_DATE = parseClinicalDate('2026-05-11'); // fecha-fija: no reloj; solo viaja

const charge = (status: ChargeStatus): ChargeView => ({
  id: 'charge-1',
  accountId: 'account-1',
  billableServiceId: 'service-suture',
  encounterId: 'encounter-1',
  serviceDate: SERVICE_DATE,
  quantity: Quantity.parse('2'),
  unitAmount: Money.parse('15.00'),
  resolvedPriceId: 'price-1',
  serviceDisplay: 'Sutura',
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  discountAmount: Money.ZERO,
  discountReason: null,
  discountAuthorisedById: null,
  discountAuthorisedAt: null,
  discountAuthorisedByName: null,
  discountAppliedById: null,
  discountAppliedAt: null,
  discountAppliedByName: null,
  status,
  createdById: 'user-1',
  origin: 'PROCEDURE',
  encounterProcedureId: 'procedure-1',
  serviceOrderItemId: null,
  voidedAt: null,
  voidReason: null,
  invoiceId: null,
  correctsChargeItemId: null,
});

function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    findProcedureCharge: vi.fn().mockResolvedValue(charge('PLANNED')),
    findAccount: vi.fn().mockResolvedValue({ id: 'account-1', status: 'OPEN' }), // prettier-ignore
    findOpenAccountOfEncounter: vi.fn().mockResolvedValue(null),
    voidCharge: vi.fn().mockResolvedValue(charge('CANCELLED')),
    editCharge: vi.fn().mockResolvedValue(charge('PLANNED')),
    findServicesByProcedureConcept: vi.fn().mockResolvedValue(
      new Map([['concept-cure', { billableServiceId: 'service-cure', active: true }]]), // prettier-ignore
    ),
    findEncounterActs: vi.fn().mockResolvedValue({
      procedures: [{ encounterProcedureId: 'procedure-1', conceptId: 'concept-cure', quantity: 1 }], // prettier-ignore
    }),
    sendToCashier: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const logger = { setContext: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const service = new ProcedureChargeFollowService(
    mocks as unknown as BillingAccountRepository,
    mocks as unknown as BillingCatalogueRepository,
    { findEncounterActs: mocks.findEncounterActs },
    {
      sendToCashier: mocks.sendToCashier,
    } as unknown as EncounterCheckoutService,
    logger as unknown as PinoLogger,
  );
  return { service, mocks, logger };
}

const command = (change: 'RECORDED' | 'EDITED' | 'RETRACTED' | 'RESTORED') => ({
  encounterId: 'encounter-1',
  siteId: SITE,
  changedById: 'doctor-1',
  procedureId: 'procedure-1',
  change,
});

describe('BI-240 a BI-242 el cargo propuesto sigue al procedimiento', () => {
  it('BI-240 corrige la prestación y la cantidad del cargo propuesto con el sello de quien corrigió', async () => {
    const { service, mocks } = build();

    await service.procedureChanged(command('EDITED'));

    expect(mocks.editCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeId: 'charge-1',
        changedById: 'doctor-1',
        billableServiceId: 'service-cure',
        quantity: Quantity.parse('1'),
      }),
    );
  });

  it('BI-240 sin prestación activa para el concepto nuevo deja el cargo como estaba', async () => {
    const { service, mocks, logger } = build({
      findServicesByProcedureConcept: vi.fn().mockResolvedValue(new Map()),
    });

    await service.procedureChanged(command('EDITED'));

    expect(mocks.editCharge).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('BI-241 quita el cargo propuesto con el procedimiento, con su motivo', async () => {
    const { service, mocks } = build();

    await service.procedureChanged(command('RETRACTED'));

    expect(mocks.voidCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeId: 'charge-1',
        voidedById: 'doctor-1',
        reason: PROCEDURE_RETRACTED_REASON,
      }),
    );
  });

  it('BI-243 no toca el cargo confirmado ni el facturado, ni el de una cuenta cerrada', async () => {
    for (const status of ['BILLABLE', 'BILLED'] as const) {
      const { service, mocks } = build({
        findProcedureCharge: vi.fn().mockResolvedValue(charge(status)),
      });
      await service.procedureChanged(command('RETRACTED'));
      await service.procedureChanged(command('EDITED'));
      expect(mocks.voidCharge).not.toHaveBeenCalled();
      expect(mocks.editCharge).not.toHaveBeenCalled();
    }
    const { service, mocks } = build({
      findAccount: vi.fn().mockResolvedValue({ id: 'account-1', status: 'SETTLED' }), // prettier-ignore
    });
    await service.procedureChanged(command('RETRACTED'));
    expect(mocks.voidCharge).not.toHaveBeenCalled();
  });

  it('BI-242 propone el restaurado sólo con una cuenta abierta', async () => {
    const closed = build();
    await closed.service.procedureChanged(command('RESTORED'));
    expect(closed.mocks.sendToCashier).not.toHaveBeenCalled();

    const open = build({
      findOpenAccountOfEncounter: vi
        .fn()
        .mockResolvedValue({ id: 'account-1' }),
    });
    await open.service.procedureChanged(command('RESTORED'));
    expect(open.mocks.sendToCashier).toHaveBeenCalledWith({
      siteId: SITE,
      encounterId: 'encounter-1',
      userId: 'doctor-1',
    });
  });

  it('BI-242 propone el registrado tras el alta sólo con una cuenta abierta (D-194.1)', async () => {
    const closed = build();
    await closed.service.procedureChanged(command('RECORDED'));
    expect(closed.mocks.sendToCashier).not.toHaveBeenCalled();
    expect(closed.mocks.findProcedureCharge).not.toHaveBeenCalled();

    const open = build({
      findOpenAccountOfEncounter: vi
        .fn()
        .mockResolvedValue({ id: 'account-1' }),
    });
    await open.service.procedureChanged(command('RECORDED'));
    expect(open.mocks.sendToCashier).toHaveBeenCalledWith({
      siteId: SITE,
      encounterId: 'encounter-1',
      userId: 'doctor-1',
    });
  });

  it('EN-248 nunca falla hacia la atención', async () => {
    const { service, logger } = build({
      findProcedureCharge: vi.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(
      service.procedureChanged(command('EDITED')),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
