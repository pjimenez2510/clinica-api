import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import {
  BillableServiceInUseError,
  BillableServiceNotFoundError,
  TaxRateNotFoundError,
  TaxRateRequiredError,
} from '../domain/billing.errors';
import type {
  BillableServiceView,
  BillingCatalogueRepository,
  TaxRateView,
} from '../domain/billing.repository';
import { Percentage } from '../domain/money';
import { ServiceCatalogueService } from './service-catalogue.service';

const requester = { userId: 'user-1' };

const taxRate: TaxRateView = {
  id: 'tax-0',
  sriCode: '0',
  name: 'IVA 0%',
  percentage: Percentage.ZERO,
  validFrom: parseClinicalDate('2000-01-01'),
  validTo: null,
};

const service: BillableServiceView = {
  id: 'service-1',
  code: 'CONS-MG-PV',
  name: 'Consulta de medicina general, primera vez',
  category: 'Consultas',
  tariffCode: null,
  taxRateId: 'tax-0',
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  active: true,
  specialtyId: null,
  visitSequence: null,
};

/** The catalogue port as a double, with every mock held in a NAMED local. */
function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    listTaxRates: vi.fn().mockResolvedValue([taxRate]),
    findTaxRate: vi.fn().mockResolvedValue(taxRate),
    listBillableServices: vi.fn().mockResolvedValue([service]),
    findBillableService: vi.fn().mockResolvedValue(service),
    createBillableService: vi.fn().mockResolvedValue(service),
    updateBillableService: vi.fn().mockResolvedValue(service),
    countReferencesToService: vi.fn().mockResolvedValue(0),
    deleteBillableService: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    service: new ServiceCatalogueService(
      mocks as unknown as BillingCatalogueRepository,
      mocks,
    ),
    mocks,
  };
}

const newService = {
  code: 'PROC-CURACION',
  name: 'Curación simple',
  category: 'Procedimientos',
  tariffCode: null,
  taxRateId: 'tax-0',
};

describe('BI-005, BI-013 la tarifa de impuesto es un dato exigido, no deducido', () => {
  it('BI-013 rechaza crear una prestación sin tarifa, desde el servicio y no desde el DTO', async () => {
    // A `DEBERÁ` enforced only at the transport layer stops existing the moment
    // a seed or a bulk import writes underneath it.
    const { service: catalogue } = build();

    await expect(
      catalogue.createService({ ...newService, taxRateId: '' }, requester),
    ).rejects.toBeInstanceOf(TaxRateRequiredError);
  });

  it('BI-020 rechaza una tarifa que no existe en el catálogo del SRI', async () => {
    const { service: catalogue } = build({
      findTaxRate: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.createService(newService, requester),
    ).rejects.toBeInstanceOf(TaxRateNotFoundError);
  });

  it('BI-005 no deduce la tarifa de la categoría, del nombre ni del código', async () => {
    // D-A-006: health services are 0% by LRTI art. 56.2, but the 0% depends on
    // the PROVIDER and excludes cosmetic surgery. A rule that deduced «this is
    // health, therefore 0%» would be right almost always and wrong exactly
    // where there is an audit. So the rate travels through, untouched.
    const { service: catalogue, mocks } = build();

    await catalogue.createService(
      { ...newService, name: 'Toxina botulínica, aplicación estética', taxRateId: 'tax-15' }, // prettier-ignore
      requester,
    );

    expect(mocks.createBillableService).toHaveBeenCalledWith(
      expect.objectContaining({ taxRateId: 'tax-15' }),
    );
  });

  it('BI-006 no acepta ni escribe ningún importe en la fila de la prestación', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(newService, requester);

    const written: unknown = mocks.createBillableService.mock.calls[0]?.[0];
    // The classic mistake, refused by the SHAPE: there is no amount key to set.
    expect(Object.keys(written ?? {})).toEqual([
      'code',
      'name',
      'category',
      'tariffCode',
      'taxRateId',
    ]);
  });
});

describe('BI-012, BI-014 retirar una prestación', () => {
  it('BI-012 se niega a borrar una prestación que ya usa un precio o un cargo', async () => {
    // The service an eight-month-old invoice names has to keep existing for
    // that invoice to be readable at all.
    const { service: catalogue, mocks } = build({
      countReferencesToService: vi.fn().mockResolvedValue(3),
    });

    await expect(
      catalogue.deleteService('service-1', requester),
    ).rejects.toBeInstanceOf(BillableServiceInUseError);
    expect(mocks.deleteBillableService).not.toHaveBeenCalled();
  });

  it('BI-012 la borra cuando nadie la ha usado todavía', async () => {
    const { service: catalogue, mocks } = build();
    await catalogue.deleteService('service-1', requester);
    expect(mocks.deleteBillableService).toHaveBeenCalledWith('service-1');
  });

  it('BI-010 responde 404 ante una prestación inexistente antes de tocar nada', async () => {
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.deleteService('missing', requester),
    ).rejects.toBeInstanceOf(BillableServiceNotFoundError);
  });

  it('BI-014 sirve las desactivadas sólo cuando se piden', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.listServices({ includeInactive: false });
    expect(mocks.listBillableServices).toHaveBeenCalledWith({
      includeInactive: false,
    });
  });
});

describe('BI-046, BI-132 la bitácora del catálogo', () => {
  it('BI-046 registra quién creó la prestación, sin cargar la ficha en la bitácora', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(newService, requester);

    expect(mocks.record).toHaveBeenCalledWith({
      userId: 'user-1',
      resourceType: 'billable_service',
      resourceId: 'service-1',
      action: 'CREATE',
      ip: undefined,
      userAgent: undefined,
    });
  });

  it('BI-025 al cambiar la tarifa no toca ningún cargo ya registrado', async () => {
    // BI-051 applied to tax, and said apart because tax is the field that most
    // invites recomputation: it looks derived and it is not. The proof is the
    // absence — this path writes to `billable_service` and to nothing else.
    const { service: catalogue, mocks } = build();

    await catalogue.updateService(
      'service-1',
      { taxRateId: 'tax-15' },
      requester,
    );

    expect(mocks.updateBillableService).toHaveBeenCalledWith('service-1', {
      name: undefined,
      category: undefined,
      tariffCode: undefined,
      taxRateId: 'tax-15',
      active: undefined,
    });
  });
});
