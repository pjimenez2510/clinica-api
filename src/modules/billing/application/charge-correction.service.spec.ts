import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  AccountView,
  BillingAccountRepository,
  BillingCatalogueRepository,
  ChargeView,
} from '../domain/billing.repository';
import type { ChargeStatus } from '../domain/charge';
import { Money, Percentage, Quantity } from '../domain/money';
import { ChargeCorrectionService } from './charge-correction.service';

const SITE = 'site-1';
const ACCOUNT = 'account-1';
const SERVICE_DATE = parseClinicalDate('2026-05-11'); // fecha-fija: no reloj; solo viaja

const account = (overrides: Partial<AccountView> = {}) =>
  ({
    id: ACCOUNT,
    siteId: SITE,
    payerId: 'payer-particular',
    priceListId: 'list-particular',
    status: 'OPEN',
    ...overrides,
  }) as AccountView;

const charge = (
  status: ChargeStatus,
  overrides: Partial<ChargeView> = {},
): ChargeView => ({
  id: 'charge-1',
  accountId: ACCOUNT,
  billableServiceId: 'service-first-time',
  encounterId: 'encounter-1',
  serviceDate: SERVICE_DATE,
  quantity: Quantity.ONE,
  unitAmount: Money.parse('30.00'),
  resolvedPriceId: 'price-1',
  serviceDisplay: 'Consulta, primera vez',
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
  origin: 'CONSULTATION',
  encounterProcedureId: null,
  serviceOrderItemId: null,
  voidedAt: null,
  voidReason: null,
  invoiceId: null,
  correctsChargeItemId: null,
  creditNote: null,
  correctedNoteRejected: false,
  ...overrides,
});

function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    findAccount: vi.fn().mockResolvedValue(account()),
    findCharge: vi.fn().mockResolvedValue(charge('BILLABLE')),
    listCharges: vi.fn().mockResolvedValue([charge('BILLABLE')]),
    restoreCharge: vi.fn().mockResolvedValue(charge('BILLABLE')),
    markNotBillable: vi.fn().mockResolvedValue(charge('NOT_BILLABLE')),
    editCharge: vi.fn().mockResolvedValue(charge('BILLABLE')),
    previewRepricing: vi
      .fn()
      .mockResolvedValue([
        { chargeId: 'charge-1', unitAmount: Money.parse('22.00') },
      ]),
    findConsultationCharge: vi.fn().mockResolvedValue(charge('PLANNED')),
    findBillableService: vi.fn().mockResolvedValue({ active: true }),
    findPayer: vi.fn().mockResolvedValue({ id: 'payer-iess', active: true }),
    findPriceListOfPayer: vi.fn().mockResolvedValue({ id: 'list-iess' }),
    findConsultationService: vi.fn().mockResolvedValue({
      billableServiceId: 'service-subsequent',
      active: true,
    }),
    findEncounterActs: vi.fn().mockResolvedValue({
      encounterId: 'encounter-1',
      siteId: SITE,
      serviceTypeId: 'service-type-1',
      visitSequence: 'SUBSEQUENT',
    }),
    ...overrides,
  };
  const logger = { setContext: vi.fn(), warn: vi.fn() };

  return {
    service: new ChargeCorrectionService(
      mocks as unknown as BillingAccountRepository,
      mocks as unknown as BillingCatalogueRepository,
      mocks,
      logger as unknown as PinoLogger,
    ),
    mocks,
    logger,
  };
}

const command = {
  accountId: ACCOUNT,
  siteId: SITE,
  chargeId: 'charge-1',
  changedById: 'cashier-1',
};

describe('BI-195, BI-196 deshacer y «No se cobra»', () => {
  it('BI-195 deshace con quién y el instante de la aplicación', async () => {
    const { service, mocks } = build();

    await service.restoreCharge(command);

    expect(mocks.restoreCharge).toHaveBeenCalledWith({
      chargeId: 'charge-1',
      changedById: 'cashier-1',
      now: expect.any(Date),
    });
  });

  it('BI-195 no deshace en una cuenta cerrada', async () => {
    const { service } = build({
      findAccount: vi.fn().mockResolvedValue(account({ status: 'SETTLED' })),
    });

    await expect(service.restoreCharge(command)).rejects.toMatchObject({
      code: 'ACCOUNT_CLOSED',
    });
  });

  it('BI-196 marca «No se cobra» el cargo de $0', async () => {
    const { service, mocks } = build({
      findCharge: vi
        .fn()
        .mockResolvedValue(charge('PLANNED', { unitAmount: Money.ZERO })),
    });

    await service.markNotBillable(command);

    expect(mocks.markNotBillable).toHaveBeenCalled();
  });

  it('BI-196 rechaza «No se cobra» en un cargo con importe', async () => {
    const { service, mocks } = build();

    await expect(service.markNotBillable(command)).rejects.toMatchObject({
      code: 'CHARGE_HAS_AMOUNT',
    });
    expect(mocks.markNotBillable).not.toHaveBeenCalled();
  });
});

describe('BI-197 editar el cargo', () => {
  it('BI-197 rechaza cambiar a una prestación inactiva', async () => {
    const { service, mocks } = build({
      findBillableService: vi.fn().mockResolvedValue({ active: false }),
    });

    await expect(
      service.editCharge({ ...command, billableServiceId: 'service-2' }),
    ).rejects.toMatchObject({ code: 'BILLABLE_SERVICE_INACTIVE' });
    expect(mocks.editCharge).not.toHaveBeenCalled();
  });

  it('BI-197 pasa la cantidad al adaptador sin consultar el catálogo', async () => {
    const { service, mocks } = build();
    const quantity = Quantity.parse('2');

    await service.editCharge({ ...command, quantity });

    expect(mocks.findBillableService).not.toHaveBeenCalled();
    expect(mocks.editCharge).toHaveBeenCalledWith(
      expect.objectContaining({ chargeId: 'charge-1', quantity }),
    );
  });
});

describe('BI-198 la vista previa del cambio de pagador', () => {
  it('BI-198 da el total actual y el que quedaría', async () => {
    const { service } = build();

    const preview = await service.previewPayerChange({
      accountId: ACCOUNT,
      siteId: SITE,
      payerId: 'payer-iess',
    });

    expect(preview.currentTotal.toString()).toBe('30.00');
    expect(preview.newTotal?.toString()).toBe('22.00');
  });

  it('BI-198 no da total nuevo si a alguna línea le falta precio', async () => {
    const { service } = build({
      previewRepricing: vi
        .fn()
        .mockResolvedValue([{ chargeId: 'charge-1', unitAmount: null }]),
    });

    const preview = await service.previewPayerChange({
      accountId: ACCOUNT,
      siteId: SITE,
      payerId: 'payer-iess',
    });

    expect(preview.newTotal).toBeNull();
  });
});

describe('BI-203 la consulta se re-tarifa al corregir primera vez o subsecuente', () => {
  const reprice = {
    encounterId: 'encounter-1',
    siteId: SITE,
    changedById: 'doctor-1',
  };

  it('BI-203 apunta el cargo sin facturar a la consulta que corresponde ahora', async () => {
    const { service, mocks } = build();

    await service.repriceConsultation(reprice);

    // BI-158 (D-179.3). By the type of the appointment, not by the sequence.
    expect(mocks.findConsultationService).toHaveBeenCalledWith(
      'service-type-1',
    );
    expect(mocks.editCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeId: 'charge-1',
        changedById: 'doctor-1',
        billableServiceId: 'service-subsequent',
      }),
    );
  });

  it('BI-203 no toca un cargo facturado', async () => {
    const { service, mocks } = build({
      findConsultationCharge: vi.fn().mockResolvedValue(charge('BILLED')),
    });

    await service.repriceConsultation(reprice);

    expect(mocks.editCharge).not.toHaveBeenCalled();
  });

  it('BI-203 no toca el cargo de una cuenta cerrada', async () => {
    const { service, mocks } = build({
      findAccount: vi.fn().mockResolvedValue(account({ status: 'SETTLED' })),
    });

    await service.repriceConsultation(reprice);

    expect(mocks.editCharge).not.toHaveBeenCalled();
  });

  it('BI-203 sin consulta en el catálogo deja el cargo y lo registra, sin fallar', async () => {
    const { service, mocks, logger } = build({
      findConsultationService: vi.fn().mockResolvedValue(null),
    });

    await expect(service.repriceConsultation(reprice)).resolves.toBeUndefined();

    expect(mocks.editCharge).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('BI-203 sin precio para la consulta nueva no falla hacia la atención', async () => {
    const { service, logger } = build({
      editCharge: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { code: 'PRICE_NOT_FOUND' })), // prettier-ignore
    });

    await expect(service.repriceConsultation(reprice)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PRICE_NOT_FOUND' }),
      expect.any(String),
    );
  });
});
