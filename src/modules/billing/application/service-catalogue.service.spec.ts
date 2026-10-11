import { describe, expect, it, vi } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { DurationNotSlotMultipleError } from '../../../shared/domain/errors/slot-atom.errors';
import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  BillableServiceInUseError,
  BillableServiceNotFoundError,
  ConsultationDuplicateError,
  ConsultationIncompleteError,
  PriceListNotFoundError,
  ServiceCodeInvoicedError,
  ServiceCodeOrderedError,
  ServiceConsentTieLockedError,
  ServiceKindMismatchError,
  ServiceNotAProcedureError,
  ServiceProcedureNotInTariffError,
  ServiceProcedureTakenError,
  ServiceTariffCodeInvoicedError,
  TaxRateNotFoundError,
  TaxRateRequiredError,
  TaxReviewRateChangedError,
} from '../domain/billing.errors';
import type {
  BillingCatalogueRepository,
  NewService,
  ServiceView,
  TaxRateView,
} from '../domain/billing.repository';
import { Money, Percentage } from '../domain/money';

import { ServiceCatalogueService } from './service-catalogue.service';

const requester = { userId: 'user-1' };
/** BI-299. The order key's check, which these services do not reach. */
const noOrderKeyNeeded = (): void => undefined;

const taxRate: TaxRateView = {
  id: 'tax-0',
  sriCode: '0',
  name: 'IVA 0%',
  percentage: Percentage.ZERO,
  validFrom: parseClinicalDate('2000-01-01'),
  validTo: null,
};

const service: ServiceView = {
  id: 'service-1',
  code: 'CONS-MG-PV',
  name: 'Consulta de medicina general · Primera vez',
  kind: 'CONSULTATION',
  consultation: {
    specialtyId: 'specialty-general',
    specialtyName: 'Medicina General',
    durationMinutes: 30,
    visitKind: 'FIRST_VISIT',
  },
  exam: null,
  mspCode: null,
  taxRateId: 'tax-0',
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  active: true,
  taxReview: null,
  writtenConsent: {
    required: false,
    setAt: null,
    setById: null,
    setByName: null,
  },
};

const procedureService: ServiceView = {
  ...service,
  code: 'PROC-BIOPSIA',
  name: 'Biopsia de piel',
  kind: 'PROCEDURE',
  consultation: null,
  mspCode: '10120',
};

const examService: ServiceView = {
  ...service,
  code: 'LAB-GLU',
  name: 'Glucosa en ayunas',
  kind: 'LAB_EXAM',
  consultation: null,
  exam: {
    form010Section: 'BIOQUÍMICA',
    specimenType: 'Suero',
    patientPreparation: null,
    turnaroundHours: 4,
    requiresFasting: true,
    fastingHours: 8,
    performedExternally: true,
    externalLabName: null,
    externalLabCode: null,
  },
};

/** The catalogue port as a double, with every mock held in a NAMED local. */
function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    listTaxRates: vi.fn().mockResolvedValue([taxRate]),
    findTaxRate: vi.fn().mockResolvedValue(taxRate),
    findHealthTaxRate: vi.fn().mockResolvedValue(taxRate),
    listServices: vi.fn(),
    findService: vi.fn().mockResolvedValue(service),
    listAnalytesOfService: vi.fn().mockResolvedValue([]),
    listPricesAcrossPayers: vi.fn().mockResolvedValue([]),
    createService: vi.fn().mockResolvedValue(service),
    updateService: vi.fn().mockResolvedValue(service),
    markTaxReviewed: vi.fn().mockResolvedValue(service),
    hasInvoicedCharges: vi.fn().mockResolvedValue(false),
    codeWasOrdered: vi.fn().mockResolvedValue(false),
    isTariffProcedureCode: vi.fn().mockResolvedValue(true),
    procedureCodeTakenByOther: vi.fn().mockResolvedValue(false),
    specialtyIsActive: vi.fn().mockResolvedValue(true),
    findActiveConsultation: vi.fn().mockResolvedValue(null),
    siteSlotAtoms: vi.fn().mockResolvedValue([10]),
    codesStartingWith: vi.fn().mockResolvedValue([]),
    findSelfPayPriceList: vi.fn().mockResolvedValue({
      id: 'list-self-pay',
      name: 'Particular',
      payerId: 'payer-self',
      siteId: null,
      publiclyListed: true,
      active: true,
    }),
    countReferencesToService: vi.fn().mockResolvedValue(0),
    deleteService: vi.fn().mockResolvedValue(undefined),
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

/** What `createService` handed the port. */
function created(mocks: ReturnType<typeof build>['mocks']): NewService {
  return mocks.createService.mock.calls[0]![0] as NewService;
}

const newSupply = {
  kind: 'SUPPLY' as const,
  name: 'Gasa estéril',
  selfPayAmount: Money.parse('1.50'),
  mspCode: null,
};

const newConsultation = {
  kind: 'CONSULTATION' as const,
  name: 'Consulta de cardiología · Control',
  selfPayAmount: Money.parse('25.00'),
  mspCode: null,
  specialtyId: 'specialty-cardiology',
  durationMinutes: 20,
  visitKind: 'FOLLOW_UP' as const,
};

describe('BI-280 crear un servicio pide el tipo, lo de ese tipo y su precio', () => {
  it('BI-280 escribe el servicio y su precio particular desde hoy en Ecuador, en una sola operación', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(newSupply, requester);

    const written = created(mocks);
    expect(written).toMatchObject({
      kind: 'SUPPLY',
      name: 'Gasa estéril',
      consultation: null,
      exam: null,
      selfPay: { priceListId: 'list-self-pay' },
    });
    expect(written.selfPay.amount.toString()).toBe('1.50');
    expect(written.selfPay.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('BI-280 admite cero como precio (D-228)', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(
      { ...newSupply, selfPayAmount: Money.parse('0.00') },
      requester,
    );

    expect(created(mocks).selfPay.amount.toString()).toBe('0.00');
  });

  it('BI-280 propone el código desde el tipo y el nombre, sin repetir uno tomado; el escrito se respeta', async () => {
    const { service: catalogue, mocks } = build({
      codesStartingWith: vi.fn().mockResolvedValue(['INS-GASA-ESTERIL']),
    });

    await catalogue.createService(newSupply, requester);
    await catalogue.createService({ ...newSupply, code: ' MIA-01 ' }, requester); // prettier-ignore

    expect(mocks.codesStartingWith).toHaveBeenCalledWith('INS');
    expect((mocks.createService.mock.calls[0]![0] as NewService).code).toBe('INS-GASA-ESTERIL-2'); // prettier-ignore
    expect((mocks.createService.mock.calls[1]![0] as NewService).code).toBe('MIA-01'); // prettier-ignore
  });

  it('BI-280 sin IVA indicado toma el de servicios de salud (código 0), sin revisar; con uno, exige que exista', async () => {
    const { service: catalogue, mocks } = build({
      findTaxRate: vi.fn().mockResolvedValue(null),
    });

    await catalogue.createService(newSupply, requester);
    expect(created(mocks).taxRateId).toBe('tax-0');
    expect(created(mocks)).not.toHaveProperty('taxReview');

    await expect(
      catalogue.createService({ ...newSupply, taxRateId: 'tax-x' }, requester),
    ).rejects.toBeInstanceOf(TaxRateNotFoundError);
  });

  it('BI-013 sin IVA que tomar no crea nada; corregir a «sin IVA» tampoco se admite', async () => {
    const { service: catalogue, mocks } = build({
      findHealthTaxRate: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.createService(newSupply, requester),
    ).rejects.toBeInstanceOf(TaxRateRequiredError);
    expect(mocks.createService).not.toHaveBeenCalled();

    await expect(
      catalogue.updateService(
        'service-1',
        { taxRateId: '' },
        requester,
        noOrderKeyNeeded,
      ),
    ).rejects.toBeInstanceOf(TaxRateRequiredError);
    expect(mocks.updateService).not.toHaveBeenCalled();
  });

  it('BI-005 el IVA no se deduce del nombre, del código ni del tipo: es el que se dice, o el de salud por defecto', async () => {
    const general = { ...taxRate, id: 'tax-15', sriCode: '4', name: 'IVA 15%' };
    const { service: catalogue, mocks } = build({
      findTaxRate: vi.fn().mockResolvedValue(general),
    });

    // A name that «sounds» cosmetic gets no rate of its own from it…
    await catalogue.createService(
      {
        ...newSupply,
        kind: 'PROCEDURE',
        name: 'Cirugía estética',
        code: 'EST-1',
      },
      requester,
    );
    // …and one that «sounds» like health, with a rate said, keeps the one said.
    await catalogue.createService(
      {
        ...newSupply,
        name: 'Consulta de salud',
        code: 'SALUD-1',
        taxRateId: 'tax-15',
      },
      requester,
    );

    const calls = mocks.createService.mock.calls as [NewService][];
    expect(calls[0]![0].taxRateId).toBe('tax-0');
    expect(calls[1]![0].taxRateId).toBe('tax-15');
  });

  it('BI-280 sin lista particular activa no crea nada', async () => {
    const { service: catalogue, mocks } = build({
      findSelfPayPriceList: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.createService(newSupply, requester),
    ).rejects.toBeInstanceOf(PriceListNotFoundError);
    expect(mocks.createService).not.toHaveBeenCalled();
  });
});

describe('BI-279 la consulta lleva especialidad, duración y visita', () => {
  it('BI-279 crea la consulta con su especialidad, su duración y su visita', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(newConsultation, requester);

    expect(created(mocks).consultation).toEqual({
      specialtyId: 'specialty-cardiology',
      durationMinutes: 20,
      visitKind: 'FOLLOW_UP',
    });
  });

  it('BI-298 una segunda consulta activa de la misma especialidad y visita se rechaza nombrando la que existe', async () => {
    const { service: catalogue, mocks } = build();
    mocks.findActiveConsultation.mockResolvedValueOnce({
      id: 'service-existing',
      name: 'Consulta de cardiología · Control',
      specialtyName: 'Cardiología',
    });

    const refusal = await catalogue
      .createService(newConsultation, requester)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConsultationDuplicateError);
    expect((refusal as ConsultationDuplicateError).userTitle).toBe(
      'Ya existe la consulta de Cardiología · Control: edítela',
    );
    // What the screen shows: the first field error says the same.
    expect(
      (refusal as ConsultationDuplicateError).fieldErrors?.[0]?.message,
    ).toBe('Ya existe la consulta de Cardiología · Control: edítela');
    expect(mocks.findActiveConsultation).toHaveBeenCalledWith('specialty-cardiology', 'FOLLOW_UP', null); // prettier-ignore
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('BI-298 corregir la visita o reactivar una consulta mira si ya hay otra; renombrarla, no', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.updateService(
      'service-1',
      { name: 'Otra' },
      requester,
      noOrderKeyNeeded,
    );
    expect(mocks.findActiveConsultation).not.toHaveBeenCalled();

    await catalogue.updateService('service-1', { visitKind: 'FOLLOW_UP' }, requester, noOrderKeyNeeded); // prettier-ignore
    expect(mocks.findActiveConsultation).toHaveBeenLastCalledWith('specialty-general', 'FOLLOW_UP', 'service-1'); // prettier-ignore

    mocks.findService.mockResolvedValueOnce({ ...service, active: false });
    mocks.findActiveConsultation.mockResolvedValueOnce({ id: 'other', name: 'X', specialtyName: 'Medicina General' }); // prettier-ignore
    await expect(
      catalogue.updateService(
        'service-1',
        { active: true },
        requester,
        noOrderKeyNeeded,
      ),
    ).rejects.toBeInstanceOf(ConsultationDuplicateError);
  });

  it('BI-279 una consulta sin especialidad, sin duración o con una especialidad desactivada se rechaza', async () => {
    const { service: catalogue, mocks } = build();
    const withoutSpecialty = { ...newConsultation, specialtyId: undefined };
    const withoutDuration = { ...newConsultation, durationMinutes: undefined };

    await expect(catalogue.createService(withoutSpecialty, requester)).rejects.toBeInstanceOf(ConsultationIncompleteError); // prettier-ignore
    await expect(catalogue.createService(withoutDuration, requester)).rejects.toBeInstanceOf(ConsultationIncompleteError); // prettier-ignore
    mocks.specialtyIsActive.mockResolvedValueOnce(false);
    await expect(catalogue.createService(newConsultation, requester)).rejects.toBeInstanceOf(ConsultationIncompleteError); // prettier-ignore
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('BI-279 SP-021 la duración es múltiplo del turno de todas las sedes', async () => {
    const { service: catalogue, mocks } = build({
      siteSlotAtoms: vi.fn().mockResolvedValue([10, 15]),
    });

    await expect(catalogue.createService(newConsultation, requester)).rejects.toBeInstanceOf(DurationNotSlotMultipleError); // prettier-ignore
    // Control: 30 tiles 10 and 15.
    await catalogue.createService({ ...newConsultation, durationMinutes: 30 }, requester); // prettier-ignore
    expect(mocks.createService).toHaveBeenCalledTimes(1);
  });

  it('BI-279 lo que no es consulta no lleva especialidad, duración ni visita', async () => {
    const { service: catalogue, mocks } = build();

    await expect(
      catalogue.createService({ ...newSupply, specialtyId: 'specialty-cardiology' }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
    await expect(
      catalogue.createService({ ...newSupply, visitKind: 'FOLLOW_UP' }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('BI-279 corregir la duración de una consulta vuelve a validar el turno; en un insumo se rechaza', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.updateService('service-1', { durationMinutes: 40 }, requester, noOrderKeyNeeded); // prettier-ignore
    expect(mocks.updateService.mock.calls[0]![1]).toMatchObject({
      consultation: { specialtyId: 'specialty-general', durationMinutes: 40, visitKind: 'FIRST_VISIT' }, // prettier-ignore
    });

    mocks.findService.mockResolvedValueOnce({ ...service, kind: 'SUPPLY', consultation: null }); // prettier-ignore
    await expect(
      catalogue.updateService(
        'service-1',
        { durationMinutes: 40 },
        requester,
        noOrderKeyNeeded,
      ),
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });

  it('BI-279 renombrar una consulta que repite su especialidad, duración y visita no las vuelve a validar', async () => {
    const { service: catalogue, mocks } = build();
    const current = service.consultation!;

    await catalogue.updateService(
      'service-1',
      {
        name: 'Consulta renombrada',
        specialtyId: current.specialtyId,
        durationMinutes: current.durationMinutes,
        visitKind: current.visitKind,
      },
      requester,
      noOrderKeyNeeded,
    );

    // A deactivated specialty or a new slot size elsewhere must not block a
    // rename: nothing of the consultation changed.
    expect(mocks.updateService.mock.calls[0]![1]).not.toHaveProperty('consultation'); // prettier-ignore
  });
});

describe('BI-284 la extensión de orden', () => {
  it('BI-284 un examen nace siempre con su extensión, con los valores por defecto donde no se dicen', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(
      {
        kind: 'LAB_EXAM',
        name: 'Glucosa en ayunas',
        selfPayAmount: Money.parse('4.00'),
        mspCode: null,
        exam: { specimenType: 'Suero', requiresFasting: true, fastingHours: 8 },
      },
      requester,
    );

    expect(created(mocks).exam).toEqual({
      form010Section: null,
      specimenType: 'Suero',
      patientPreparation: null,
      turnaroundHours: null,
      requiresFasting: true,
      fastingHours: 8,
      performedExternally: true,
      externalLabName: null,
      externalLabCode: null,
    });
  });

  it('BI-284 un procedimiento la lleva sólo si se pide en una orden; un insumo nunca', async () => {
    const { service: catalogue, mocks } = build();
    const procedure = {
      kind: 'PROCEDURE' as const,
      name: 'Curación',
      selfPayAmount: Money.parse('15.00'),
      mspCode: null,
    };

    await catalogue.createService(procedure, requester);
    await catalogue.createService({ ...procedure, name: 'ECG', exam: {} }, requester); // prettier-ignore
    expect(
      (mocks.createService.mock.calls[0]![0] as NewService).exam,
    ).toBeNull();
    expect(
      (mocks.createService.mock.calls[1]![0] as NewService).exam,
    ).not.toBeNull();

    await expect(
      catalogue.createService({ ...newSupply, exam: {} }, requester),
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);
  });

  it('BI-284 corregir cambia sólo los campos enviados; un examen no la pierde y un procedimiento sí', async () => {
    const { service: catalogue, mocks } = build({
      findService: vi.fn().mockResolvedValue(examService),
    });

    await catalogue.updateService('service-1', { exam: { turnaroundHours: 24, specimenType: undefined } }, requester, noOrderKeyNeeded); // prettier-ignore
    expect(mocks.updateService.mock.calls[0]![1]).toMatchObject({ exam: { turnaroundHours: 24 } }); // prettier-ignore
    expect((mocks.updateService.mock.calls[0]![1] as { exam: object }).exam).not.toHaveProperty('specimenType'); // prettier-ignore

    await expect(
      catalogue.updateService(
        'service-1',
        { exam: null },
        requester,
        noOrderKeyNeeded,
      ),
    ).rejects.toBeInstanceOf(ServiceKindMismatchError);

    mocks.findService.mockResolvedValueOnce({ ...procedureService, exam: examService.exam }); // prettier-ignore
    await catalogue.updateService(
      'service-1',
      { exam: null },
      requester,
      noOrderKeyNeeded,
    );
    expect(mocks.updateService.mock.calls[1]![1]).toMatchObject({ exam: null });
  });

  it('BI-299 renombrar, recodificar o desactivar un examen pide la llave del catálogo antes que nada; lo mismo sin cambio, o en una consulta, no (D-233)', async () => {
    const { service: catalogue, mocks } = build({
      findService: vi.fn().mockResolvedValue(examService),
    });
    const refused = new Error('catalog:manage');
    const requireOrderKey = vi.fn(() => {
      throw refused;
    });

    for (const correction of [
      { name: `${examService.name} 2` },
      { code: 'LAB-OTRO' },
      { active: !examService.active },
    ]) {
      await expect(
        catalogue.updateService('service-1', correction, requester, requireOrderKey), // prettier-ignore
      ).rejects.toBe(refused);
    }
    expect(mocks.updateService).not.toHaveBeenCalled();
    expect(mocks.hasInvoicedCharges).not.toHaveBeenCalled();
    expect(mocks.codeWasOrdered).not.toHaveBeenCalled();

    // What the form sends unchanged, and the rest of the exam, does not ask.
    await catalogue.updateService('service-1', { name: examService.name, code: examService.code, active: examService.active, taxRateId: taxRate.id }, requester, requireOrderKey); // prettier-ignore
    mocks.findService.mockResolvedValueOnce(service);
    await catalogue.updateService('service-1', { name: 'Otra', active: false }, requester, requireOrderKey); // prettier-ignore
    expect(requireOrderKey).toHaveBeenCalledTimes(3);
    expect(mocks.updateService).toHaveBeenCalledTimes(2);
  });

  it('BI-284 un procedimiento ya pedido en una orden no deja de pedirse: sus líneas perderían su estructura', async () => {
    const { service: catalogue, mocks } = build({
      findService: vi.fn().mockResolvedValue({ ...procedureService, exam: examService.exam }), // prettier-ignore
    });
    mocks.codeWasOrdered.mockResolvedValueOnce(true);

    await expect(
      catalogue.updateService(
        'service-1',
        { exam: null },
        requester,
        noOrderKeyNeeded,
      ),
    ).rejects.toBeInstanceOf(ServiceCodeOrderedError);
    expect(mocks.updateService).not.toHaveBeenCalled();
  });
});

describe('BI-281 BI-285 los códigos que ya salieron en papel no cambian', () => {
  it('BI-281 el código se corrige mientras nadie lo facturó ni lo pidió', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.updateService('service-1', { code: 'CONS-MG-1' }, requester, noOrderKeyNeeded); // prettier-ignore
    expect(mocks.updateService.mock.calls[0]![1]).toMatchObject({ code: 'CONS-MG-1' }); // prettier-ignore

    mocks.hasInvoicedCharges.mockResolvedValueOnce(true);
    await expect(catalogue.updateService('service-1', { code: 'CONS-MG-2' }, requester, noOrderKeyNeeded)).rejects.toBeInstanceOf(ServiceCodeInvoicedError); // prettier-ignore
    mocks.codeWasOrdered.mockResolvedValueOnce(true);
    await expect(catalogue.updateService('service-1', { code: 'CONS-MG-2' }, requester, noOrderKeyNeeded)).rejects.toBeInstanceOf(ServiceCodeOrderedError); // prettier-ignore
  });

  it('BI-285 el Código MSP es opcional y no cambia si el servicio ya se facturó', async () => {
    const { service: catalogue, mocks } = build({
      findService: vi.fn().mockResolvedValue(examService),
    });

    await catalogue.updateService('service-1', { mspCode: ' 360009 ' }, requester, noOrderKeyNeeded); // prettier-ignore
    expect(mocks.updateService.mock.calls[0]![1]).toMatchObject({ mspCode: '360009' }); // prettier-ignore
    // An exam's MSP code is nomenclature: it is not checked against the tariff.
    expect(mocks.isTariffProcedureCode).not.toHaveBeenCalled();

    mocks.hasInvoicedCharges.mockResolvedValueOnce(true);
    await expect(catalogue.updateService('service-1', { mspCode: '360010' }, requester, noOrderKeyNeeded)).rejects.toBeInstanceOf(ServiceTariffCodeInvoicedError); // prettier-ignore
  });
});

describe('BI-286 el procedimiento se ata por su código', () => {
  it('BI-286 el código de un procedimiento es del tarifario y no lo lleva otro procedimiento activo', async () => {
    const { service: catalogue, mocks } = build();
    const procedure = {
      kind: 'PROCEDURE' as const,
      name: 'Biopsia',
      selfPayAmount: Money.parse('40.00'),
      mspCode: '10120',
    };

    await catalogue.createService(procedure, requester);
    expect(mocks.procedureCodeTakenByOther).toHaveBeenCalledWith('10120', null);

    mocks.isTariffProcedureCode.mockResolvedValueOnce(false);
    await expect(catalogue.createService(procedure, requester)).rejects.toBeInstanceOf(ServiceProcedureNotInTariffError); // prettier-ignore
    mocks.procedureCodeTakenByOther.mockResolvedValueOnce(true);
    await expect(catalogue.createService(procedure, requester)).rejects.toBeInstanceOf(ServiceProcedureTakenError); // prettier-ignore
  });
});

describe('BI-288 retirar un servicio', () => {
  it('BI-288 se niega a borrar un servicio que nombran cargos, citas u órdenes', async () => {
    const { service: catalogue, mocks } = build({
      countReferencesToService: vi.fn().mockResolvedValue(2),
    });

    await expect(
      catalogue.deleteService('service-1', requester, noOrderKeyNeeded),
    ).rejects.toBeInstanceOf(BillableServiceInUseError);
    expect(mocks.deleteService).not.toHaveBeenCalled();
  });

  it('BI-288 lo borra cuando nadie lo ha usado, y deja en la bitácora lo que había', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.deleteService('service-1', requester, noOrderKeyNeeded);

    expect(mocks.deleteService).toHaveBeenCalledWith('service-1');
    const entry = mocks.record.mock.calls[0]![0] as AccessAuditEntry;
    expect(entry).toMatchObject({ resourceType: 'service', before: { code: 'CONS-MG-PV' } }); // prettier-ignore
  });

  it('BI-288 responde 404 ante un servicio inexistente antes de tocar nada', async () => {
    const { service: catalogue, mocks } = build({
      findService: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.deleteService('missing', requester, noOrderKeyNeeded),
    ).rejects.toBeInstanceOf(BillableServiceNotFoundError);
    expect(mocks.countReferencesToService).not.toHaveBeenCalled();
  });
});

describe('BI-290 la bitácora del catálogo', () => {
  it('BI-290 registra el alta con lo que dejó, sin ningún importe en la fila', async () => {
    const { service: catalogue, mocks } = build();

    await catalogue.createService(newSupply, requester);

    const entry = mocks.record.mock.calls[0]![0] as AccessAuditEntry;
    expect(entry).toMatchObject({
      userId: 'user-1',
      resourceType: 'service',
      action: 'CREATE',
      after: { code: 'CONS-MG-PV', kind: 'CONSULTATION', specialtyId: 'specialty-general' }, // prettier-ignore
    });
    expect(entry.after).not.toHaveProperty('amount');
  });

  it('BI-290 una corrección deja el antes y el después', async () => {
    const { service: catalogue, mocks } = build({
      updateService: vi.fn().mockResolvedValue({ ...service, name: 'Consulta general' }), // prettier-ignore
    });

    await catalogue.updateService('service-1', { name: 'Consulta general' }, requester, noOrderKeyNeeded); // prettier-ignore

    const entry = mocks.record.mock.calls[0]![0] as AccessAuditEntry;
    expect(entry).toMatchObject({
      action: 'UPDATE',
      before: { name: 'Consulta de medicina general · Primera vez' },
      after: { name: 'Consulta general' },
    });
  });
});

describe('BI-283 la ficha en una respuesta', () => {
  it('BI-283 trae las determinaciones sólo de lo que se pide, y los precios marcando el vigente', async () => {
    const today = clinicalDateOf(new Date());
    const { service: catalogue, mocks } = build();
    await catalogue.serviceDetail('service-1', today);
    expect(mocks.listAnalytesOfService).not.toHaveBeenCalled();

    mocks.findService.mockResolvedValueOnce(examService);
    mocks.listPricesAcrossPayers.mockResolvedValueOnce([
      {
        priceId: 'price-1',
        payer: { id: 'payer-self', name: 'Particular', kind: 'SELF_PAY' },
        amount: Money.parse('4.00'),
        validFrom: addDays(today, -30),
        validTo: null,
      },
    ]);
    const detail = await catalogue.serviceDetail('service-1', today);
    expect(mocks.listAnalytesOfService).toHaveBeenCalledWith('service-1');
    expect(detail.prices[0]!.inForce).toBe(true);
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
  it('BI-024 un servicio nuevo no nace revisado: nada en el alta escribe la revisión', async () => {
    const { service: catalogue, mocks } = build(withReview());

    await catalogue.createService(newSupply, requester);

    expect(mocks.createService.mock.calls[0]?.[0]).not.toHaveProperty(
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
      resourceType: 'service',
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
      findService: vi
        .fn()
        .mockResolvedValue({ ...service, taxReview: reviewed }),
    });

    await catalogue.updateService('service-1', { taxRateId: 'tax-15' }, requester, noOrderKeyNeeded); // prettier-ignore

    expect(mocks.updateService.mock.calls[0]?.[1]).toMatchObject({
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
      findService: vi
        .fn()
        .mockResolvedValue({ ...service, taxReview: reviewed }),
    });

    await catalogue.updateService('service-1', { name: 'Consulta general' }, requester, noOrderKeyNeeded); // prettier-ignore
    await catalogue.updateService('service-1', { taxRateId: 'tax-0' }, requester, noOrderKeyNeeded); // prettier-ignore

    for (const [, update] of mocks.updateService.mock.calls) {
      expect(update).not.toHaveProperty('taxReview');
    }
  });

  it('BI-024 marcar revisado un servicio inexistente responde 404 sin escribir', async () => {
    const { service: catalogue, mocks } = build({
      ...withReview(),
      findService: vi.fn().mockResolvedValue(null),
    });

    await expect(
      catalogue.markTaxReviewed('missing', 'tax-0', reviewer),
    ).rejects.toBeInstanceOf(BillableServiceNotFoundError);
    expect(mocks.markTaxReviewed).not.toHaveBeenCalled();
  });
});

describe('BI-256 la marca «exige consentimiento 024» la pone la dirección médica', () => {
  it('BI-256 marca con quién y cuándo, del reloj de la aplicación, y deja el servicio antes y después en la bitácora', async () => {
    const marked: ServiceView = {
      ...procedureService,
      writtenConsent: { required: true, setAt: new Date(), setById: 'user-1', setByName: 'Ana Villacís' }, // prettier-ignore
    };
    const { service: catalogue, mocks } = build({
      findService: vi.fn().mockResolvedValue(procedureService),
      updateService: vi.fn().mockResolvedValue(marked),
    });
    const before = Date.now();

    await expect(catalogue.markWrittenConsent('service-1', true, requester)).resolves.toBe(marked); // prettier-ignore

    const [, update] = mocks.updateService.mock.calls[0]!;
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
      resourceType: 'service',
      action: 'UPDATE',
      before: expect.objectContaining({ requiresWrittenConsent: false }),
      after: expect.objectContaining({ requiresWrittenConsent: true, writtenConsentSetById: 'user-1' }), // prettier-ignore
    });
  });

  it('BI-256 rechaza marcar un servicio que no es un procedimiento con su código; ponerlo como ya está no escribe nada', async () => {
    const { service: catalogue, mocks } = build();
    await expect(
      catalogue.markWrittenConsent('service-1', true, requester),
    ).rejects.toBeInstanceOf(ServiceNotAProcedureError);

    // Control positivo: desmarcar la que ya está apagada no es un cambio.
    await expect(catalogue.markWrittenConsent('service-1', false, requester)).resolves.toBe(service); // prettier-ignore
    expect(mocks.updateService).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('BI-256 D-199.1 el código de un procedimiento marcado no se cambia, no se quita ni se borra con la llave de precios', async () => {
    const { service: catalogue } = build({
      findService: vi.fn().mockResolvedValue({
        ...procedureService,
        writtenConsent: { required: true, setAt: new Date(), setById: 'user-1', setByName: 'Ana Villacís' }, // prettier-ignore
      }),
    });
    await expect(
      catalogue.updateService('service-1', { mspCode: null }, requester, noOrderKeyNeeded), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceConsentTieLockedError);
    await expect(
      catalogue.updateService('service-1', { mspCode: '10121' }, requester, noOrderKeyNeeded), // prettier-ignore
    ).rejects.toBeInstanceOf(ServiceConsentTieLockedError);
    await expect(catalogue.deleteService('service-1', requester, noOrderKeyNeeded)).rejects.toBeInstanceOf(ServiceConsentTieLockedError); // prettier-ignore
    // Control positivo: renombrarla sí.
    await expect(catalogue.updateService('service-1', { name: 'Biopsia' }, requester, noOrderKeyNeeded)).resolves.toBeDefined(); // prettier-ignore
  });
});
