import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  AccountView,
  BillingAccountRepository,
  BillingCatalogueRepository,
  ChargeView,
  NewAccount,
  NewCharge,
} from '../domain/billing.repository';
import {
  ActAlreadyChargedError,
  BillingEncounterNotFoundError,
  PayerRequiredToOpenAccountError,
  PriceNotFoundError,
} from '../domain/billing.errors';
import type {
  ClinicalActsRepository,
  EncounterActs,
} from '../domain/clinical-acts.port';
import { Money, Percentage, Quantity } from '../domain/money';

import { EncounterCheckoutService } from './encounter-checkout.service';
import { PatientAccountService } from './patient-account.service';

/**
 * THE STEP FROM THE CONSULTATION TO THE CASHIER, at the level where it decides.
 *
 * What these doubles cannot prove — that two simultaneous presses cannot write
 * the same charge twice — is asserted against a real PostgreSQL in
 * `test/integration/billing-checkout.spec.ts`. The three partial unique
 * indexes are the guarantee; a mock returning what we told it to would be the
 * test checking its own double.
 */

const SITE = 'site-1';
const ENCOUNTER = 'encounter-1';
const VISIT_DATE = parseClinicalDate('2026-09-14');

const acts = (overrides: Partial<EncounterActs> = {}): EncounterActs => ({
  encounterId: ENCOUNTER,
  siteId: SITE,
  patientId: 'patient-1',
  status: 'DISCHARGED',
  serviceDate: VISIT_DATE,
  visitSequence: 'FIRST_TIME',
  specialtyId: 'specialty-dermatology',
  procedures: [],
  exams: [],
  ...overrides,
});

const account = (overrides: Partial<AccountView> = {}): AccountView => ({
  id: 'account-1',
  siteId: SITE,
  patientId: 'patient-1',
  encounterId: ENCOUNTER,
  payerId: 'payer-particular',
  priceListId: 'list-particular',
  status: 'OPEN',
  openedAt: new Date('2026-09-14T19:00:00Z'),
  closedAt: null,
  ...overrides,
});

const charge = (overrides: Partial<ChargeView> = {}): ChargeView => ({
  id: 'charge-1',
  accountId: 'account-1',
  billableServiceId: 'service-consultation',
  encounterId: ENCOUNTER,
  serviceDate: VISIT_DATE,
  quantity: Quantity.ONE,
  unitAmount: Money.parse('50.00'),
  resolvedPriceId: 'price-1',
  serviceDisplay: 'Consulta de dermatología, primera vez',
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  discountAmount: Money.ZERO,
  discountReason: null,
  discountAuthorisedById: null,
  status: 'PLANNED',
  createdById: 'user-1',
  origin: 'CONSULTATION',
  encounterProcedureId: null,
  serviceOrderItemId: null,
  voidedAt: null,
  voidReason: null,
  ...overrides,
});

function build(options: { ports?: Record<string, unknown> } = {}) {
  const mocks = {
    // Clinical acts, READ ONLY.
    findEncounterActs: vi.fn().mockResolvedValue(acts()),

    // The account side.
    findOpenAccountOfEncounter: vi.fn().mockResolvedValue(account()),
    openAccount: vi.fn().mockImplementation((data: NewAccount) => Promise.resolve(account(data))), // prettier-ignore
    findAccount: vi.fn().mockResolvedValue(account()),
    listCharges: vi.fn().mockResolvedValue([]),
    listChargedActs: vi.fn().mockResolvedValue({
      consultation: false,
      encounterProcedureIds: [],
      serviceOrderItemIds: [],
    }),
    addCharge: vi.fn().mockImplementation(
      (command: NewCharge) =>
        Promise.resolve(charge({ status: command.status, origin: command.origin })), // prettier-ignore
    ),

    // The catalogue side.
    findConsultationService: vi
      .fn()
      .mockResolvedValue({ billableServiceId: 'service-consultation', active: true }), // prettier-ignore
    findServicesByProcedureConcept: vi.fn().mockResolvedValue(new Map()),
    findServicesByExamCode: vi.fn().mockResolvedValue(new Map()),
    findPayer: vi.fn().mockResolvedValue({
      id: 'payer-particular',
      code: 'PARTICULAR',
      name: 'Particular',
      kind: 'SELF_PAY',
      ruc: null,
      agreementReference: null,
      agreementValidTo: null,
      active: true,
    }),
    findPriceListOfPayer: vi.fn().mockResolvedValue({
      id: 'list-particular',
      name: 'Particular',
      payerId: 'payer-particular',
      siteId: null,
      publiclyListed: true,
      active: true,
    }),
    findBillableService: vi.fn().mockResolvedValue(null),
    ...options.ports,
  };

  const actsPort = mocks as unknown as ClinicalActsRepository;
  const accounts = mocks as unknown as BillingAccountRepository;
  const catalogue = mocks as unknown as BillingCatalogueRepository;

  return {
    service: new EncounterCheckoutService(
      actsPort,
      accounts,
      catalogue,
      new PatientAccountService(accounts, catalogue),
    ),
    mocks,
  };
}

const press = (
  service: EncounterCheckoutService,
  payerId?: string,
): ReturnType<EncounterCheckoutService['sendToCashier']> =>
  service.sendToCashier({
    siteId: SITE,
    encounterId: ENCOUNTER,
    payerId,
    userId: 'user-1',
  });

describe('BI-150 el paso de la consulta a la caja', () => {
  it('BI-150 recupera la cuenta abierta de la atención en vez de abrir otra', async () => {
    const { service, mocks } = build();

    await press(service, 'payer-particular');

    expect(mocks.openAccount).not.toHaveBeenCalled();
  });

  it('BI-150 abre la cuenta con el paciente DE LA ATENCIÓN, nunca con uno del cuerpo', async () => {
    // Taking the patient from the request would let the account of one
    // person's visit be opened on another person's chart — and an account is
    // what an invoice is made out from.
    const { service, mocks } = build({
      ports: { findOpenAccountOfEncounter: vi.fn().mockResolvedValue(null) },
    });

    await press(service, 'payer-particular');

    expect(mocks.openAccount).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'patient-1', encounterId: ENCOUNTER }), // prettier-ignore
    );
  });

  it('BI-150 pide quién paga sólo cuando todavía no hay cuenta', async () => {
    const { service } = build({
      ports: { findOpenAccountOfEncounter: vi.fn().mockResolvedValue(null) },
    });

    await expect(press(service)).rejects.toBeInstanceOf(
      PayerRequiredToOpenAccountError,
    );
  });

  it('BI-135 responde igual ante una atención de otra sede que ante una inexistente', async () => {
    const { service } = build({
      ports: { findEncounterActs: vi.fn().mockResolvedValue(null) },
    });

    await expect(press(service)).rejects.toBeInstanceOf(
      BillingEncounterNotFoundError,
    );
  });
});

describe('BI-152 propone, no impone', () => {
  it('BI-152 registra los cargos derivados como PROPUESTA y no como facturables', async () => {
    // `issueInvoice` only ever takes BILLABLE rows, so a visit that went
    // through here is not invoiceable until a person confirmed each line. A
    // system that billed what it deduced overcharges the day the catalogue is
    // wrong, and the person overcharged is a patient with no way of knowing.
    const { service, mocks } = build();

    await press(service, 'payer-particular');

    expect(mocks.addCharge).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PLANNED', origin: 'CONSULTATION' }),
    );
  });

  it('BI-152 separa en el extracto lo propuesto de lo que ya se puede facturar', async () => {
    const { service } = build({
      ports: {
        listCharges: vi
          .fn()
          .mockResolvedValue([
            charge({ id: 'charge-1', status: 'PLANNED' }),
            charge({ id: 'charge-2', status: 'BILLABLE' }),
          ]),
      },
    });

    const result = await press(service, 'payer-particular');

    expect(result.statement.totals.total.toString()).toBe('100.00');
    expect(result.statement.proposedTotals.total.toString()).toBe('50.00');
  });
});

describe('BI-154 pulsar dos veces no duplica cargos', () => {
  it('BI-154 no escribe nada en la segunda pulsación', async () => {
    const { service, mocks } = build({
      ports: {
        listChargedActs: vi.fn().mockResolvedValue({
          consultation: true,
          encounterProcedureIds: [],
          serviceOrderItemIds: [],
        }),
      },
    });

    const result = await press(service, 'payer-particular');

    expect(mocks.addCharge).not.toHaveBeenCalled();
    expect(result.raisedChargeIds).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: 'ALREADY_CHARGED' }),
    ]);
  });

  it('BI-154 informa como duplicado el rechazo de la base, en vez de fallar entero', async () => {
    // Two cashiers pressing in the same second: the index refuses the second
    // write, which is the guarantee working. A race that resolves itself
    // correctly is not an incident.
    const { service } = build({
      ports: {
        addCharge: vi.fn().mockRejectedValue(new ActAlreadyChargedError()),
      },
    });

    const result = await press(service, 'payer-particular');

    expect(result.raisedChargeIds).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: 'ALREADY_CHARGED' }),
    ]);
  });
});

describe('BI-155 una línea sin precio no cuesta el resto de la visita', () => {
  it('BI-155 informa la línea sin precio vigente y sigue con las demás', async () => {
    const { service } = build({
      ports: {
        findServicesByProcedureConcept: vi.fn().mockResolvedValue(
          new Map([['concept-suture', { billableServiceId: 'service-suture', active: true }]]), // prettier-ignore
        ),
        findEncounterActs: vi.fn().mockResolvedValue(
          acts({
            procedures: [
              {
                encounterProcedureId: 'procedure-1',
                conceptId: 'concept-suture',
                serviceDate: VISIT_DATE,
                quantity: 1,
              },
            ],
          }),
        ),
        addCharge: vi
          .fn()
          .mockImplementationOnce((command: NewCharge) =>
            Promise.resolve(charge({ status: command.status })),
          )
          .mockRejectedValueOnce(
            new PriceNotFoundError('service-suture', 'payer-particular', VISIT_DATE), // prettier-ignore
          ),
      },
    });

    const result = await press(service, 'payer-particular');

    expect(result.raisedChargeIds).toEqual(['charge-1']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        origin: 'PROCEDURE',
        encounterProcedureId: 'procedure-1',
        reason: 'NO_PRICE_FOR_DATE',
      }),
    ]);
  });
});

describe('BI-156 el cobro nunca reescribe ni condiciona lo clínico', () => {
  it('BI-156 no expone ningún método que decida sobre la atención', () => {
    // Ley 77 art. 9. The way a system conditions care on payment is never a
    // decision: it is a method somebody calls from the wrong screen. What is
    // asserted is the SHAPE — one public use case, and it answers «what does
    // this visit suggest charging for», never «may this visit be closed».
    const surface = Object.getOwnPropertyNames(
      EncounterCheckoutService.prototype,
    ).filter((name) => name !== 'constructor');

    expect(surface.sort()).toEqual([
      'accountOf',
      'chargedActs',
      'mappingFor',
      'raise',
      'sendToCashier',
    ]);
  });

  it('BI-004, BI-156 lee los actos clínicos y no escribe ni uno', async () => {
    // The port it reads through has no write method at all, which is what
    // stops «money never touches the clinical record» from being a matter of
    // discipline. Here the assertion is that the only thing asked of it is a
    // read.
    const { service, mocks } = build();

    await press(service, 'payer-particular');

    expect(Object.keys(mocks).filter((name) => /^(create|update|delete)/.test(name))).toEqual([]); // prettier-ignore
    expect(mocks.findEncounterActs).toHaveBeenCalledWith({
      encounterId: ENCOUNTER,
      siteId: SITE,
    });
  });
});
