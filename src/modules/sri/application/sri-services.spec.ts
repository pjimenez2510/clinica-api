import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import { composeAccessKey } from '../domain/access-key';
import type {
  PreparationSource,
  StoredCertificate,
  VoucherRecord,
} from '../domain/electronic-voucher.repository';
import type { Pkcs12Inspector } from '../domain/signing';
import {
  ElectronicVoucherNotFoundError,
  ElectronicVoucherNotRetriableError,
  SigningCertificateExpiredError,
  SigningCertificateInvalidError,
  SigningCertificateStoreNotConfiguredError,
  SigningCertificateTooLargeError,
} from '../domain/sri.errors';
import type { SriSettings } from '../domain/sri-web-service';

import {
  MAX_CERTIFICATE_BYTES,
  SigningCertificateService,
} from './signing-certificate.service';
import { VoucherDispatchService } from './voucher-dispatch.service';
import { VoucherMonitorService } from './voucher-monitor.service';
import {
  missingIssuerData,
  VoucherPreparationService,
} from './voucher-preparation.service';

/** The clock of these tests: the instant they run. */
const NOW = new Date();
const DAY = 86_400_000;

const logError = vi.fn();
const logger = {
  setContext: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: logError,
} as unknown as PinoLogger;

function source(overrides: Partial<PreparationSource> = {}): PreparationSource {
  return {
    invoiceId: 'invoice-1',
    siteId: 'site-1',
    invoiceStatus: 'ISSUED',
    issuedAt: NOW,
    sequential: '000000001',
    emissionPointCode: '001',
    establishmentCode: '001',
    issuer: {
      ruc: '1790001563001',
      legalName: 'Clínica de Desarrollo S.A.',
      headOfficeAddress: 'Av. Amazonas, Quito',
      establishmentAddress: null,
      keepsAccounting: false,
      specialTaxpayerResolution: null,
      withholdingAgentResolution: null,
      rimpeRegime: 'NONE',
      fiscalProfileDeclared: true,
    },
    buyer: {
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
      email: null,
    },
    lines: [
      {
        code: 'CONS',
        description: 'Consulta',
        quantity: '1',
        unitPrice: '30.00',
        discount: '0.00',
        taxSriCode: '0',
        taxPercentage: '0.00',
      },
    ],
    totals: {
      subtotalTaxed: '0.00',
      subtotalUntaxed: '30.00',
      discountTotal: '0.00',
      taxTotal: '0.00',
      total: '30.00',
    },
    paymentMethod: '01',
    ...overrides,
  };
}

/** The key the preparation would have composed for `source()`. */
const KEY = composeAccessKey({
  issuedOn: clinicalDateOf(NOW),
  documentType: '01',
  ruc: '1790001563001',
  environment: '1',
  establishmentCode: '001',
  emissionPointCode: '001',
  sequential: '000000001',
  numericCode: '00000001',
});

function voucher(overrides: Partial<VoucherRecord> = {}): VoucherRecord {
  return {
    id: 'voucher-1',
    invoiceId: 'invoice-1',
    siteId: 'site-1',
    accessKey: KEY,
    numericCode: '00000001',
    environment: '1',
    status: 'PREPARED',
    blockedReason: null,
    unsignedXml: '<factura id="comprobante"/>',
    signedXml: null,
    signedAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    authorisedXml: null,
    authorisedAt: null,
    deliveryStatus: null,
    ...overrides,
  };
}

function certificate(
  overrides: Partial<StoredCertificate> = {},
): StoredCertificate {
  return {
    id: 'certificate-1',
    subject: 'CN=Firmante',
    issuer: 'CN=Entidad',
    serialNumber: '01',
    notBefore: new Date(NOW.getTime() - DAY),
    notAfter: new Date(NOW.getTime() + 365 * DAY),
    active: true,
    createdAt: NOW,
    encryptedPkcs12: Buffer.from('sealed-p12'),
    encryptedPassword: Buffer.from('sealed-password'),
    kdfSalt: Buffer.alloc(16),
    ...overrides,
  };
}

function fakes() {
  const order: string[] = [];
  const vouchers = {
    preparationSource: vi.fn().mockResolvedValue(source()),
    findByInvoice: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation((v: { accessKey: string }) =>
        Promise.resolve(voucher({ accessKey: v.accessKey })),
      ),
    findById: vi.fn().mockResolvedValue(voucher()),
    findByIdInSites: vi.fn().mockResolvedValue(voucher()),
    block: vi.fn().mockResolvedValue(undefined),
    markSigned: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(true),
    recordAttempt: vi.fn().mockResolvedValue(true),
    scheduleNext: vi.fn(),
    recordDelivery: vi.fn().mockResolvedValue(undefined),
    unblockForCertificate: vi.fn().mockResolvedValue(0),
    pendingWork: vi.fn().mockResolvedValue({
      invoicesWithoutVoucher: [],
      unsigned: [],
      inFlight: [],
      undelivered: [],
    }),
    monitor: vi.fn().mockResolvedValue([]),
    statusOfInvoices: vi.fn().mockResolvedValue([]),
    deliveryContext: vi.fn(),
  };
  const certificates = {
    active: vi.fn().mockResolvedValue(certificate()),
    createActive: vi
      .fn()
      .mockImplementation((c: Partial<StoredCertificate>) =>
        Promise.resolve({ ...certificate(), ...c }),
      ),
    list: vi.fn().mockResolvedValue([]),
    recordOpening: vi.fn().mockImplementation(() => {
      order.push('opening');
      return Promise.resolve();
    }),
  };
  const cipher = {
    newSalt: () => Buffer.alloc(16, 1),
    seal: vi
      .fn()
      .mockImplementation((plain: Buffer) =>
        Promise.resolve(Buffer.concat([Buffer.from('sealed:'), plain])),
      ),
    ready: vi.fn().mockResolvedValue(true),
    open: vi.fn().mockImplementation((sealed: readonly Buffer[]) => {
      order.push('open');
      return Promise.resolve(sealed.map((s) => Buffer.from(s)));
    }),
  };
  const signer = {
    sign: vi
      .fn()
      .mockReturnValue('<factura id="comprobante"><ds:Signature/></factura>'),
  };
  const queue = {
    schedule: vi
      .fn<
        (step: string, voucher: { id: string }, delay: number) => Promise<void>
      >()
      .mockResolvedValue(undefined),
  };
  const web = {
    isConfigured: vi.fn().mockReturnValue(true),
    receive: vi.fn(),
    authorise: vi.fn(),
  };
  const settings: SriSettings = {
    environment: '1',
    softwareProviderRuc: null,
  };
  const preparation = new VoucherPreparationService(
    vouchers,
    certificates,
    cipher,
    signer,
    queue,
    web,
    settings,
    () => NOW,
    logger,
  );
  return {
    vouchers,
    certificates,
    cipher,
    signer,
    queue,
    web,
    settings,
    preparation,
    order,
  };
}

describe('SRI-008 los datos del emisor que un comprobante necesita', () => {
  it('SRI-008 OR-031 nombra cada dato que falta, también las banderas fiscales sin declarar, y ninguno cuando están todos', () => {
    expect(missingIssuerData(source())).toEqual([]);
    expect(
      missingIssuerData(
        source({
          establishmentCode: null,
          issuer: {
            ...source().issuer,
            ruc: null,
            legalName: ' ',
            headOfficeAddress: null,
            fiscalProfileDeclared: false,
          },
        }),
      ),
    ).toEqual([
      'ISSUER_RUC',
      'ISSUER_LEGAL_NAME',
      'SRI_ESTABLISHMENT_CODE',
      'HEAD_OFFICE_ADDRESS',
      'FISCAL_PROFILE',
    ]);
  });
});

describe('SRI-001, SRI-041 la preparación', () => {
  it('SRI-001 SRI-003 compone la clave con el ambiente configurado y un código numérico de ocho dígitos', async () => {
    const { preparation, vouchers } = fakes();
    await preparation.prepareInvoice('invoice-1');
    const created = vouchers.create.mock.calls[0]![0] as {
      accessKey: string;
      numericCode: string;
      environment: string;
    };
    expect(created.accessKey).toHaveLength(49);
    expect(created.numericCode).toMatch(/^[0-9]{8}$/);
    expect(created.accessKey.slice(39, 47)).toBe(created.numericCode);
    expect(created.environment).toBe('1');
  });

  it('SRI-005 si el comprobante ya existe no compone otra clave', async () => {
    const { preparation, vouchers } = fakes();
    vouchers.findByInvoice.mockResolvedValue(voucher({ status: 'SIGNED' }));
    await preparation.prepareInvoice('invoice-1');
    expect(vouchers.create).not.toHaveBeenCalled();
  });

  it('SRI-008 no crea comprobante si falta un dato del emisor, ni para una factura que no está ISSUED', async () => {
    const { preparation, vouchers } = fakes();
    vouchers.preparationSource.mockResolvedValueOnce(
      source({ establishmentCode: null }),
    );
    await expect(preparation.prepareInvoice('invoice-1')).resolves.toBeNull();
    vouchers.preparationSource.mockResolvedValueOnce(
      source({ invoiceStatus: 'VOIDED' }),
    );
    await expect(preparation.prepareInvoice('invoice-1')).resolves.toBeNull();
    expect(vouchers.create).not.toHaveBeenCalled();
  });

  it('SRI-041 prepare NUNCA lanza: un fallo se registra y la emisión sigue', async () => {
    const { preparation, vouchers } = fakes();
    vouchers.preparationSource.mockRejectedValue(new Error('database hiccup'));
    await expect(preparation.prepare('invoice-1')).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });
});

describe('SRI-020 a SRI-031 la firma', () => {
  it('SRI-026 registra la apertura ANTES de descifrar, y firma con el XML recompuesto', async () => {
    const { preparation, order, signer, vouchers, queue } = fakes();
    const signed = await preparation.sign(voucher());
    expect(order.slice(0, 2)).toEqual(['opening', 'open']);
    expect(signer.sign).toHaveBeenCalledWith(
      expect.stringContaining('<factura id="comprobante"'),
      expect.any(Buffer),
      'sealed-password',
    );
    expect(vouchers.markSigned).toHaveBeenCalled();
    expect(queue.schedule).toHaveBeenCalledWith('SEND', expect.anything(), 0);
    expect(signed.status).toBe('SIGNED');
  });

  it('SRI-019 una sede corregida tras emitir no cambia lo que el comprobante dice de sí mismo', async () => {
    const { preparation, vouchers, signer } = fakes();
    vouchers.preparationSource.mockResolvedValue(
      source({
        establishmentCode: '002',
        emissionPointCode: '009',
        issuer: { ...source().issuer, ruc: '1790001564001' },
      }),
    );
    await preparation.sign(voucher());
    const xml = signer.sign.mock.calls[0]![0] as string;
    expect(xml).toContain('<estab>001</estab>');
    expect(xml).toContain('<ptoEmi>001</ptoEmi>');
    expect(xml).toContain('<ruc>1790001563001</ruc>');
  });

  it('SRI-008 un dato del emisor borrado tras crear el comprobante lo deja esperando, dicho', async () => {
    const { preparation, vouchers, signer } = fakes();
    vouchers.preparationSource.mockResolvedValue(
      source({ issuer: { ...source().issuer, headOfficeAddress: null } }),
    );
    const result = await preparation.sign(voucher());
    expect(result.blockedReason).toBe('MISSING_ISSUER_DATA');
    expect(vouchers.block).toHaveBeenCalledWith(
      'voucher-1',
      'MISSING_ISSUER_DATA',
    );
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it('SRI-024 SRI-026 sin frase maestra no registra una apertura que no ocurrió', async () => {
    const { preparation, certificates, cipher, signer, vouchers } = fakes();
    cipher.ready.mockResolvedValue(false);
    const result = await preparation.sign(voucher());
    expect(result.blockedReason).toBe('CERTIFICATE_STORE_NOT_CONFIGURED');
    expect(vouchers.block).toHaveBeenCalledWith(
      'voucher-1',
      'CERTIFICATE_STORE_NOT_CONFIGURED',
    );
    expect(certificates.recordOpening).not.toHaveBeenCalled();
    expect(cipher.open).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it('SRI-026 si la apertura no se puede registrar, no se descifra ni se firma', async () => {
    const { preparation, certificates, cipher, signer } = fakes();
    certificates.recordOpening.mockRejectedValue(new Error('audit down'));
    await expect(preparation.sign(voucher())).rejects.toThrow('audit down');
    expect(cipher.open).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it.each([
    [
      'NO_CERTIFICATE',
      (f: ReturnType<typeof fakes>) =>
        f.certificates.active.mockResolvedValue(null),
    ],
    [
      'CERTIFICATE_NOT_VALID',
      (f: ReturnType<typeof fakes>) =>
        f.certificates.active.mockResolvedValue(
          certificate({ notAfter: new Date(NOW.getTime() - DAY) }),
        ),
    ],
    [
      'CERTIFICATE_STORE_NOT_CONFIGURED',
      (f: ReturnType<typeof fakes>) =>
        f.cipher.open.mockRejectedValue(
          new SigningCertificateStoreNotConfiguredError(),
        ),
    ],
    [
      'CERTIFICATE_UNREADABLE',
      (f: ReturnType<typeof fakes>) =>
        f.signer.sign.mockImplementation(() => {
          throw new SigningCertificateInvalidError();
        }),
    ],
    [
      'SIGNING_FAILED',
      (f: ReturnType<typeof fakes>) =>
        f.signer.sign.mockImplementation(() => {
          throw new Error('library bug');
        }),
    ],
    [
      'NO_PAYMENT_METHOD',
      (f: ReturnType<typeof fakes>) => {
        f.vouchers.preparationSource.mockResolvedValue(
          source({ paymentMethod: null }),
        );
      },
    ],
  ] as const)(
    'SRI-017 SRI-028 a SRI-030 deja el comprobante sin firmar con el motivo %s, y no lo envía',
    async (reason, arrange) => {
      const f = fakes();
      arrange(f);
      const result = await f.preparation.sign(voucher());
      expect(result.blockedReason).toBe(reason);
      expect(f.vouchers.block).toHaveBeenCalledWith('voucher-1', reason);
      expect(f.vouchers.markSigned).not.toHaveBeenCalled();
      expect(f.queue.schedule).not.toHaveBeenCalled();
    },
  );

  it('SRI-054 sin servicio web configurado firma y no encola', async () => {
    const f = fakes();
    f.web.isConfigured.mockReturnValue(false);
    await f.preparation.sign(voucher());
    expect(f.vouchers.markSigned).toHaveBeenCalled();
    expect(f.queue.schedule).not.toHaveBeenCalled();
  });

  it('SRI-031 un comprobante ya firmado no se vuelve a firmar', async () => {
    const f = fakes();
    await f.preparation.sign(voucher({ status: 'SIGNED' }));
    expect(f.signer.sign).not.toHaveBeenCalled();
  });
});

describe('SRI-057 el despacho es idempotente', () => {
  function dispatchWith(f: ReturnType<typeof fakes>) {
    const mailer = { send: vi.fn().mockResolvedValue(undefined) };
    return {
      mailer,
      dispatch: new VoucherDispatchService(
        f.vouchers,
        f.web,
        f.queue,
        {
          issueRide: vi.fn().mockResolvedValue({
            content: Buffer.from('%PDF'),
            fileName: 'r.pdf',
          }),
        },
        mailer,
        () => NOW,
        f.settings,
        f.preparation,
        logger,
      ),
    };
  }

  it('SRI-055 un comprobante del otro ambiente no se envía', async () => {
    const f = fakes();
    f.vouchers.findById.mockResolvedValue(
      voucher({ status: 'SIGNED', signedXml: '<x/>', environment: '2' }),
    );
    await dispatchWith(f).dispatch.run('SEND', 'voucher-1');
    expect(f.web.receive).not.toHaveBeenCalled();
  });

  it('SRI-057 un SEND sobre un comprobante que ya no está SIGNED no llama al SRI', async () => {
    const f = fakes();
    f.vouchers.findById.mockResolvedValue(
      voucher({ status: 'RECEIVED', signedXml: '<x/>' }),
    );
    await dispatchWith(f).dispatch.run('SEND', 'voucher-1');
    expect(f.web.receive).not.toHaveBeenCalled();
  });

  it('SRI-057 si otro trabajo movió el comprobante primero, el nuestro no programa el siguiente paso', async () => {
    const f = fakes();
    f.vouchers.findById.mockResolvedValue(
      voucher({ status: 'SIGNED', signedXml: '<x/>' }),
    );
    f.web.receive.mockResolvedValue({ kind: 'RECIBIDA', messages: [] });
    f.vouchers.recordAttempt.mockResolvedValue(false);
    await dispatchWith(f).dispatch.run('SEND', 'voucher-1');
    expect(f.queue.schedule).not.toHaveBeenCalled();
  });

  it('SRI-049 una autorización pendiente programa otra consulta con la espera creciente', async () => {
    const f = fakes();
    f.vouchers.findById.mockResolvedValue(
      voucher({ status: 'RECEIVED', attemptCount: 2 }),
    );
    f.web.authorise.mockResolvedValue({ kind: 'PENDING' });
    await dispatchWith(f).dispatch.run('AUTHORISE', 'voucher-1');
    expect(f.queue.schedule).toHaveBeenCalledWith(
      'AUTHORISE',
      expect.anything(),
      120,
    );
    const effect = f.vouchers.recordAttempt.mock.calls[0]![2] as {
      nextAttemptAt: Date;
    };
    expect(effect.nextAttemptAt.getTime()).toBe(NOW.getTime() + 120_000);
  });

  it('SRI-075 un DELIVER sobre uno ya entregado no envía otro correo', async () => {
    const f = fakes();
    f.vouchers.findById.mockResolvedValue(
      voucher({
        status: 'AUTHORISED',
        authorisedXml: '<autorizacion/>',
        deliveryStatus: 'SENT',
      }),
    );
    const { dispatch, mailer } = dispatchWith(f);
    await dispatch.run('DELIVER', 'voucher-1');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('SRI-056 el barrido no reprograma lo que tiene su próximo intento en el futuro', async () => {
    const f = fakes();
    f.vouchers.pendingWork.mockResolvedValue({
      invoicesWithoutVoucher: [],
      unsigned: [],
      inFlight: [
        voucher({
          id: 'later',
          status: 'SIGNED',
          nextAttemptAt: new Date(NOW.getTime() + 60_000),
        }),
        voucher({
          id: 'due',
          status: 'RECEIVED',
          nextAttemptAt: new Date(NOW.getTime() - 1),
        }),
      ],
      undelivered: [voucher({ id: 'mail', status: 'AUTHORISED' })],
    });
    await dispatchWith(f).dispatch.sweep();
    expect(
      f.queue.schedule.mock.calls.map((call) => [call[0], call[1].id]),
    ).toEqual([
      ['AUTHORISE', 'due'],
      ['DELIVER', 'mail'],
    ]);
  });

  it('SRI-075 si falla anotar el envío después de que el correo salió, no lo da por fallido ni lo reenvía', async () => {
    const f = fakes();
    f.vouchers.findById.mockResolvedValue(
      voucher({ status: 'AUTHORISED', authorisedXml: '<autorizacion/>' }),
    );
    f.vouchers.deliveryContext.mockResolvedValue({
      invoiceId: 'invoice-1',
      issuedById: 'user-1',
      buyerEmail: 'maria@example.com',
      buyerName: 'María',
      documentNumber: '001-001-000000001',
      establishmentName: 'Clínica',
    });
    f.vouchers.recordDelivery.mockRejectedValue(new Error('db down'));
    const { dispatch, mailer } = dispatchWith(f);
    await expect(dispatch.run('DELIVER', 'voucher-1')).rejects.toThrow();
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(f.vouchers.recordDelivery).not.toHaveBeenCalledWith(
      'voucher-1',
      'FAILED',
      expect.anything(),
    );
    expect(f.queue.schedule).not.toHaveBeenCalled();
  });

  it('SC-072 un comprobante que falla no detiene el barrido: los demás siguen', async () => {
    const f = fakes();
    f.vouchers.pendingWork.mockResolvedValue({
      invoicesWithoutVoucher: [],
      unsigned: [voucher({ id: 'broken' })],
      inFlight: [voucher({ id: 'due', status: 'RECEIVED' })],
      undelivered: [],
    });
    const { dispatch } = dispatchWith(f);
    vi.spyOn(f.preparation, 'sign').mockRejectedValue(new Error('52'));
    await dispatch.sweep();
    expect(f.queue.schedule).toHaveBeenCalledWith(
      'AUTHORISE',
      expect.objectContaining({ id: 'due' }),
      0,
    );
  });
});

describe('SRI-080 a SRI-083 la carga del certificado', () => {
  function service(
    f: ReturnType<typeof fakes>,
    inspector: Partial<Pkcs12Inspector> = {},
  ) {
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const inspect = vi.fn().mockReturnValue({
      subject: 'CN=Firmante',
      issuer: 'CN=Entidad',
      serialNumber: '01',
      notBefore: new Date(NOW.getTime() - DAY),
      notAfter: new Date(NOW.getTime() + 20 * DAY),
    });
    return {
      audit,
      inspect,
      certificates: new SigningCertificateService(
        f.certificates,
        { inspect, ...inspector },
        f.cipher,
        audit,
        () => NOW,
        f.vouchers,
      ),
    };
  }

  it('SRI-083 rechaza un fichero demasiado grande ANTES de abrirlo', async () => {
    const f = fakes();
    const { certificates, inspect } = service(f);
    await expect(
      certificates.upload(Buffer.alloc(MAX_CERTIFICATE_BYTES + 1), 'x', {
        userId: 'u',
      }),
    ).rejects.toBeInstanceOf(SigningCertificateTooLargeError);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('SRI-033 rechaza uno fuera de su vigencia', async () => {
    const f = fakes();
    const { certificates } = service(f, {
      inspect: () => ({
        subject: 'CN=x',
        issuer: 'CN=y',
        serialNumber: '1',
        notBefore: new Date(NOW.getTime() - 2 * DAY),
        notAfter: new Date(NOW.getTime() - DAY),
      }),
    });
    await expect(
      certificates.upload(Buffer.from('p12'), 'x', { userId: 'u' }),
    ).rejects.toBeInstanceOf(SigningCertificateExpiredError);
  });

  it('SRI-023 SRI-080 SRI-082 SRI-084 guarda solo lo sellado, deja rastro y suelta lo que esperaba para el barrido', async () => {
    const f = fakes();
    const { certificates, audit } = service(f);
    await certificates.upload(Buffer.from('p12-bytes'), 'clave', {
      userId: 'admin-1',
    });

    const stored = f.certificates.createActive.mock.calls[0]![0] as {
      encryptedPkcs12: Buffer;
      encryptedPassword: Buffer;
    };
    expect(stored.encryptedPkcs12.toString()).toBe('sealed:p12-bytes');
    expect(stored.encryptedPassword.toString()).toBe('sealed:clave');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'signing_certificate',
        action: 'CREATE',
        userId: 'admin-1',
      }),
    );
    expect(f.vouchers.unblockForCertificate).toHaveBeenCalled();
  });

  it('SRI-032 avisa cuando faltan 30 días o menos para la caducidad', async () => {
    const f = fakes();
    f.certificates.active.mockResolvedValue(
      certificate({ notAfter: new Date(NOW.getTime() + 20 * DAY) }),
    );
    const health = await service(f).certificates.health();
    expect(health).toMatchObject({ aboutToExpire: true, expired: false });
    expect(Object.keys(health.active!)).not.toContain('encryptedPkcs12');

    f.certificates.active.mockResolvedValue(
      certificate({ notAfter: new Date(NOW.getTime() + 60 * DAY) }),
    );
    expect((await service(f).certificates.health()).aboutToExpire).toBe(false);
  });
});

describe('SRI-058, SRI-062 el monitor', () => {
  function monitorWith(f: ReturnType<typeof fakes>) {
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const certificates = {
      health: vi.fn().mockResolvedValue({
        active: null,
        aboutToExpire: false,
        expired: false,
      }),
    };
    return {
      audit,
      monitor: new VoucherMonitorService(
        f.vouchers,
        f.web,
        audit,
        f.preparation,
        certificates as unknown as SigningCertificateService,
        () => NOW,
      ),
    };
  }
  const requester = { userId: 'caja-1', sites: ['site-1'] };

  it('SRI-065 un comprobante fuera del alcance es SRI_VOUCHER_NOT_FOUND', async () => {
    const f = fakes();
    f.vouchers.findByIdInSites.mockResolvedValue(null);
    await expect(
      monitorWith(f).monitor.retry('voucher-1', requester),
    ).rejects.toBeInstanceOf(ElectronicVoucherNotFoundError);
  });

  it('SRI-058 solo se reintenta lo devuelto o no autorizado', async () => {
    const f = fakes();
    f.vouchers.findByIdInSites.mockResolvedValue(
      voucher({ status: 'RECEIVED' }),
    );
    await expect(
      monitorWith(f).monitor.retry('voucher-1', requester),
    ).rejects.toBeInstanceOf(ElectronicVoucherNotRetriableError);
  });

  it('SRI-058 SRI-066 reabre con el XML recompuesto, deja rastro y firma otra vez', async () => {
    const f = fakes();
    f.vouchers.findByIdInSites.mockResolvedValue(
      voucher({ status: 'RETURNED' }),
    );
    const { monitor, audit } = monitorWith(f);
    await monitor.retry('voucher-1', requester);
    expect(f.vouchers.reopen).toHaveBeenCalledWith(
      'voucher-1',
      expect.stringContaining('<factura'),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'electronic_voucher',
        action: 'UPDATE',
      }),
    );
    expect(f.vouchers.markSigned).toHaveBeenCalled();
  });

  it('SRI-062 lo que necesita a una persona va primero, aunque sea más antiguo', async () => {
    const f = fakes();
    const base = {
      siteId: 'site-1',
      buyerName: 'x',
      buyerIdentification: 'y',
      total: '1.00',
      blockedReason: null,
      accessKey: null,
      lastMessages: [],
      attemptCount: 0,
      nextAttemptAt: null,
    };
    f.vouchers.monitor.mockResolvedValue([
      {
        ...base,
        invoiceId: 'a',
        voucherId: 'va',
        documentNumber: '1',
        issuedAt: new Date(NOW.getTime() - 1000),
        status: 'SIGNED',
      },
      {
        ...base,
        invoiceId: 'b',
        voucherId: 'vb',
        documentNumber: '2',
        issuedAt: new Date(NOW.getTime() - 5000),
        status: 'RETURNED',
      },
    ]);
    const view = await monitorWith(f).monitor.monitor(['site-1']);
    expect(view.rows.map((row) => row.invoiceId)).toEqual(['b', 'a']);
  });
});
