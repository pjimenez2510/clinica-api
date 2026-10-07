import { describe, expect, it, vi } from 'vitest';

import {
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { InvalidRucError } from '../../../shared/domain/value-objects/ruc.vo';
import {
  LastActivePayerError,
  PayerInUseError,
  PayerNotFoundError,
  PayerRucRequiredError,
  PriceEntryNotFoundError,
  PriceListNotFoundError,
  PriceNotEditableError,
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
 * A private-company RUC, never copied from a taxpayer: 1790012344001. Built
 * with the former modulo 11 digit, which OR-009 no longer checks.
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
    findPrice: vi.fn().mockResolvedValue(null),
    correctPriceAmount: vi.fn(),
    countOpenChargesAt: vi.fn().mockResolvedValue(0),
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

  it('BI-036 al editar, rechaza el RUC mal escrito de «Particular» y no escribe nada', async () => {
    const { service: pricing, mocks } = build();

    await expect(
      pricing.updatePayer('payer-particular', { ruc: '12345' }, requester),
    ).rejects.toBeInstanceOf(InvalidRucError);
    expect(mocks.updatePayer).not.toHaveBeenCalled();
  });

  it('BI-036 al editar, guarda el RUC recortado, y el vacío como ausente', async () => {
    const { service: pricing, mocks } = build();

    await pricing.updatePayer('payer-particular', { ruc: ' 1793189906001 ' }, requester); // prettier-ignore
    await pricing.updatePayer('payer-particular', { ruc: '' }, requester);

    expect(mocks.updatePayer).toHaveBeenNthCalledWith(1, 'payer-particular', { ruc: '1793189906001' }); // prettier-ignore
    expect(mocks.updatePayer).toHaveBeenNthCalledWith(2, 'payer-particular', { ruc: null }); // prettier-ignore
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

describe('BI-231 la bitácora con antes y después', () => {
  it('BI-231 records the payer before and after an edit', async () => {
    const { service: pricing, mocks } = build({
      findPayer: vi.fn().mockResolvedValue(
        payer({
          id: 'payer-iess',
          code: 'IESS',
          kind: 'PUBLIC_NETWORK',
          ruc: VALID_RUC,
        }),
      ),
      updatePayer: vi.fn().mockResolvedValue(
        payer({
          id: 'payer-iess',
          code: 'IESS',
          kind: 'PUBLIC_NETWORK',
          ruc: VALID_RUC,
          agreementReference: 'CONV-0042',
        }),
      ),
    });

    await pricing.updatePayer(
      'payer-iess',
      { agreementReference: 'CONV-0042' },
      requester,
    );

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'payer',
        resourceId: 'payer-iess',
        action: 'UPDATE',
        before: expect.objectContaining({
          agreementReference: null,
        }) as unknown,
        after: expect.objectContaining({
          agreementReference: 'CONV-0042',
        }) as unknown,
      }),
    );
  });

  it('BI-231 a new price carries only the after half, its amount as a string', async () => {
    const today = clinicalDateOf(new Date());
    const { service: pricing, mocks } = build({
      applyPriceChange: vi.fn().mockResolvedValue(price('new', '35.00', today)),
    });

    await pricing.setPrice(
      {
        payerId: 'payer-particular',
        billableServiceId: 'service-1',
        amount: Money.parse('35.00'),
        effectiveFrom: today,
      },
      requester,
    );

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'price',
        action: 'CREATE',
        before: undefined,
        after: {
          billableServiceId: 'service-1',
          amount: '35.00',
          validFrom: today,
          validTo: null,
        },
      }),
    );
  });
});

describe('BI-230 corregir el importe de un precio en el sitio', () => {
  const now = new Date();
  const today = clinicalDateOf(now);
  const inForce = {
    ...price('price-1', '30.00', today),
    priceListId: 'list-particular',
  };

  it('BI-230 corrige el importe con el sello de quién y cuándo, y deja el antes y el después', async () => {
    const { service, mocks } = build({
      findPrice: vi.fn().mockResolvedValue(inForce),
      correctPriceAmount: vi
        .fn()
        .mockResolvedValue({ ...inForce, amount: Money.parse('31.50') }),
    });

    const corrected = await service.correctPrice(
      'price-1',
      Money.parse('31.50'),
      requester,
      now,
    );

    expect(corrected.amount.toString()).toBe('31.50');
    expect(mocks.correctPriceAmount).toHaveBeenCalledWith(
      'price-1',
      Money.parse('31.50'),
      { by: 'user-1', at: now },
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'price',
        before: expect.objectContaining({ amount: '30.00' }),
        after: expect.objectContaining({ amount: '31.50' }),
      }),
    );
  });

  it('BI-230 dice cuántos cargos sin facturar conservan el importe anterior', async () => {
    const countOpenChargesAt = vi.fn().mockResolvedValue(10);
    const { service } = build({
      findPrice: vi.fn().mockResolvedValue(inForce),
      correctPriceAmount: vi
        .fn()
        .mockResolvedValue({ ...inForce, amount: Money.parse('31.50') }),
      countOpenChargesAt,
    });

    const corrected = await service.correctPrice(
      'price-1',
      Money.parse('31.50'),
      requester,
      now,
    );

    expect(corrected.openChargesAtPreviousAmount).toBe(10);
    expect(countOpenChargesAt).toHaveBeenCalledWith(
      'price-1',
      Money.parse('30.00'),
    );
  });

  it('BI-230 un precio que ya dejó de regir no se corrige, y no se escribe nada', async () => {
    const { service, mocks } = build({
      findPrice: vi.fn().mockResolvedValue({ ...inForce, validTo: today }),
      correctPriceAmount: vi.fn(),
    });

    await expect(
      service.correctPrice('price-1', Money.parse('31.50'), requester, now),
    ).rejects.toBeInstanceOf(PriceNotEditableError);
    expect(mocks.correctPriceAmount).not.toHaveBeenCalled();
  });

  it('BI-230 un precio inexistente responde PRICE_ENTRY_NOT_FOUND', async () => {
    const { service } = build({ findPrice: vi.fn().mockResolvedValue(null) });

    await expect(
      service.correctPrice('ghost', Money.parse('1'), requester, now),
    ).rejects.toBeInstanceOf(PriceEntryNotFoundError);
  });
});
