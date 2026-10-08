import { describe, expect, it, vi } from 'vitest';

import type {
  BillingParametersRepository,
  DiscountLimitView,
  NewPaymentMethod,
  PaymentMethodView,
} from '../domain/billing-parameters.repository';
import {
  DiscountLimitRoleNotFoundError,
  LastActivePaymentMethodError,
  PaymentMethodNameTakenError,
  PaymentMethodNotFoundError,
} from '../domain/billing.errors';
import { BillingParametersService } from './billing-parameters.service';

const requester = { userId: 'user-1' };

const method = (
  overrides: Partial<PaymentMethodView> = {},
): PaymentMethodView => ({
  id: 'method-cash',
  name: 'Efectivo',
  sriCode: '01',
  active: true,
  displayOrder: 1,
  lastChange: null,
  ...overrides,
});

const limit = (
  overrides: Partial<DiscountLimitView> = {},
): DiscountLimitView => ({
  roleId: 'role-caja',
  roleCode: 'CAJA',
  roleName: 'Caja',
  roleActive: true,
  maxDiscountPercentage: '0.00',
  lastChange: null,
  ...overrides,
});

/** The port as a double, every mock in a named local. */
function build(
  overrides: Partial<Record<keyof BillingParametersRepository, unknown>> = {},
) {
  const mocks = {
    listPaymentMethods: vi.fn().mockResolvedValue([method()]),
    findPaymentMethod: vi.fn().mockResolvedValue(method()),
    findPaymentMethodNamed: vi.fn().mockResolvedValue(null),
    countActivePaymentMethods: vi.fn().mockResolvedValue(2),
    createPaymentMethod: vi
      .fn()
      .mockImplementation((created: NewPaymentMethod) =>
        Promise.resolve(method({ id: 'method-new', ...created })),
      ),
    updatePaymentMethod: vi
      .fn()
      .mockImplementation((_id: string, update: object) =>
        Promise.resolve(method(update)),
      ),
    listDiscountLimits: vi.fn().mockResolvedValue([limit()]),
    findDiscountLimit: vi.fn().mockResolvedValue(limit()),
    setDiscountLimit: vi
      .fn()
      .mockImplementation((_role: string, percentage: string) =>
        Promise.resolve(limit({ maxDiscountPercentage: percentage })),
      ),
    ...overrides,
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new BillingParametersService(
    mocks as unknown as BillingParametersRepository,
    { record },
  );
  return { service, mocks, record };
}

describe('BI-144 un medio de pago con nombre de la clínica y código del SRI', () => {
  it('BI-144 da de alta «Deuna» con la forma 20 y lo deja en la bitácora con su después (BI-147)', async () => {
    const { service, mocks, record } = build();

    const created = await service.createPaymentMethod(
      { name: 'Deuna', sriCode: '20' },
      requester,
    );

    expect(created).toMatchObject({ name: 'Deuna', sriCode: '20' });
    expect(mocks.createPaymentMethod).toHaveBeenCalledWith(
      { name: 'Deuna', sriCode: '20' },
      'user-1',
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'payment_method',
        action: 'CREATE',
        after: { name: 'Deuna', sriCode: '20', active: true },
      }),
    );
  });

  it('BI-144 rechaza un nombre que ya tiene otro medio con PAYMENT_METHOD_NAME_TAKEN, y no escribe', async () => {
    const { service, mocks } = build({
      findPaymentMethodNamed: vi
        .fn()
        .mockResolvedValue(method({ id: 'method-other', name: 'deuna' })),
    });

    await expect(
      service.createPaymentMethod({ name: 'Deuna', sriCode: '20' }, requester),
    ).rejects.toBeInstanceOf(PaymentMethodNameTakenError);
    expect(mocks.createPaymentMethod).not.toHaveBeenCalled();
  });

  it('BI-144 renombrar un medio con su propio nombre no choca consigo mismo', async () => {
    const { service, mocks } = build({
      findPaymentMethodNamed: vi.fn().mockResolvedValue(method()),
    });

    await service.updatePaymentMethod(
      'method-cash',
      { name: 'EFECTIVO' },
      requester,
    );

    expect(mocks.updatePaymentMethod).toHaveBeenCalled();
  });

  it('BI-100 un medio que no existe responde PAYMENT_METHOD_NOT_FOUND', async () => {
    const { service } = build({
      findPaymentMethod: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.updatePaymentMethod('missing', { active: false }, requester),
    ).rejects.toBeInstanceOf(PaymentMethodNotFoundError);
  });
});

describe('BI-146 un medio de pago se desactiva, y nunca el último', () => {
  it('BI-146 desactiva uno cuando queda otro activo, con su antes y su después (BI-147)', async () => {
    const { service, record } = build();

    await service.updatePaymentMethod(
      'method-cash',
      { active: false },
      requester,
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        before: { name: 'Efectivo', sriCode: '01', active: true },
        after: { name: 'Efectivo', sriCode: '01', active: false },
      }),
    );
  });

  it('BI-146 rechaza desactivar el último activo con LAST_ACTIVE_PAYMENT_METHOD', async () => {
    const { service, mocks } = build({
      countActivePaymentMethods: vi.fn().mockResolvedValue(1),
    });

    await expect(
      service.updatePaymentMethod('method-cash', { active: false }, requester),
    ).rejects.toBeInstanceOf(LastActivePaymentMethodError);
    expect(mocks.updatePaymentMethod).not.toHaveBeenCalled();
  });

  it('BI-146 desactivar uno que ya está inactivo no cuenta los activos', async () => {
    const { service, mocks } = build({
      findPaymentMethod: vi.fn().mockResolvedValue(method({ active: false })),
      countActivePaymentMethods: vi.fn().mockResolvedValue(0),
    });

    await service.updatePaymentMethod(
      'method-cash',
      { active: false },
      requester,
    );

    expect(mocks.countActivePaymentMethods).not.toHaveBeenCalled();
  });
});

describe('BI-141 el límite de descuento de cada rol', () => {
  it('BI-141 asigna el 10 % y deja en la bitácora el antes (cero) y el después (BI-147)', async () => {
    const { service, mocks, record } = build();

    const after = await service.setDiscountLimit(
      'role-caja',
      '10.00',
      requester,
    );

    expect(after.maxDiscountPercentage).toBe('10.00');
    expect(mocks.setDiscountLimit).toHaveBeenCalledWith(
      'role-caja',
      '10.00',
      'user-1',
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'role_discount_limit',
        resourceId: 'role-caja',
        before: { maxDiscountPercentage: '0.00' },
        after: { maxDiscountPercentage: '10.00' },
      }),
    );
  });

  it('BI-141 un rol que no existe responde DISCOUNT_LIMIT_ROLE_NOT_FOUND, y no escribe', async () => {
    const { service, mocks } = build({
      findDiscountLimit: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.setDiscountLimit('missing', '10.00', requester),
    ).rejects.toBeInstanceOf(DiscountLimitRoleNotFoundError);
    expect(mocks.setDiscountLimit).not.toHaveBeenCalled();
  });
});
