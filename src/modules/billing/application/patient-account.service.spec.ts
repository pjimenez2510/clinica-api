import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import {
  AccountClosedError,
  AccountHasChargesError,
  AccountHasOpenChargesError,
  AccountNotFoundError,
  BillableServiceInactiveError,
  PayerInactiveError,
  PriceListNotFoundError,
} from '../domain/billing.errors';
import type {
  AccountView,
  BillableServiceView,
  BillingAccountRepository,
  BillingCatalogueRepository,
  ChargeView,
  NewAccount,
  PayerView,
} from '../domain/billing.repository';
import type { ChargeStatus } from '../domain/charge';
import { Money, Percentage, Quantity } from '../domain/money';
import { PatientAccountService } from './patient-account.service';

const SITE = 'site-1';
const ACCOUNT = 'account-1';
const SERVICE_DATE = parseClinicalDate('2026-05-11');

const account = (overrides: Partial<AccountView> = {}): AccountView => ({
  id: ACCOUNT,
  siteId: SITE,
  patientId: 'patient-1',
  patient: {
    id: 'patient-1',
    mrn: 'HC0000000001',
    familyName: 'Guamán',
    secondFamilyName: null,
    givenName: 'María',
    secondGivenName: null,
    document: { type: 'CEDULA', value: '1710034065' },
  },
  encounterId: null,
  payerId: 'payer-particular',
  priceListId: 'list-particular',
  status: 'OPEN',
  openedAt: new Date('2026-05-11T14:00:00Z'),
  closedAt: null,
  ...overrides,
});

const charge = (
  id: string,
  status: ChargeStatus,
  overrides: Partial<ChargeView> = {},
): ChargeView => ({
  id,
  accountId: ACCOUNT,
  billableServiceId: 'service-1',
  encounterId: null,
  serviceDate: SERVICE_DATE,
  quantity: Quantity.ONE,
  unitAmount: Money.parse('30.00'),
  resolvedPriceId: 'price-1',
  serviceDisplay: 'Consulta de medicina general, primera vez',
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  discountAmount: Money.ZERO,
  discountReason: null,
  discountAuthorisedById: null,
  status,
  createdById: 'user-1',
  origin: 'MANUAL',
  encounterProcedureId: null,
  serviceOrderItemId: null,
  voidedAt: null,
  voidReason: null,
  ...overrides,
});

const service = (
  overrides: Partial<BillableServiceView> = {},
): BillableServiceView => ({
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
  ...overrides,
});

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

/**
 * The two ports as doubles, with every mock held in a NAMED local.
 *
 * Not `expect(port.method)`: reading a method off an interface-typed object
 * without calling it is what `@typescript-eslint/unbound-method` refuses, and
 * it refuses it for a real reason — the extracted function would lose `this`
 * if it were ever called. Naming them is also what lets an assertion say which
 * collaborator was touched, which is half of what these tests claim.
 */
function build(
  options: {
    accounts?: Record<string, unknown>;
    catalogue?: Record<string, unknown>;
  } = {},
) {
  const mocks = {
    findAccount: vi.fn().mockResolvedValue(account()),
    listCharges: vi.fn().mockResolvedValue([]),
    openAccount: vi.fn().mockImplementation((data: NewAccount) => Promise.resolve(account(data))), // prettier-ignore
    changeAccountPayer: vi.fn().mockResolvedValue(account({ payerId: 'payer-iess' })), // prettier-ignore
    closeAccount: vi.fn().mockResolvedValue(account({ status: 'SETTLED' })),
    addCharge: vi.fn().mockResolvedValue(charge('charge-1', 'BILLABLE')),
    listAccounts: vi.fn().mockResolvedValue([]),
    findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'PLANNED')),
    confirmCharge: vi.fn().mockResolvedValue(charge('charge-1', 'BILLABLE')),
    voidCharge: vi.fn().mockResolvedValue(charge('charge-1', 'CANCELLED')),
    findBillableService: vi.fn().mockResolvedValue(service()),
    findPayer: vi.fn().mockResolvedValue(payer()),
    findPriceListOfPayer: vi.fn().mockResolvedValue({
      id: 'list-particular',
      name: 'Particular',
      payerId: 'payer-particular',
      siteId: null,
      publiclyListed: true,
      active: true,
    }),
    ...options.accounts,
    ...options.catalogue,
  };

  return {
    service: new PatientAccountService(
      mocks as unknown as BillingAccountRepository,
      mocks as unknown as BillingCatalogueRepository,
    ),
    mocks,
  };
}

describe('BI-070 abrir la cuenta con su pagador decidido al llegar', () => {
  it('BI-070 fija la lista de precios del pagador al abrir la cuenta', async () => {
    // Asking who pays at the cashier is asking too late: the payer decides the
    // price of everything that happened before the question.
    const { service: accounts, mocks } = build();

    await accounts.openAccount({
      siteId: SITE,
      patientId: 'patient-1',
      encounterId: null,
      payerId: 'payer-particular',
    });

    expect(mocks.openAccount).toHaveBeenCalledWith(
      expect.objectContaining({ priceListId: 'list-particular' }),
    );
  });

  it('BI-030 rechaza abrir una cuenta con un pagador desactivado', async () => {
    const { service: accounts } = build({
      catalogue: { findPayer: vi.fn().mockResolvedValue(payer({ active: false })) }, // prettier-ignore
    });

    await expect(
      accounts.openAccount({
        siteId: SITE,
        patientId: 'patient-1',
        encounterId: null,
        payerId: 'payer-particular',
      }),
    ).rejects.toBeInstanceOf(PayerInactiveError);
  });

  it('BI-040 rechaza abrir la cuenta de un pagador que aún no tiene tarifario', async () => {
    const { service: accounts } = build({
      catalogue: { findPriceListOfPayer: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      accounts.openAccount({
        siteId: SITE,
        patientId: 'patient-1',
        encounterId: null,
        payerId: 'payer-particular',
      }),
    ).rejects.toBeInstanceOf(PriceListNotFoundError);
  });

  it('BI-054 admite una cuenta sin atención asociada', async () => {
    // The counter sale exists: a supply, a copy of the chart, a certificate
    // asked for without a consultation.
    const { service: accounts, mocks } = build();

    await accounts.openAccount({
      siteId: SITE,
      patientId: 'patient-1',
      encounterId: null,
      payerId: 'payer-particular',
    });

    expect(mocks.openAccount).toHaveBeenCalledWith(
      expect.objectContaining({ encounterId: null }),
    );
  });
});

describe('BI-033 cambiar el pagador', () => {
  it('BI-033 lo permite mientras la cuenta no tenga ningún cargo', async () => {
    const { service: accounts, mocks } = build();

    await accounts.changePayer({
      accountId: ACCOUNT,
      siteId: SITE,
      payerId: 'payer-particular',
    });

    expect(mocks.changeAccountPayer).toHaveBeenCalled();
  });

  it('BI-033 lo rechaza en cuanto hay un cargo con el precio anterior congelado', async () => {
    // Letting it through would leave an account whose lines came out of two
    // different tariffs with nothing saying so.
    const { service: accounts } = build({
      accounts: {
        listCharges: vi
          .fn()
          .mockResolvedValue([charge('charge-1', 'BILLABLE')]),
      },
    });

    await expect(
      accounts.changePayer({ accountId: ACCOUNT, siteId: SITE, payerId: 'payer-iess' }), // prettier-ignore
    ).rejects.toBeInstanceOf(AccountHasChargesError);
  });
});

describe('BI-071, BI-072 cerrar la cuenta', () => {
  it('BI-072 enumera los cargos que impiden cerrarla, por identificador', async () => {
    const { service: accounts } = build({
      accounts: {
        listCharges: vi
          .fn()
          .mockResolvedValue([
            charge('charge-open', 'BILLABLE'),
            charge('charge-billed', 'BILLED'),
            charge('charge-void', 'CANCELLED'),
          ]),
      },
    });

    const thrown = await accounts
      .closeAccount({ accountId: ACCOUNT, siteId: SITE })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AccountHasOpenChargesError);
    // Identifiers and never names: the service name reaches the logs and is as
    // revealing as a diagnosis (BI-007).
    expect((thrown as AccountHasOpenChargesError).openChargeIds).toEqual([
      'charge-open',
    ]);
  });

  it('BI-072 cierra la cuenta cuando todo está facturado o anulado', async () => {
    const { service: accounts, mocks } = build({
      accounts: {
        listCharges: vi
          .fn()
          .mockResolvedValue([charge('charge-1', 'BILLED'), charge('charge-2', 'CANCELLED')]), // prettier-ignore
      },
    });

    await accounts.closeAccount({ accountId: ACCOUNT, siteId: SITE });
    expect(mocks.closeAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it('BI-071 rechaza todo cambio sobre una cuenta ya cerrada', async () => {
    const { service: accounts } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ status: 'SETTLED' })),
      },
    });

    await expect(
      accounts.addCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        billableServiceId: 'service-1',
        encounterId: null,
        serviceDate: SERVICE_DATE,
        quantity: Quantity.ONE,
        createdById: 'user-1',
      }),
    ).rejects.toBeInstanceOf(AccountClosedError);
  });

  it('BI-135 responde igual ante una cuenta inexistente y una de otra sede', async () => {
    // The repository answers `null` for both, because the site is part of the
    // key: an invoice or an account confirms that a patient was there.
    const { service: accounts } = build({
      accounts: { findAccount: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      accounts.statement({ accountId: ACCOUNT, siteId: 'another-site' }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

describe('BI-015, BI-074 los cargos de la cuenta', () => {
  it('BI-015 rechaza cobrar una prestación desactivada', async () => {
    const { service: accounts } = build({
      catalogue: {
        findBillableService: vi.fn().mockResolvedValue(service({ active: false })), // prettier-ignore
      },
    });

    await expect(
      accounts.addCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        billableServiceId: 'service-1',
        encounterId: null,
        serviceDate: SERVICE_DATE,
        quantity: Quantity.ONE,
        createdById: 'user-1',
      }),
    ).rejects.toBeInstanceOf(BillableServiceInactiveError);
  });

  it('BI-052 pasa al adaptador la fecha del acto, sin sustituirla por hoy', async () => {
    const { service: accounts, mocks } = build();

    await accounts.addCharge({
      accountId: ACCOUNT,
      siteId: SITE,
      billableServiceId: 'service-1',
      encounterId: 'encounter-1',
      serviceDate: SERVICE_DATE,
      quantity: Quantity.ONE,
      createdById: 'user-1',
    });

    expect(mocks.addCharge).toHaveBeenCalledWith(
      expect.objectContaining({ serviceDate: SERVICE_DATE }),
    );
  });

  it('BI-074 deriva el total de los cargos y deja fuera los anulados', async () => {
    const { service: accounts } = build({
      accounts: {
        listCharges: vi.fn().mockResolvedValue([
          charge('charge-1', 'BILLABLE'),
          charge('charge-2', 'BILLED', { unitAmount: Money.parse('20.00') }),
          // A cancelled charge stays on the statement and stops counting.
          charge('charge-3', 'CANCELLED', {
            unitAmount: Money.parse('999.00'),
          }),
          charge('charge-4', 'NOT_BILLABLE', { unitAmount: Money.parse('50.00') }), // prettier-ignore
        ]),
      },
    });

    const statement = await accounts.statement({
      accountId: ACCOUNT,
      siteId: SITE,
    });

    expect(statement.totals.total.toString()).toBe('50.00');
    // The row is kept, never deleted: it is on the statement.
    expect(statement.charges).toHaveLength(4);
  });

  it('BI-184 el total a facturar es sólo lo confirmado sin facturar: ni lo propuesto ni lo ya facturado', async () => {
    const { service: accounts } = build({
      accounts: {
        listCharges: vi
          .fn()
          .mockResolvedValue([
            charge('billed', 'BILLED'),
            charge('pending', 'BILLABLE', { unitAmount: Money.parse('15.00') }),
            charge('proposed', 'PLANNED'),
          ]),
      },
    });

    const statement = await accounts.statement({
      accountId: ACCOUNT,
      siteId: SITE,
    });

    expect(statement.invoiceableTotals.total.toString()).toBe('15.00');
    // Control: the account total still counts all three.
    expect(statement.totals.total.toString()).toBe('75.00');
  });

  it('BI-051 no consulta el catálogo ni el tarifario para totalizar una cuenta', async () => {
    // The JOIN to `price` is shorter, gives the same answer TODAY, and
    // rewrites history the day somebody raises a price. This asserts the
    // absence: totalling touches the catalogue port not once.
    const { service: accounts, mocks } = build({
      accounts: {
        listCharges: vi
          .fn()
          .mockResolvedValue([charge('charge-1', 'BILLABLE')]),
      },
    });

    await accounts.statement({ accountId: ACCOUNT, siteId: SITE });

    expect(mocks.findBillableService).not.toHaveBeenCalled();
    expect(mocks.findPriceListOfPayer).not.toHaveBeenCalled();
  });
});

describe('BI-055, BI-056, BI-059, BI-152 caja revisa lo propuesto', () => {
  it('BI-152 confirma una línea propuesta sin volver a resolver ni un importe', async () => {
    // The frozen block was written on the day of the act (BI-050, BI-052).
    // Re-resolving here would be the JOIN to `price` that BI-051 forbids, and
    // it would rewrite history the day somebody raises a tariff.
    const { service: accounts, mocks } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'PLANNED')),
        confirmCharge: vi
          .fn()
          .mockResolvedValue(charge('charge-1', 'BILLABLE')),
      },
    });

    const confirmed = await accounts.confirmCharge({
      accountId: ACCOUNT,
      siteId: SITE,
      chargeId: 'charge-1',
    });

    expect(confirmed.status).toBe('BILLABLE');
    expect(mocks.findBillableService).not.toHaveBeenCalled();
    expect(mocks.findPriceListOfPayer).not.toHaveBeenCalled();
  });

  it('BI-152 confirmar dos veces no es un error', async () => {
    // A refusal there would only teach people to ignore refusals.
    const { service: accounts, mocks } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'BILLABLE')),
        confirmCharge: vi.fn(),
      },
    });

    await accounts.confirmCharge({
      accountId: ACCOUNT,
      siteId: SITE,
      chargeId: 'charge-1',
    });

    expect(mocks.confirmCharge).not.toHaveBeenCalled();
  });

  it('BI-055 anula el cargo con su motivo y CONSERVA la fila', async () => {
    const { service: accounts, mocks } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'PLANNED')),
        voidCharge: vi.fn().mockResolvedValue(
          charge('charge-1', 'CANCELLED', {
            voidedAt: new Date('2026-09-14T20:00:00Z'),
            voidReason: 'La paciente no se realizó el examen',
          }),
        ),
      },
    });

    const voided = await accounts.voidCharge({
      accountId: ACCOUNT,
      siteId: SITE,
      chargeId: 'charge-1',
      reason: 'La paciente no se realizó el examen',
      voidedById: 'user-2',
    });

    expect(voided.status).toBe('CANCELLED');
    expect(voided.voidReason).toBe('La paciente no se realizó el examen');
    expect(mocks.voidCharge).toHaveBeenCalledWith({
      chargeId: 'charge-1',
      voidedById: 'user-2',
      reason: 'La paciente no se realizó el examen',
    });
  });

  it('BI-056 rechaza tocar un cargo ya facturado NOMBRANDO la salida', async () => {
    // A 409 that only says «ya facturado» leaves whoever is at the counter
    // looking for an «editar factura» button that does not exist.
    const { service: accounts } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'BILLED')),
      },
    });

    await expect(
      accounts.voidCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        chargeId: 'charge-1',
        reason: 'Se cobró de más',
        voidedById: 'user-2',
      }),
    ).rejects.toMatchObject({
      code: 'CHARGE_ITEM_ALREADY_INVOICED',
      userTitle: expect.stringContaining('nota de crédito'),
    });
  });

  it('BI-059 no admite que un cargo anulado vuelva', async () => {
    const { service: accounts } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'CANCELLED')),
      },
    });

    await expect(
      accounts.confirmCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        chargeId: 'charge-1',
      }),
    ).rejects.toMatchObject({ code: 'CHARGE_ALREADY_VOIDED' });
  });

  it('BI-004 anular un cargo no toca ningún dato clínico', async () => {
    // «Qué se hizo» y «qué se cobra» son dos registros. Este servicio no tiene
    // por dónde escribir en el clínico, y lo que se afirma es justo eso: el
    // único puerto que toca es el del dinero.
    const { service: accounts, mocks } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'BILLABLE')),
        voidCharge: vi.fn().mockResolvedValue(charge('charge-1', 'CANCELLED')),
      },
    });

    await accounts.voidCharge({
      accountId: ACCOUNT,
      siteId: SITE,
      chargeId: 'charge-1',
      reason: 'No se cobra: cortesía institucional',
      voidedById: 'user-2',
    });

    expect(Object.keys(mocks)).not.toContain('deleteEncounterProcedure');
    expect(mocks.findBillableService).not.toHaveBeenCalled();
  });
});

describe('BI-003, BI-120 el cobro no bloquea la atención', () => {
  it('BI-003 no expone ningún método que una operación clínica tenga que llamar', () => {
    // Ley 77 art. 9: it is forbidden to demand payment or a payment document
    // before receiving and stabilising an emergency patient. The way a system
    // breaks that is a required field on the wrong screen, so what is asserted
    // is the SHAPE of this service: nothing here answers «may this encounter
    // proceed / be closed / be signed», and nothing can grow one by accident
    // without this list changing.
    const surface = Object.getOwnPropertyNames(
      PatientAccountService.prototype,
    ).filter((name) => name !== 'constructor');

    expect(surface.sort()).toEqual([
      'addCharge',
      'changePayer',
      'closeAccount',
      // BI-152, BI-055. The cashier's review: «sí, esto se cobra» and «esto no
      // se cobra, y por esto». Both are decisions about MONEY taken by a
      // person, and neither is something a clinical flow calls or waits for.
      'confirmCharge',
      'listAccounts',
      'openAccount',
      'requireAccount',
      'requireOpenAccount',
      'requireOpenCharge',
      'resolvePriceList',
      'statement',
      'voidCharge',
    ]);
  });

  it('BI-121, BI-122 no exige motivo ni verificación de cobertura para registrar un cargo', async () => {
    // Deferring the charge of an emergency is not gated on anything: the
    // reason is the law, and a mandatory field at that moment is precisely the
    // friction art. 9 forbids.
    const { service: accounts } = build();

    await expect(
      accounts.addCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        billableServiceId: 'service-1',
        encounterId: 'encounter-1',
        serviceDate: SERVICE_DATE,
        quantity: Quantity.ONE,
        createdById: 'user-1',
      }),
    ).resolves.toBeDefined();
  });
});
