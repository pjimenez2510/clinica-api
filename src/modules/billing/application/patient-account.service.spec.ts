import { describe, expect, it, vi } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import {
  AccountClosedError,
  AccountHasOpenChargesError,
  AccountNoChargeReasonRequiredError,
  AccountNotFoundError,
  BillableServiceInactiveError,
  PayerInactiveError,
  PriceListNotFoundError,
} from '../domain/billing.errors';
import type {
  AccountView,
  ServiceView,
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
const USER = 'user-1';
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
  noChargeReason: null,
  ...overrides,
});

const charge = (
  id: string,
  status: ChargeStatus,
  overrides: Partial<ChargeView> = {},
): ChargeView => ({
  id,
  accountId: ACCOUNT,
  serviceId: 'service-1',
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
  discountAuthorisedAt: null,
  discountAuthorisedByName: null,
  discountAppliedById: null,
  discountAppliedAt: null,
  discountAppliedByName: null,
  status,
  createdById: 'user-1',
  origin: 'MANUAL',
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

const service = (overrides: Partial<ServiceView> = {}): ServiceView => ({
  id: 'service-1',
  code: 'CONS-MG-PV',
  name: 'Consulta de medicina general, primera vez',
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
    findService: vi.fn().mockResolvedValue(service()),
    findPayer: vi.fn().mockResolvedValue(payer()),
    findPriceListOfPayer: vi.fn().mockResolvedValue({
      id: 'list-particular',
      name: 'Particular',
      payerId: 'payer-particular',
      siteId: null,
      publiclyListed: true,
      active: true,
    }),
    record: vi.fn().mockResolvedValue(undefined),
    draftOrdersOf: vi.fn().mockResolvedValue([]),
    encounterStatusOf: vi.fn().mockResolvedValue({ status: 'DISCHARGED', hasDrafts: false }), // prettier-ignore
    findEncounterActs: vi.fn().mockResolvedValue({
      serviceId: 'service-type-1',
      visitSequence: 'SUBSEQUENT',
    }),
    findConsultationService: vi.fn().mockResolvedValue({
      serviceId: 'service-subsequent',
      active: true,
    }),
    ...options.accounts,
    ...options.catalogue,
  };

  return {
    service: new PatientAccountService(
      mocks as unknown as BillingAccountRepository,
      mocks as unknown as BillingCatalogueRepository,
      { record: mocks.record },
      {
        draftOrdersOf: mocks.draftOrdersOf,
        findEncounterActs: mocks.findEncounterActs,
        encounterStatusOf: mocks.encounterStatusOf,
      },
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

describe('BI-198 cambiar el pagador con cargos', () => {
  it('BI-198 cambia el pagador y su lista, y deja al adaptador re-tarifar con quién y cuándo', async () => {
    const { service: accounts, mocks } = build();

    await accounts.changePayer({
      accountId: ACCOUNT,
      siteId: SITE,
      payerId: 'payer-particular',
      changedById: 'cashier-1',
    });

    expect(mocks.changeAccountPayer).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT,
        payerId: 'payer-particular',
        changedById: 'cashier-1',
        now: expect.any(Date),
      }),
    );
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
      .closeAccount({ accountId: ACCOUNT, siteId: SITE, closedById: USER })
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

    await accounts.closeAccount({ accountId: ACCOUNT, siteId: SITE, closedById: USER }); // prettier-ignore
    // BI-215: closing is stamped with who closed it.
    expect(mocks.closeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, closedById: USER }),
    );
  });

  it('BI-237 sin nada facturado exige el motivo de no cobrar, y no llama al repositorio', async () => {
    const { service: accounts, mocks } = build({
      accounts: {
        listCharges: vi
          .fn()
          .mockResolvedValue([charge('charge-1', 'NOT_BILLABLE'), charge('charge-2', 'CANCELLED')]), // prettier-ignore
      },
    });

    for (const noChargeReason of [undefined, '   ']) {
      await expect(
        accounts.closeAccount({ accountId: ACCOUNT, siteId: SITE, closedById: USER, noChargeReason }), // prettier-ignore
      ).rejects.toBeInstanceOf(AccountNoChargeReasonRequiredError);
    }
    expect(mocks.closeAccount).not.toHaveBeenCalled();

    // Control positivo: con el motivo, recortado, se cierra.
    await accounts.closeAccount({ accountId: ACCOUNT, siteId: SITE, closedById: USER, noChargeReason: '  Control sin costo ' }); // prettier-ignore
    expect(mocks.closeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ noChargeReason: 'Control sin costo' }),
    );
  });

  it('BI-237 con algo facturado no pide motivo ni lo guarda', async () => {
    const { service: accounts, mocks } = build({
      accounts: {
        listCharges: vi.fn().mockResolvedValue([charge('charge-1', 'BILLED')]),
      },
    });

    await accounts.closeAccount({ accountId: ACCOUNT, siteId: SITE, closedById: USER, noChargeReason: 'Cortesía' }); // prettier-ignore

    expect(mocks.closeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ noChargeReason: null }),
    );
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
        serviceId: 'service-1',
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
        findService: vi.fn().mockResolvedValue(service({ active: false })), // prettier-ignore
      },
    });

    await expect(
      accounts.addCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        serviceId: 'service-1',
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
      serviceId: 'service-1',
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

  it('BI-074 lo acreditado por una nota de crédito no cuenta; su copia por facturar, sí', async () => {
    const note = { id: 'note-1', documentNumber: '001-001-000000003', status: 'ISSUED' }; // prettier-ignore
    const { service: accounts } = build({
      accounts: {
        listCharges: vi.fn().mockResolvedValue([
          charge('original', 'BILLED', {
            unitAmount: Money.parse('24.00'),
            creditNote: note,
          }),
          charge('copy', 'BILLABLE', {
            unitAmount: Money.parse('24.00'),
            origin: 'CORRECTION',
            correctsChargeItemId: 'original',
          }),
        ]),
      },
    });

    const statement = await accounts.statement({
      accountId: ACCOUNT,
      siteId: SITE,
    });

    expect(statement.totals.total.toString()).toBe('24.00');
    expect(statement.charges).toHaveLength(2);
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

    expect(mocks.findService).not.toHaveBeenCalled();
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
    expect(mocks.findService).not.toHaveBeenCalled();
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
      now: expect.any(Date),
    });
  });

  it('BI-195 quita el cargo sin motivo', async () => {
    const { service: accounts, mocks } = build({
      accounts: {
        findCharge: vi.fn().mockResolvedValue(charge('charge-1', 'BILLABLE')),
      },
    });

    await accounts.voidCharge({
      accountId: ACCOUNT,
      siteId: SITE,
      chargeId: 'charge-1',
      reason: null,
      voidedById: 'user-2',
    });

    expect(mocks.voidCharge).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );
  });

  it('BI-195 no quita otra vez un cargo marcado «No se cobra»', async () => {
    const { service: accounts } = build({
      accounts: {
        findCharge: vi
          .fn()
          .mockResolvedValue(charge('charge-1', 'NOT_BILLABLE')),
      },
    });

    await expect(
      accounts.voidCharge({
        accountId: ACCOUNT,
        siteId: SITE,
        chargeId: 'charge-1',
        reason: null,
        voidedById: 'user-2',
      }),
    ).rejects.toMatchObject({ code: 'CHARGE_ALREADY_VOIDED' });
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

  it('BI-059 no confirma un cargo quitado', async () => {
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
    expect(mocks.findService).not.toHaveBeenCalled();
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
      // BI-203. A read of the statement, not something care waits for.
      'consultationOutdated',
      'listAccounts',
      'openAccount',
      // BI-274. «Enviar a caja» under a race; still money, never a gate.
      'openOrRecoverEncounterAccount',
      'openStatement',
      'proceduresOutdated',
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
        serviceId: 'service-1',
        encounterId: 'encounter-1',
        serviceDate: SERVICE_DATE,
        quantity: Quantity.ONE,
        createdById: 'user-1',
      }),
    ).resolves.toBeDefined();
  });
});

describe('BI-192 la cuenta avisa del borrador de orden sin emitir', () => {
  it('BI-192 el extracto trae los borradores de la atención de la cuenta, con quién y desde cuándo', async () => {
    const savedAt = new Date();
    const notice = { orderId: 'order-1', orderedByName: 'Ana Pérez', savedAt };
    const { service, mocks } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
        draftOrdersOf: vi.fn().mockResolvedValue([notice]),
      },
    });

    const statement = await service.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.draftOrders).toEqual([notice]);
    expect(mocks.draftOrdersOf).toHaveBeenCalledWith({ encounterId: 'encounter-1', siteId: SITE }); // prettier-ignore
  });

  it('BI-192 una cuenta sin atención no tiene borradores que avisar', async () => {
    const { service, mocks } = build();

    const statement = await service.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.draftOrders).toEqual([]);
    expect(mocks.draftOrdersOf).not.toHaveBeenCalled();
  });
});

describe('BI-203 el extracto dice la consulta que ya no corresponde a la atención', () => {
  const consultation = (status: ChargeStatus, serviceId: string) =>
    charge('charge-consultation', status, {
      origin: 'CONSULTATION',
      serviceId,
    });

  it('BI-203 la señala cuando la atención pasó a subsecuente y el cargo sigue en primera vez', async () => {
    const { service: accounts } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
        listCharges: vi.fn().mockResolvedValue([consultation('PLANNED', 'service-first-time')]), // prettier-ignore
      },
    });

    const statement = await accounts.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.consultationOutdated).toEqual({
      chargeId: 'charge-consultation',
      billed: false,
    });
  });

  it('BI-203 la señala también facturada, para corregir la factura', async () => {
    const { service: accounts } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
        listCharges: vi.fn().mockResolvedValue([consultation('BILLED', 'service-first-time')]), // prettier-ignore
      },
    });

    const statement = await accounts.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.consultationOutdated?.billed).toBe(true);
  });

  it('BI-203 calla cuando la consulta ya es la que corresponde, o está quitada', async () => {
    for (const line of [
      consultation('PLANNED', 'service-subsequent'),
      consultation('CANCELLED', 'service-first-time'),
    ]) {
      const { service: accounts } = build({
        accounts: {
          findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
          listCharges: vi.fn().mockResolvedValue([line]),
        },
      });

      const statement = await accounts.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

      expect(statement.consultationOutdated).toBeNull();
    }
  });
});

describe('BI-236 el extracto dice el estado de la atención que se cierra con la cuenta', () => {
  it('BI-236 sirve el estado de la atención de la cuenta, leído en su sede', async () => {
    const { service, mocks } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
      },
    });

    const statement = await service.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.encounterStatus).toBe('DISCHARGED');
    expect(statement.closesEncounter).toBe(true);
    expect(mocks.encounterStatusOf).toHaveBeenCalledWith({ encounterId: 'encounter-1', siteId: SITE }); // prettier-ignore
  });

  it('BI-236 con una orden o receta en borrador la atención no se cierra con la cuenta, y el extracto lo dice', async () => {
    const { service } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
        encounterStatusOf: vi.fn().mockResolvedValue({ status: 'DISCHARGED', hasDrafts: true }), // prettier-ignore
      },
    });

    const statement = await service.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.encounterStatus).toBe('DISCHARGED');
    expect(statement.closesEncounter).toBe(false);
  });

  it('BI-236 una cuenta sin atención no tiene estado que decir', async () => {
    const { service, mocks } = build();

    const statement = await service.statement({ accountId: ACCOUNT, siteId: SITE }); // prettier-ignore

    expect(statement.encounterStatus).toBeNull();
    expect(statement.closesEncounter).toBe(false);
    expect(mocks.encounterStatusOf).not.toHaveBeenCalled();
  });
});

describe('BI-203 BI-214 la consulta corregida tras una nota de crédito', () => {
  it('BI-203 BI-214 compara la copia de la consulta, no el original acreditado', async () => {
    const note = { id: 'note-1', documentNumber: '001-001-000000003', status: 'AUTHORISED' }; // prettier-ignore
    const build_ = (copyService: string) =>
      build({
        accounts: {
          findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
          listCharges: vi.fn().mockResolvedValue([
            charge('original', 'BILLED', {
              origin: 'CONSULTATION',
              serviceId: 'service-first',
              creditNote: note,
            }),
            charge('copy', 'BILLED', {
              origin: 'CORRECTION',
              correctsChargeItemId: 'original',
              serviceId: copyService,
            }),
          ]),
          findEncounterActs: vi.fn().mockResolvedValue({ serviceId: 'type-1', visitSequence: 'SUBSEQUENT', procedures: [] }), // prettier-ignore
          findConsultationService: vi.fn().mockResolvedValue({ serviceId: 'service-subsequent', active: true }), // prettier-ignore
        },
      }).service.statement({ accountId: ACCOUNT, siteId: SITE });

    // The copy was put right: nothing to say, although the credited original
    // still names the old service.
    expect(
      (await build_('service-subsequent')).consultationOutdated,
    ).toBeNull();
    // Control: the copy still charging the old one is said, on the copy.
    expect((await build_('service-first')).consultationOutdated).toEqual({
      chargeId: 'copy',
      billed: true,
    });
  });
});

describe('BI-243 el extracto dice los cargos de procedimiento que ya no corresponden a la atención', () => {
  const procedureLine = (status: ChargeStatus, procedureId: string) =>
    charge(`charge-${procedureId}`, status, {
      origin: 'PROCEDURE',
      encounterProcedureId: procedureId,
      serviceId: 'service-suture',
    });
  const statementWith = async (
    lines: ChargeView[],
    procedures: {
      encounterProcedureId: string;
      procedureCode: string;
      quantity: number;
      restoredFrom?: string[];
    }[],
  ) => {
    const { service: accounts } = build({
      accounts: {
        findAccount: vi.fn().mockResolvedValue(account({ encounterId: 'encounter-1' })), // prettier-ignore
        listCharges: vi.fn().mockResolvedValue(lines),
        findEncounterActs: vi.fn().mockResolvedValue({ serviceId: null, procedures }), // prettier-ignore
        findServicesByProcedureCode: vi.fn().mockResolvedValue(
          new Map([
            ['code-suture', { serviceId: 'service-suture', active: true }],
            ['code-cure', { serviceId: 'service-cure', active: true }],
          ]),
        ),
      },
    });
    return accounts.statement({ accountId: ACCOUNT, siteId: SITE });
  };

  it('BI-243 señala el confirmado cuyo procedimiento se quitó y el facturado que cambió de prestación', async () => {
    const statement = await statementWith(
      [
        procedureLine('BILLABLE', 'p-gone'),
        procedureLine('BILLED', 'p-changed'),
      ],
      [
        {
          encounterProcedureId: 'p-changed',
          procedureCode: 'code-cure',
          quantity: 1,
        },
      ],
    );

    expect(statement.proceduresOutdated).toEqual([
      { chargeId: 'charge-p-gone', billed: false, reason: 'RETRACTED' },
      { chargeId: 'charge-p-changed', billed: true, reason: 'CHANGED' },
    ]);
  });

  it('BI-243 señala la cantidad cambiada y calla lo que corresponde, lo quitado y lo restaurado de su fila', async () => {
    const statement = await statementWith(
      [
        procedureLine('BILLABLE', 'p-two'),
        procedureLine('BILLABLE', 'p-same'),
        procedureLine('CANCELLED', 'p-gone'),
        procedureLine('BILLABLE', 'p-old'),
      ],
      [
        {
          encounterProcedureId: 'p-two',
          procedureCode: 'code-suture',
          quantity: 2,
        },
        {
          encounterProcedureId: 'p-same',
          procedureCode: 'code-suture',
          quantity: 1,
        },
        // EN-246: restored from `p-old`, whose line still charges it.
        {
          encounterProcedureId: 'p-new',
          procedureCode: 'code-suture',
          quantity: 1,
          restoredFrom: ['p-old'],
        },
      ],
    );

    expect(statement.proceduresOutdated).toEqual([
      { chargeId: 'charge-p-two', billed: false, reason: 'CHANGED' },
    ]);
  });
  it('BI-243 BI-214 tras una nota de crédito señala la copia, que cobra, y no el original acreditado', async () => {
    const credited = charge('charge-original', 'BILLED', {
      origin: 'PROCEDURE',
      encounterProcedureId: 'p-gone',
      serviceId: 'service-suture',
      creditNote: { id: 'note-1', documentNumber: '001-001-000000003', status: 'AUTHORISED' }, // prettier-ignore
    });
    const copy = charge('charge-copy', 'BILLABLE', {
      origin: 'CORRECTION',
      correctsChargeItemId: 'charge-original',
      encounterProcedureId: 'p-gone',
      serviceId: 'service-suture',
    });

    const statement = await statementWith([credited, copy], []);

    expect(statement.proceduresOutdated).toEqual([
      { chargeId: 'charge-copy', billed: false, reason: 'RETRACTED' },
    ]);
  });
});
