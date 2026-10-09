import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  BillingAccountRepository,
  ChargeView,
  DiscountWrite,
} from '../domain/billing.repository';
import { Money, Percentage, Quantity } from '../domain/money';
import { ChargeDiscountService } from './charge-discount.service';

const SITE = 'site-1';
const CAJA = 'user-caja';
const ADMIN = 'user-admin';

const line = (overrides: Partial<ChargeView> = {}): ChargeView => ({
  id: 'charge-1',
  accountId: 'account-1',
  billableServiceId: 'service-1',
  encounterId: null,
  serviceDate: parseClinicalDate('2026-05-11'), // fecha-fija: no reloj; solo viaja
  quantity: Quantity.parse('2'),
  unitAmount: Money.parse('20.00'),
  resolvedPriceId: 'price-1',
  serviceDisplay: 'Curación',
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
  status: 'BILLABLE',
  createdById: CAJA,
  origin: 'MANUAL',
  encounterProcedureId: null,
  serviceOrderItemId: null,
  voidedAt: null,
  voidReason: null,
  invoiceId: null,
  correctsChargeItemId: null,
  ...overrides,
});

function build(
  overrides: Partial<Record<keyof BillingAccountRepository, unknown>> = {},
) {
  const mocks = {
    findAccount: vi.fn().mockResolvedValue({ id: 'account-1', status: 'OPEN' }), // prettier-ignore
    findCharge: vi.fn().mockResolvedValue(line()),
    discountCeilings: vi.fn().mockResolvedValue([Percentage.parse('5'), Percentage.parse('10')]), // prettier-ignore
    permissionsAt: vi.fn().mockResolvedValue(['billing:discount-override']),
    discountAuthorisers: vi.fn().mockResolvedValue([{ userId: ADMIN, name: 'Ana Pérez' }]), // prettier-ignore
    // The adapter runs `decide` under the lock; here, on the line as it is.
    applyDiscount: vi.fn((write: DiscountWrite) => {
      const decided = write.decide(line());
      return Promise.resolve(
        line({ discountAmount: decided.amount, discountAuthorisedById: decided.authorisedById }), // prettier-ignore
      );
    }),
    ...overrides,
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new ChargeDiscountService(
      mocks as unknown as BillingAccountRepository,
      audit,
    ),
    mocks,
    audit,
  };
}

const request = {
  accountId: 'account-1',
  siteId: SITE,
  chargeId: 'charge-1',
  reason: null,
  authorisedById: null,
  requester: { userId: CAJA, ip: '10.0.0.1' },
};

describe('ChargeDiscountService', () => {
  it('BI-062 mide contra el mayor de los límites de quien pide, en esta sede', async () => {
    const { service, mocks } = build();

    // 10 % of $40.00 is exactly $4.00: within the higher of 5 % and 10 %.
    const charge = await service.applyDiscount({
      ...request,
      discount: { amount: Money.parse('4.00') },
    });

    expect(mocks.discountCeilings).toHaveBeenCalledWith({ userId: CAJA, siteId: SITE }); // prettier-ignore
    expect(charge.discountAmount.toString()).toBe('4.00');
    expect(charge.discountAuthorisedById).toBeNull();
  });

  it('BI-060 un porcentaje llega a la línea en dólares', async () => {
    const { service } = build();

    const charge = await service.applyDiscount({
      ...request,
      discount: { percentage: Percentage.parse('7.5') },
    });

    expect(charge.discountAmount.toString()).toBe('3.00');
  });

  it('BI-063 por encima del límite sin autorizador se rechaza con DISCOUNT_EXCEEDS_LIMIT', async () => {
    const { service, audit } = build();

    await expect(
      service.applyDiscount({ ...request, discount: { percentage: Percentage.parse('20') } }), // prettier-ignore
    ).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_LIMIT' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('BI-063 BI-132 por encima del límite con otra persona que puede: entra, con su nombre, y deja bitácora', async () => {
    const { service, mocks, audit } = build();

    const charge = await service.applyDiscount({
      ...request,
      authorisedById: ADMIN,
      discount: { percentage: Percentage.parse('20') },
    });

    expect(mocks.permissionsAt).toHaveBeenCalledWith({ userId: ADMIN, siteId: SITE }); // prettier-ignore
    expect(charge.discountAuthorisedById).toBe(ADMIN);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CAJA, resourceType: 'charge_item', resourceId: 'charge-1', action: 'UPDATE' }), // prettier-ignore
    );
  });

  it('BI-064 quien pide no se autoriza a sí mismo', async () => {
    const { service } = build();

    await expect(
      service.applyDiscount({
        ...request,
        authorisedById: CAJA,
        discount: { percentage: Percentage.parse('20') },
      }),
    ).rejects.toMatchObject({ code: 'SELF_AUTHORISATION_DENIED' });
  });

  it('BI-066 quitar el descuento (cero) no pide autorizador aunque el límite sea cero', async () => {
    const { service } = build({
      discountCeilings: vi.fn().mockResolvedValue([]),
    });

    const charge = await service.applyDiscount({
      ...request,
      discount: { amount: Money.ZERO },
    });

    expect(charge.discountAmount.isZero()).toBe(true);
  });

  it('BI-061 el motivo es opcional y uno en blanco no se guarda', async () => {
    const { service, mocks } = build();

    await service.applyDiscount({ ...request, reason: '   ', discount: { amount: Money.parse('1.00') } }); // prettier-ignore

    expect(mocks.applyDiscount).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null, changedById: CAJA }),
    );
  });

  it('BI-135 una cuenta de otra sede responde como inexistente', async () => {
    const { service } = build({ findAccount: vi.fn().mockResolvedValue(null) });

    await expect(
      service.applyDiscount({
        ...request,
        discount: { amount: Money.parse('1.00') },
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('BI-245 sirve el límite propio y a quién pedir, sin incluir a quien pide', async () => {
    const { service, mocks } = build();

    const policy = await service.discountPolicy({ accountId: 'account-1', siteId: SITE, userId: CAJA }); // prettier-ignore

    expect(policy.maxDiscountPercentage.toString()).toBe('10.00');
    expect(policy.authorisers).toEqual([{ userId: ADMIN, name: 'Ana Pérez' }]);
    expect(mocks.discountAuthorisers).toHaveBeenCalledWith({
      siteId: SITE,
      permission: 'billing:discount-override',
      exceptUserId: CAJA,
    });
  });
});
