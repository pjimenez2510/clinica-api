import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import {
  AccountNotFoundError,
  EmissionPointInactiveError,
  FinalConsumerNotConfirmedError,
  InvoiceNotFoundError,
} from '../domain/billing.errors';
import type {
  AccountView,
  BillingAccountRepository,
  BillingCatalogueRepository,
  InvoiceView,
  PayerView,
} from '../domain/billing.repository';
import { Money } from '../domain/money';
import { InvoicingService } from './invoicing.service';

const SITE = 'site-1';
const ACCOUNT = 'account-1';
const EMISSION_POINT = 'emission-1';

const account: AccountView = {
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
};

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

const invoice: InvoiceView = {
  id: 'invoice-1',
  accountId: ACCOUNT,
  siteId: SITE,
  emissionPointId: EMISSION_POINT,
  sequential: '000000001',
  accessKey: null,
  receiver: {
    buyerIdentificationType: '05',
    buyerIdentification: '1710034065',
    buyerName: 'Guamán Andrade, María José',
    buyerEmail: null,
    isFinalConsumer: false,
  },
  totals: {
    subtotalTaxed: Money.ZERO,
    subtotalUntaxed: Money.parse('30.00'),
    discountTotal: Money.ZERO,
    taxTotal: Money.ZERO,
    total: Money.parse('30.00'),
  },
  status: 'ISSUED',
  paymentMethod: '01',
  issuedAt: new Date('2026-05-11T15:00:00Z'),
  authorisedAt: null,
  issuedById: 'user-1',
};

/**
 * The ports as doubles, with every mock held in a NAMED local — see the note
 * in `patient-account.service.spec.ts` for why `expect(port.method)` is not
 * spelled that way here.
 */
function build(options: { accounts?: Record<string, unknown> } = {}) {
  const mocks = {
    findAccount: vi.fn().mockResolvedValue(account),
    findEmissionPoint: vi
      .fn()
      .mockResolvedValue({ id: EMISSION_POINT, code: '001', active: true }),
    findAccountPatient: vi.fn().mockResolvedValue({
      patientId: 'patient-1',
      identifierType: 'CEDULA',
      identifierIssuingCountry: 'ECU',
      identifierValue: '1710034065',
      fullName: 'Guamán Andrade, María José',
    }),
    issueInvoice: vi.fn().mockResolvedValue(invoice),
    findInvoice: vi.fn().mockResolvedValue(invoice),
    listInvoices: vi.fn().mockResolvedValue([invoice]),
    findPayer: vi.fn().mockResolvedValue(payer()),
    record: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue(undefined),
    summariesOf: vi.fn().mockResolvedValue(new Map()),
    logError: vi.fn(),
    ...options.accounts,
  };

  return {
    service: new InvoicingService(
      mocks as unknown as BillingAccountRepository,
      mocks as unknown as BillingCatalogueRepository,
      mocks,
      mocks,
      mocks,
      {
        setContext: vi.fn(),
        error: mocks.logError,
      } as unknown as PinoLogger,
    ),
    mocks,
  };
}

const requester = { userId: 'user-1' };
const receiver = {
  identificationType: '05' as const,
  identification: '1710034065',
  name: 'Guamán Andrade, María José',
};

describe('BI-080 a BI-089 emitir la factura', () => {
  it('BI-080 emite con el receptor declarado y lo pasa ya resuelto al adaptador', async () => {
    const { service: invoicing, mocks } = build();

    await invoicing.issueInvoice(
      { accountId: ACCOUNT, siteId: SITE, emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
      requester,
    );

    expect(mocks.issueInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        receiver: expect.objectContaining({
          buyerIdentification: '1710034065',
          isFinalConsumer: false,
        }),
      }),
    );
  });

  it('BI-081 rechaza «Consumidor Final» sin confirmación y sin motivo', async () => {
    const { service: invoicing, mocks } = build();

    await expect(
      invoicing.issueInvoice(
        {
          accountId: ACCOUNT,
          siteId: SITE,
          emissionPointId: EMISSION_POINT,
          paymentMethod: '01',
          receiver: { finalConsumer: { confirmed: true } },
        },
        requester,
      ),
    ).rejects.toBeInstanceOf(FinalConsumerNotConfirmedError);

    // AND NOTHING WAS ISSUED. The refusal happens before the transaction, so
    // no sequential is burned on a document that never existed.
    expect(mocks.issueInvoice).not.toHaveBeenCalled();
  });

  it('BI-085 rechaza facturar por un punto de emisión desactivado', async () => {
    const { service: invoicing } = build({
      accounts: {
        findEmissionPoint: vi.fn().mockResolvedValue({
          id: EMISSION_POINT,
          code: '001',
          active: false,
        }),
      },
    });

    await expect(
      invoicing.issueInvoice(
        { accountId: ACCOUNT, siteId: SITE, emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(EmissionPointInactiveError);
  });

  it('BI-135 calla igual ante un punto de emisión de otra sede que ante uno inexistente', async () => {
    const { service: invoicing } = build({
      accounts: { findEmissionPoint: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      invoicing.issueInvoice(
        { accountId: ACCOUNT, siteId: SITE, emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it('BI-135 rechaza facturar una cuenta que no es de esta sede', async () => {
    const { service: invoicing } = build({
      accounts: { findAccount: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      invoicing.issueInvoice(
        { accountId: ACCOUNT, siteId: 'other', emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('BI-132 deja constancia de quién emitió, sin cargar la ficha en la bitácora', async () => {
    const { service: invoicing, mocks } = build();

    await invoicing.issueInvoice(
      { accountId: ACCOUNT, siteId: SITE, emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
      requester,
    );

    expect(mocks.record).toHaveBeenCalledWith({
      userId: 'user-1',
      resourceType: 'invoice',
      resourceId: 'invoice-1',
      action: 'CREATE',
      ip: undefined,
      userAgent: undefined,
    });
  });

  it('BI-090 no expone ninguna operación que modifique una factura emitida', () => {
    // The absence IS the requirement (D-A-007). A route that existed without a
    // screen would be used anyway, so what is asserted is the whole public
    // surface of the service that owns invoices.
    const surface = Object.getOwnPropertyNames(InvoicingService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(surface).toEqual([
      'findInvoice',
      'issueInvoice',
      'listInvoices',
      'proposedReceiver',
      'receiverContext',
      'requireAccount',
      'withVouchers',
    ]);
  });

  it('SRI-041 avisa al comprobante electrónico DESPUÉS de emitir, y devuelve la factura con su estado', async () => {
    const summary = {
      voucherId: 'voucher-1',
      state: 'SIGNED' as const,
      blockedReason: null,
      accessKey: '1'.repeat(49),
      authorisedAt: null,
      deliveryStatus: null,
      lastMessage: null,
    };
    const { service: invoicing, mocks } = build({
      accounts: {
        summariesOf: vi
          .fn()
          .mockResolvedValue(new Map([[invoice.id, summary]])),
      },
    });

    const issued = await invoicing.issueInvoice(
      { accountId: ACCOUNT, siteId: SITE, emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
      requester,
    );

    expect(mocks.prepare).toHaveBeenCalledWith(invoice.id);
    expect(mocks.issueInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepare.mock.invocationCallOrder[0]!,
    );
    expect(issued.electronic).toEqual(summary);
  });

  it('SRI-041 si la relectura falla tras emitir, responde la factura emitida sin su comprobante, sin error', async () => {
    const { service: invoicing, mocks } = build({
      accounts: {
        summariesOf: vi.fn().mockRejectedValue(new Error('db hiccup')),
      },
    });

    const issued = await invoicing.issueInvoice(
      { accountId: ACCOUNT, siteId: SITE, emissionPointId: EMISSION_POINT, receiver, paymentMethod: '01' }, // prettier-ignore
      requester,
    );

    expect(issued).toMatchObject({ id: invoice.id, electronic: null });
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('SRI-060 la factura sin comprobante todavía lo dice con null, sin fallar', async () => {
    const { service: invoicing } = build();
    const [listed] = await invoicing.listInvoices({ siteId: SITE });
    expect(listed?.electronic).toBeNull();
  });
});

describe('BI-082, BI-087 el receptor propuesto', () => {
  it('BI-082 propone la identificación del paciente de la cuenta', async () => {
    const { service: invoicing } = build();

    await expect(
      invoicing.proposedReceiver({ accountId: ACCOUNT, siteId: SITE }),
    ).resolves.toEqual({
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
    });
  });

  it('BI-087 no propone jamás al pagador institucional como receptor', async () => {
    // A reimbursement invoice made out to the insurer is not the patient's
    // expense, and the insurer rejects it (REQ-084).
    const { service: invoicing } = build({
      accounts: {
        findPayer: vi
          .fn()
          .mockResolvedValue(payer({ kind: 'PRIVATE_INSURANCE', ruc: '1790012344001' })), // prettier-ignore
      },
    });

    const proposal = await invoicing.proposedReceiver({
      accountId: ACCOUNT,
      siteId: SITE,
    });

    expect(proposal.identification).toBe('1710034065');
  });

  it('BI-082 propone una cédula que no emitió Ecuador como identificación del exterior (08)', async () => {
    // D-057 let the registration take a Colombian cedula. Proposed as `05` it
    // would reach the SRI as an Ecuadorian cedula that fails modulo 10.
    const { service: invoicing } = build({
      accounts: {
        findAccountPatient: vi.fn().mockResolvedValue({
          patientId: 'patient-1',
          identifierType: 'CEDULA',
          identifierIssuingCountry: 'COL',
          identifierValue: '1700326084',
          fullName: 'Prueba, Camila',
        }),
      },
    });

    await expect(
      invoicing.proposedReceiver({ accountId: ACCOUNT, siteId: SITE }),
    ).resolves.toMatchObject({ identificationType: '08' });
  });

  it('BI-082 no propone nada cuando la ficha no tiene identificación oficial', async () => {
    const { service: invoicing } = build({
      accounts: {
        findAccountPatient: vi.fn().mockResolvedValue({
          patientId: 'patient-1',
          identifierType: null,
          identifierValue: null,
          fullName: 'Sin, Identificar',
        }),
      },
    });

    // EMPTY, and not «a cedula with an empty number»: the cashier states who
    // is paying, which BI-080 demands anyway.
    await expect(
      invoicing.proposedReceiver({ accountId: ACCOUNT, siteId: SITE }),
    ).resolves.toEqual({});
  });
});
