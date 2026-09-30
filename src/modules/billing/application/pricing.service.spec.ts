import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { InvalidRucError } from '../../../shared/domain/value-objects/ruc.vo';
import {
  LastActivePayerError,
  PayerInUseError,
  PayerNotFoundError,
  PayerRucRequiredError,
  PriceListNotFoundError,
} from '../domain/billing.errors';
import type {
  BillingCatalogueRepository,
  PayerView,
} from '../domain/billing.repository';
import { Money } from '../domain/money';
import type { PriceRow } from '../domain/price-list';
import { PricingService } from './pricing.service';

const requester = { userId: 'user-1' };

/**
 * A REAL private-company RUC with its modulus-11 check digit computed, never
 * copied from a taxpayer: 1790012344001.
 */
const VALID_RUC = '1790012344001';

const payer = (overrides: Partial<PayerView> = {}): PayerView => ({
  id: 'payer-particular',
  code: 'PARTICULAR',
  name: 'Particular (paga el paciente)',
  kind: 'SELF_PAY',
  ruc: null,
  agreementReference: null,
  agreementValidTo: null,
  active: true,
  ...overrides,
});

const price = (
  id: string,
  amount: string,
  validFrom: string,
  validTo: string | null = null,
): PriceRow => ({
  id,
  billableServiceId: 'service-1',
  amount: Money.parse(amount),
  validFrom: parseClinicalDate(validFrom),
  validTo: validTo === null ? null : parseClinicalDate(validTo),
});

/** The catalogue port as a double, with every mock held in a NAMED local. */
function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    findPayer: vi.fn().mockResolvedValue(payer()),
    listPayers: vi.fn().mockResolvedValue([payer()]),
    createPayer: vi
      .fn()
      .mockImplementation((data: Partial<PayerView>) =>
        Promise.resolve(payer(data)),
      ),
    updatePayer: vi.fn().mockResolvedValue(payer({ active: false })),
    countActivePayers: vi.fn().mockResolvedValue(3),
    countReferencesToPayer: vi.fn().mockResolvedValue(0),
    findPriceListOfPayer: vi.fn().mockResolvedValue({
      id: 'list-particular',
      name: 'Particular',
      payerId: 'payer-particular',
      siteId: null,
      publiclyListed: true,
      active: true,
    }),
    findBillableService: vi.fn().mockResolvedValue({ id: 'service-1', active: true }), // prettier-ignore
    listPricesOfService: vi.fn().mockResolvedValue([]),
    listPricesOfList: vi.fn().mockResolvedValue([]),
    applyPriceChange: vi.fn().mockResolvedValue(price('new', '35.00', '2026-07-01')), // prettier-ignore
    record: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    service: new PricingService(
      mocks as unknown as BillingCatalogueRepository,
      mocks,
    ),
    mocks,
  };
}

describe('BI-030, BI-034 los pagadores son filas administrables', () => {
  it('BI-034 exige RUC a un pagador institucional', async () => {
    const { service: pricing } = build();

    await expect(
      pricing.createPayer(
        { code: 'IESS', name: 'IESS', kind: 'PUBLIC_NETWORK', ruc: null, agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(PayerRucRequiredError);
  });

  it('BI-034 comprueba la forma con el value object compartido', async () => {
    // `INVALID_RUC` and `PAYER_RUC_REQUIRED` are different codes on purpose:
    // one says the number is wrong, the other that it is missing, and what the
    // user has to do is not the same.
    const { service: pricing } = build();

    await expect(
      pricing.createPayer(
        { code: 'IESS', name: 'IESS', kind: 'PUBLIC_NETWORK', ruc: '179001234500', agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(InvalidRucError);
  });

  it('BI-036 rechaza un RUC escrito mal también en el pagador que paga por sí mismo', async () => {
    // «Particular» needs no RUC, but one that is written reaches an invoice
    // like any other. Before D-057 the API took `12345` here.
    const { service: pricing, mocks } = build();

    await expect(
      pricing.createPayer(
        { code: 'PARTICULAR', name: 'Particular', kind: 'SELF_PAY', ruc: '12345', agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(InvalidRucError);
    expect(mocks.createPayer).not.toHaveBeenCalled();
  });

  it('BI-036 admite una sociedad cuyo RUC no pasa módulo 11, y un «Particular» sin RUC', async () => {
    const { service: pricing } = build();

    await expect(
      pricing.createPayer(
        { code: 'SEGURO-N', name: 'Seguro nuevo', kind: 'PRIVATE_INSURANCE', ruc: '1793189906001', agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).resolves.toMatchObject({ ruc: '1793189906001' });
    await expect(
      pricing.createPayer(
        { code: 'PARTICULAR', name: 'Particular', kind: 'SELF_PAY', ruc: '  ', agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).resolves.toBeDefined();
  });

  it('BI-034 no exige RUC al pagador que representa al paciente que paga por sí mismo', async () => {
    // Demanding one of «Particular» would block the first account of a fresh
    // installation: the patient's own document lives on `patient`.
    const { service: pricing } = build();

    await expect(
      pricing.createPayer(
        { code: 'PARTICULAR', name: 'Particular', kind: 'SELF_PAY', ruc: null, agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).resolves.toBeDefined();
  });

  it('BI-030 admite un pagador institucional con RUC válido', async () => {
    const { service: pricing } = build();

    await expect(
      pricing.createPayer(
        { code: 'SEGURO', name: 'Seguro privado', kind: 'PRIVATE_INSURANCE', ruc: VALID_RUC, agreementReference: null }, // prettier-ignore
        requester,
      ),
    ).resolves.toMatchObject({ ruc: VALID_RUC });
  });

  it('BI-031 se niega a desactivar el único pagador activo', async () => {
    // An installation with no active payer is a clinic that cannot open a
    // single account, and the failure would show up at the desk.
    const { service: pricing } = build({
      countActivePayers: vi.fn().mockResolvedValue(1),
    });

    await expect(
      pricing.updatePayer('payer-particular', { active: false }, requester),
    ).rejects.toBeInstanceOf(LastActivePayerError);
  });

  it('BI-031 permite desactivar uno cuando queda otro activo', async () => {
    const { service: pricing } = build();

    await expect(
      pricing.updatePayer('payer-particular', { active: false }, requester),
    ).resolves.toMatchObject({ active: false });
  });

  it('BI-032 se niega a retirar un pagador con cuentas o listas de precios', async () => {
    const { service: pricing } = build({
      countReferencesToPayer: vi.fn().mockResolvedValue(2),
    });

    await expect(
      pricing.checkPayerIsUnused('payer-particular'),
    ).rejects.toBeInstanceOf(PayerInUseError);
  });

  it('BI-030 responde 404 ante un pagador inexistente', async () => {
    const { service: pricing } = build({
      findPayer: vi.fn().mockResolvedValue(null),
    });

    await expect(pricing.listPrices('missing')).rejects.toBeInstanceOf(
      PayerNotFoundError,
    );
  });
});

describe('BI-040, BI-044, BI-046 el tarifario', () => {
  it('BI-040 rechaza fijar precios de un pagador que aún no tiene lista', async () => {
    const { service: pricing } = build({
      findPriceListOfPayer: vi.fn().mockResolvedValue(null),
    });

    await expect(
      pricing.setPrice(
        {
          payerId: 'payer-particular',
          billableServiceId: 'service-1',
          amount: Money.parse('30.00'),
          effectiveFrom: parseClinicalDate('2026-01-01'),
        },
        requester,
      ),
    ).rejects.toBeInstanceOf(PriceListNotFoundError);
  });

  it('BI-044 cierra la vigencia anterior y abre la nueva en una sola operación', async () => {
    const { service: pricing, mocks } = build({
      listPricesOfService: vi
        .fn()
        .mockResolvedValue([price('old', '30.00', '2026-01-01')]),
    });

    await pricing.setPrice(
      {
        payerId: 'payer-particular',
        billableServiceId: 'service-1',
        amount: Money.parse('35.00'),
        effectiveFrom: parseClinicalDate('2026-07-01'),
      },
      requester,
    );

    expect(mocks.applyPriceChange).toHaveBeenCalledWith(
      'list-particular',
      'service-1',
      expect.objectContaining({
        closes: { priceId: 'old', validTo: '2026-07-01' },
      }),
    );
  });

  it('BI-046 registra en la bitácora cada precio nuevo, con quién lo fijó', async () => {
    const { service: pricing, mocks } = build();

    await pricing.setPrice(
      {
        payerId: 'payer-particular',
        billableServiceId: 'service-1',
        amount: Money.parse('35.00'),
        effectiveFrom: parseClinicalDate('2026-07-01'),
      },
      requester,
    );

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'price', userId: 'user-1' }),
    );
  });
});
