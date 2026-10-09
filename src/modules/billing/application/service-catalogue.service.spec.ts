import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import {
  BillableServiceInUseError,
  BillableServiceNotFoundError,
  ServiceCategoryInactiveError,
  ServiceKindMismatchError,
  TaxRateNotFoundError,
  TaxRateRequiredError,
  TaxReviewRateChangedError,
  ServiceNamedElsewhereError,
  ServiceConsentTieLockedError,
  ServiceNotAProcedureError,
  ServiceProcedureNotInTariffError,
  ServiceProcedureTakenError,
} from '../domain/billing.errors';
import type {
  BillableServiceView,
  BillingCatalogueRepository,
  ServiceCategoryView,
  TaxRateView,
} from '../domain/billing.repository';
import { Percentage } from '../domain/money';
import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';

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

const CONSULTATIONS: ServiceCategoryView = {
  id: 'category-consultations',
  name: 'Consultas',
  kind: 'CONSULTATION',
  active: true,
};
const SUPPLIES: ServiceCategoryView = {
  id: 'category-supplies',
  name: 'Insumos',
  kind: 'SUPPLY',
  active: true,
};

const service: BillableServiceView = {
  id: 'service-1',
  code: 'CONS-MG-PV',
  name: 'Consulta de medicina general, primera vez',
  category: CONSULTATIONS,
  procedureConcept: null,
  tariffCode: null,
  taxRateId: 'tax-0',
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  active: true,
  serviceTypes: [],
  taxReview: null,
  writtenConsent: {
    required: false,
    setAt: null,
    setById: null,
    setByName: null,
  },
};

/** The catalogue port as a double, with every mock held in a NAMED local. */
function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    listTaxRates: vi.fn().mockResolvedValue([taxRate]),
    findTaxRate: vi.fn().mockResolvedValue(taxRate),
    listBillableServices: vi.fn().mockResolvedValue([service]),
    findBillableService: vi.fn().mockResolvedValue(service),
    listExamsOfService: vi.fn().mockResolvedValue([]),
    countCategoryTies: vi.fn().mockResolvedValue({
      consultations: 0,
      procedures: 0,
      examCategories: [],
    }),
    updateServiceCategory: vi.fn().mockResolvedValue(SUPPLIES),
    findServiceCategory: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(
          [CONSULTATIONS, SUPPLIES].find((c) => c.id === id) ?? null,
        ),
      ),
    createBillableService: vi.fn().mockResolvedValue(service),
    updateBillableService: vi.fn().mockResolvedValue(service),
    markTaxReviewed: vi.fn().mockResolvedValue(service),
    isTariffConcept: vi.fn().mockResolvedValue(true),
    procedureTakenByOther: vi.fn().mockResolvedValue(false),
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
  categoryId: 'category-supplies',
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
      'categoryId',
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
  it('BI-046 registra quién creó la prestación, y desde BI-231 solo lo que dejó', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(newService, requester);

    expect(mocks.record).toHaveBeenCalledWith({
      userId: 'user-1',
      resourceType: 'billable_service',
      resourceId: 'service-1',
      action: 'CREATE',
      ip: undefined,
      userAgent: undefined,
      before: undefined,
      after: expect.objectContaining({ code: 'CONS-MG-PV' }) as unknown,
    });
  });

  it('BI-231 records the service before and after an edit, amounts as strings', async () => {
    const { service: catalogue, mocks } = build({
      updateBillableService: vi.fn().mockResolvedValue({
        ...service,
        name: 'Consulta general',
        taxRateId: 'tax-15',
        taxPercentage: Percentage.parse('15'),
      }),
    });

    await catalogue.updateService(
      'service-1',
      { name: 'Consulta general', taxRateId: 'tax-15' },
      requester,
    );

    const entry = mocks.record.mock.calls[0]?.[0] as AccessAuditEntry;
    const common = {
      code: 'CONS-MG-PV',
      categoryId: CONSULTATIONS.id,
      tariffCode: null,
      active: true,
      taxReviewedAt: null,
      taxReviewedById: null,
      procedureConceptId: null,
      requiresWrittenConsent: false,
      writtenConsentSetById: null,
    };
    expect(entry.before).toEqual({
      ...common,
      name: 'Consulta de medicina general, primera vez',
      taxRateId: 'tax-0',
    });
    expect(entry.after).toEqual({
      ...common,
      name: 'Consulta general',
      taxRateId: 'tax-15',
    });
    // `Money` and `Percentage` hold bigints: a snapshot carrying one would
    // make the audit INSERT throw and the entry would be lost.
    expect(() => JSON.stringify(entry)).not.toThrow();
  });

  it('BI-231 records the category before and after an edit', async () => {
    const { service: catalogue, mocks } = build({
      updateServiceCategory: vi
        .fn()
        .mockResolvedValue({ ...SUPPLIES, name: 'Insumos médicos' }),
    });

    await catalogue.updateCategory(
      SUPPLIES.id,
      { name: 'Insumos médicos' },
      requester,
    );

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'billable_service_category',
        action: 'UPDATE',
        before: { name: 'Insumos', kind: 'SUPPLY', active: true },
        after: { name: 'Insumos médicos', kind: 'SUPPLY', active: true },
      }),
    );
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
      // D-172.2: the new rate is nobody's review yet.
      taxReview: null,
    });
  });
});

describe('BI-011 el código del tarifario nacional es nomenclatura', () => {
  it('BI-011 guarda y borra el código del tarifario sin tomar de él ningún importe', async () => {
    // The national tariff carries an amount for the public network; this
    // clinic's price is in its own list. The update carries the code and
    // nothing that could hold a price.
    const { service: catalogue, mocks } = build();

    await catalogue.updateService('service-1', { tariffCode: '99203' }, requester); // prettier-ignore
    await catalogue.updateService('service-1', { tariffCode: null }, requester);

    const updates = mocks.updateBillableService.mock.calls.map(
      (call) => call[1] as unknown,
    );
    expect(updates).toEqual([{ tariffCode: '99203' }, { tariffCode: null }]);
  });
});

describe('BI-023 BI-024 la revisión contable de la tarifa', () => {
  const reviewer = { userId: 'accountant-1' };
  const reviewed = {
    reviewedAt: new Date(),
    reviewedById: reviewer.userId,
    reviewedByName: 'Rosa Cedeño',
  };
  const withReview = () => ({
    markTaxReviewed: vi
      .fn()
      .mockResolvedValue({ ...service, taxReview: reviewed }),
  });

  // BI-022's other half —0 % when no rate is given— waits for D-172.1, so
  // this cites the review it shares with BI-024 and not BI-022 itself.
  it('BI-024 una prestación nueva no nace revisada: nada en el alta escribe la revisión', async () => {
    const { service: catalogue, mocks } = build(withReview());

    await catalogue.createService(newService, requester);

    expect(mocks.createBillableService.mock.calls[0]?.[0]).not.toHaveProperty(
      'taxReview',
    );
    expect(mocks.markTaxReviewed).not.toHaveBeenCalled();
  });

  it('BI-024 marcarla revisada escribe quién y el instante del reloj de la aplicación, sobre la tarifa que vio', async () => {
    const { service: catalogue, mocks } = build(withReview());
    const before = Date.now();

    const result = await catalogue.markTaxReviewed('service-1', 'tax-0', reviewer); // prettier-ignore

    const [id, seen, review] = mocks.markTaxReviewed.mock.calls[0] as [
      string,
      string,
      { reviewedAt: Date; reviewedById: string },
    ];
    expect([id, seen, review.reviewedById]).toEqual([
      'service-1',
      'tax-0',
      'accountant-1',
    ]);
    expect(review.reviewedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(review.reviewedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(result.taxReview).toEqual(reviewed);
  });

  it('BI-024 si la tarifa ya no es la que vio quien revisa, se rechaza y no escribe nada', async () => {
    const { service: catalogue, mocks } = build(withReview());

    await expect(
      catalogue.markTaxReviewed('service-1', 'tax-15', reviewer),
    ).rejects.toBeInstanceOf(TaxReviewRateChangedError);
    expect(mocks.markTaxReviewed).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('BI-024 si la tarifa cambia entre la lectura y la escritura, también se rechaza', async () => {
    const { service: catalogue, mocks } = build({
      markTaxReviewed: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.markTaxReviewed('service-1', 'tax-0', reviewer),
    ).rejects.toBeInstanceOf(TaxReviewRateChangedError);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('BI-024 la bitácora guarda la fila antes y después de la revisión, con quién', async () => {
    const { service: catalogue, mocks } = build(withReview());

    await catalogue.markTaxReviewed('service-1', 'tax-0', reviewer);

    const entry = mocks.record.mock.calls[0]?.[0] as AccessAuditEntry;
    expect(entry).toMatchObject({
      userId: 'accountant-1',
      resourceType: 'billable_service',
      resourceId: 'service-1',
      action: 'UPDATE',
      before: { taxReviewedAt: null, taxReviewedById: null },
      after: {
        taxReviewedAt: reviewed.reviewedAt.toISOString(),
        taxReviewedById: 'accountant-1',
      },
    });
  });

  it('BI-024 cambiar la tarifa la devuelve a pendiente, y la revisión anterior queda en la bitácora', async () => {
    const { service: catalogue, mocks } = build({
      findBillableService: vi
        .fn()
        .mockResolvedValue({ ...service, taxReview: reviewed }),
    });

    await catalogue.updateService('service-1', { taxRateId: 'tax-15' }, requester); // prettier-ignore

    expect(mocks.updateBillableService.mock.calls[0]?.[1]).toMatchObject({
      taxRateId: 'tax-15',
      taxReview: null,
    });
    const entry = mocks.record.mock.calls[0]?.[0] as AccessAuditEntry;
    expect(entry.before).toMatchObject({
      taxRateId: 'tax-0',
      taxReviewedAt: reviewed.reviewedAt.toISOString(),
      taxReviewedById: 'accountant-1',
    });
  });

  it('BI-024 cambiar el nombre, o guardar la misma tarifa, no toca la revisión (control)', async () => {
    const { service: catalogue, mocks } = build({
      findBillableService: vi
        .fn()
        .mockResolvedValue({ ...service, taxReview: reviewed }),
    });

    await catalogue.updateService('service-1', { name: 'Consulta general' }, requester); // prettier-ignore
    await catalogue.updateService('service-1', { taxRateId: 'tax-0' }, requester); // prettier-ignore

    for (const [, update] of mocks.updateBillableService.mock.calls) {
      expect(update).not.toHaveProperty('taxReview');
    }
  });

  it('BI-024 marcar revisada una prestación inexistente responde 404 sin escribir', async () => {
    const { service: catalogue, mocks } = build({
      ...withReview(),
      findBillableService: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.markTaxReviewed('missing', 'tax-0', reviewer),
    ).rejects.toBeInstanceOf(BillableServiceNotFoundError);
    expect(mocks.markTaxReviewed).not.toHaveBeenCalled();
  });
});

describe('BI-185, BI-187 la categoría es un catálogo y su clase manda', () => {
  it('BI-185 no deja crear una prestación con una categoría desactivada', async () => {
    const { service: catalogue } = build({
      findServiceCategory: vi
        .fn()
        .mockResolvedValue({ ...SUPPLIES, active: false }),
    });

    await expect(
      catalogue.createService(newService, requester),
    ).rejects.toBeInstanceOf(ServiceCategoryInactiveError);
  });

  it('BI-187 rechaza pasar a una categoría de otra clase la prestación que cobra un tipo de atención', async () => {
    const charging = {
      ...service,
      serviceTypes: [
        { id: 'type-1', name: 'Control', specialtyName: 'Dermatología' },
      ],
    };
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue(charging),
    });

    await expect(
      catalogue.updateService('service-1', { categoryId: SUPPLIES.id }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });

  it('BI-187 un procedimiento atado a su concepto no se pasa a otra clase', async () => {
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue({
        ...service,
        category: {
          ...CONSULTATIONS,
          id: 'category-procedures',
          kind: 'PROCEDURE',
        },
        procedureConcept: { id: 'c-1', code: 'SUTURA', display: 'Sutura' },
      }),
    });

    await expect(
      catalogue.updateService('service-1', { categoryId: SUPPLIES.id }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });
});

describe('ORD-163 SP-030 lo que nace con un examen o un tipo se corrige allí', () => {
  it('ORD-163 SP-030 renombrar o cambiar el tarifario de la prestación de un tipo de atención se rechaza; su IVA, no', async () => {
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue({
        ...service,
        serviceTypes: [{ id: 'type-1', name: 'Control', specialtyName: 'Dermatología' }], // prettier-ignore
      }),
    });

    await expect(
      catalogue.updateService('service-1', { name: 'Otra' }, requester),
    ).rejects.toBeInstanceOf(ServiceNamedElsewhereError);
    await expect(
      catalogue.updateService('service-1', { tariffCode: '99' }, requester),
    ).rejects.toBeInstanceOf(ServiceNamedElsewhereError);
    // Control positivo: lo que es de facturación se sigue corrigiendo aquí.
    await expect(
      catalogue.updateService('service-1', { active: false }, requester),
    ).resolves.toBeDefined();
  });

  it('ORD-163 la prestación de un examen no se renombra desde aquí', async () => {
    const { service: catalogue } = build({
      listExamsOfService: vi.fn().mockResolvedValue([{ id: 'e-1', code: 'EX-1', name: 'X', category: 'LABORATORY', active: true }]), // prettier-ignore
    });

    await expect(
      catalogue.updateService('service-1', { name: 'Otra' }, requester),
    ).rejects.toBeInstanceOf(ServiceNamedElsewhereError);
  });
});

describe('BI-187 corregir siempre es posible', () => {
  it('BI-187 una prestación que ya está en desajuste se puede desactivar', async () => {
    // A migrated clinic: «Consulta externa» became OTHER with its consultation
    // still tied to a specialty. Renaming or deactivating must not be refused.
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue({
        ...service,
        category: { ...SUPPLIES, kind: 'OTHER' },
        serviceTypes: [
          { id: 'type-1', name: 'Control', specialtyName: 'Dermatología' },
        ],
      }),
    });

    await expect(
      catalogue.updateService('service-1', { active: false }, requester), // prettier-ignore
    ).resolves.toBeDefined();
  });

  it('BI-187 una prestación por la que se cobran exámenes no pasa a una clase que no es de examen', async () => {
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue({
        ...service,
        category: { ...SUPPLIES, id: 'category-lab', kind: 'LABORATORY' },
      }),
      listExamsOfService: vi.fn().mockResolvedValue([
        { id: 'e1', code: 'EX-BH', name: 'BH', category: 'LABORATORY', active: true }, // prettier-ignore
      ]),
    });

    await expect(
      catalogue.updateService('service-1', { categoryId: SUPPLIES.id }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });

  it('BI-187 ORD-108 la prestación de un examen es de la clase de su tipo: un ECG se cobra como procedimiento, un hemograma no como imagen', async () => {
    const { service: catalogue, mocks } = build();

    mocks.countCategoryTies.mockResolvedValue({ consultations: 0, procedures: 0, examCategories: ['PROCEDURE'] }); // prettier-ignore
    await expect(
      catalogue.updateCategory(SUPPLIES.id, { kind: 'PROCEDURE' }, requester),
    ).resolves.toBeDefined();

    mocks.countCategoryTies.mockResolvedValue({ consultations: 0, procedures: 0, examCategories: ['LABORATORY'] }); // prettier-ignore
    await expect(
      catalogue.updateCategory(SUPPLIES.id, { kind: 'IMAGING' }, requester),
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });

  it('BI-187 la clase de una categoría se cambia si ninguna de sus prestaciones choca, y no si alguna sí', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.updateCategory(SUPPLIES.id, { kind: 'CONSULTATION' }, requester); // prettier-ignore
    expect(mocks.updateServiceCategory).toHaveBeenCalledWith(SUPPLIES.id, {
      kind: 'CONSULTATION',
    });

    mocks.countCategoryTies.mockResolvedValue({ consultations: 1, procedures: 0, examCategories: [] }); // prettier-ignore
    await expect(
      catalogue.updateCategory(SUPPLIES.id, { kind: 'OTHER' }, requester),
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });
});

const PROCEDURES: ServiceCategoryView = {
  id: 'category-procedures',
  name: 'Procedimientos',
  kind: 'PROCEDURE',
  active: true,
};
const procedureService: BillableServiceView = {
  ...service,
  category: PROCEDURES,
  procedureConcept: { id: 'c-1', code: '10120', display: 'Biopsia de piel' },
};

describe('BI-256 la marca «exige consentimiento 024» la pone la dirección médica', () => {
  it('BI-256 marca con quién y cuándo, del reloj de la aplicación, y deja la prestación antes y después en la bitácora', async () => {
    const marked: BillableServiceView = {
      ...procedureService,
      writtenConsent: { required: true, setAt: new Date(), setById: 'user-1', setByName: 'Ana Villacís' }, // prettier-ignore
    };
    const { service: catalogue, mocks } = build({
      findBillableService: vi.fn().mockResolvedValue(procedureService),
      updateBillableService: vi.fn().mockResolvedValue(marked),
    });
    const before = Date.now();

    await expect(catalogue.markWrittenConsent('service-1', true, requester)).resolves.toBe(marked); // prettier-ignore

    const [, update] = mocks.updateBillableService.mock.calls[0]!;
    expect(update).toEqual({
      writtenConsent: {
        required: true,
        setAt: expect.any(Date),
        setById: 'user-1',
      },
    });
    expect((update as { writtenConsent: { setAt: Date } }).writtenConsent.setAt.getTime()).toBeGreaterThanOrEqual(before); // prettier-ignore
    const entry = mocks.record.mock.calls[0]![0] as AccessAuditEntry;
    expect(entry).toMatchObject({
      resourceType: 'billable_service',
      action: 'UPDATE',
      before: expect.objectContaining({ requiresWrittenConsent: false }),
      after: expect.objectContaining({ requiresWrittenConsent: true, writtenConsentSetById: 'user-1' }), // prettier-ignore
    });
  });

  it('BI-256 rechaza marcar una prestación que no cobra un procedimiento; ponerla como ya está no escribe nada', async () => {
    const { service: catalogue, mocks } = build();
    await expect(
      catalogue.markWrittenConsent('service-1', true, requester),
    ).rejects.toBeInstanceOf(ServiceNotAProcedureError);

    // Control positivo: desmarcar la que ya está apagada no es un cambio.
    await expect(catalogue.markWrittenConsent('service-1', false, requester)).resolves.toBe(service); // prettier-ignore
    expect(mocks.updateBillableService).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('BI-256 D-199.1 la atadura de una prestación marcada no se desata, no se cambia ni se borra con la llave de precios', async () => {
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue({
        ...procedureService,
        writtenConsent: { required: true, setAt: new Date(), setById: 'user-1', setByName: 'Ana Villacís' }, // prettier-ignore
      }),
    });
    await expect(
      catalogue.updateService('service-1', { procedureConceptId: null }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceConsentTieLockedError);
    await expect(
      catalogue.updateService('service-1', { procedureConceptId: 'c-2' }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceConsentTieLockedError);
    await expect(catalogue.deleteService('service-1', requester)).rejects.toBeInstanceOf(ServiceConsentTieLockedError); // prettier-ignore
    // Control positivo: renombrarla sí.
    await expect(catalogue.updateService('service-1', { name: 'Biopsia' }, requester)).resolves.toBeDefined(); // prettier-ignore
  });

  it('BI-257 un procedimiento lo cobra una sola prestación', async () => {
    const { service: catalogue } = build({
      findBillableService: vi.fn().mockResolvedValue({ ...service, category: PROCEDURES }), // prettier-ignore
      procedureTakenByOther: vi.fn().mockResolvedValue(true),
    });
    await expect(
      catalogue.updateService('service-1', { procedureConceptId: 'c-1' }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceProcedureTakenError);
  });
});

describe('BI-257 la prestación de procedimiento se ata a su concepto desde la ficha', () => {
  it('BI-257 ata una prestación de clase procedimiento a un concepto del tarifario', async () => {
    const { service: catalogue, mocks } = build({
      findBillableService: vi
        .fn()
        .mockResolvedValue({ ...service, category: PROCEDURES }),
    });
    await catalogue.updateService(
      'service-1',
      { procedureConceptId: 'c-1' },
      requester,
    );
    expect(mocks.isTariffConcept).toHaveBeenCalledWith('c-1');
    expect(mocks.updateBillableService).toHaveBeenCalledWith('service-1', { procedureConceptId: 'c-1' }); // prettier-ignore
  });

  it('BI-257 rechaza un concepto que no es del tarifario y la atadura en una prestación que no es de procedimiento', async () => {
    const { service: catalogue } = build({
      findBillableService: vi
        .fn()
        .mockResolvedValue({ ...service, category: PROCEDURES }),
      isTariffConcept: vi.fn().mockResolvedValue(false),
    });
    await expect(
      catalogue.updateService(
        'service-1',
        { procedureConceptId: 'c-cie10' },
        requester,
      ),
    ).rejects.toBeInstanceOf(ServiceProcedureNotInTariffError);

    const { service: consultations } = build();
    await expect(
      consultations.updateService(
        'service-1',
        { procedureConceptId: 'c-1' },
        requester,
      ),
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });
});
