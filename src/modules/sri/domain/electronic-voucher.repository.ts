import type { SriEnvironment } from './access-key';
import type { RimpeRegime, VoucherLine, VoucherTotals } from './invoice-xml';
import type {
  BlockedReason,
  QueueStep,
  SriMessage,
  VoucherStatus,
} from './voucher-lifecycle';

/**
 * Everything an issued invoice offers to become a voucher, read in one place.
 * The issuer fields are NULLABLE because the installation may not have them
 * yet (SRI-008): the preparation says which, it never invents them.
 */
export interface PreparationSource {
  invoiceId: string;
  siteId: string;
  invoiceStatus: string;
  issuedAt: Date;
  sequential: string;
  emissionPointCode: string;
  establishmentCode: string | null;
  issuer: {
    ruc: string | null;
    legalName: string | null;
    headOfficeAddress: string | null;
    establishmentAddress: string | null;
    keepsAccounting: boolean;
    specialTaxpayerResolution: string | null;
    withholdingAgentResolution: string | null;
    rimpeRegime: RimpeRegime;
  };
  buyer: {
    identificationType: string;
    identification: string;
    name: string;
    email: string | null;
  };
  lines: VoucherLine[];
  totals: VoucherTotals;
  /** BI-170, SRI-017. Declared by caja; `null` only on older invoices. */
  paymentMethod: string | null;
}

/** A voucher as the application handles it. */
export interface VoucherRecord {
  id: string;
  invoiceId: string;
  siteId: string;
  accessKey: string;
  numericCode: string;
  environment: SriEnvironment;
  status: VoucherStatus;
  blockedReason: BlockedReason | null;
  unsignedXml: string;
  signedXml: string | null;
  /** SRI-048. When the voucher now at the SRI was signed. */
  signedAt: Date | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  authorisedXml: string | null;
  deliveryStatus: DeliveryStatus | null;
}

export type DeliveryStatus = 'PENDING' | 'SENT' | 'NO_EMAIL' | 'FAILED';

export interface NewVoucher {
  invoiceId: string;
  siteId: string;
  accessKey: string;
  numericCode: string;
  environment: SriEnvironment;
  schemaVersion: string;
  unsignedXml: string;
  blockedReason: BlockedReason | null;
}

/** One call to the SRI, as `electronic_voucher_attempt` keeps it (SRI-051). */
export interface AttemptRecord {
  operation: 'RECEPTION' | 'AUTHORISATION';
  startedAt: Date;
  durationMs: number;
  outcome:
    | 'RECIBIDA'
    | 'DEVUELTA'
    | 'AUTORIZADO'
    | 'NO AUTORIZADO'
    | 'PENDING'
    | 'TRANSPORT_FAILURE';
  messages: SriMessage[];
  transportError: string | null;
}

/** What an attempt changes, applied in one transaction with the attempt row. */
export interface AttemptEffect {
  /** SRI-057. Applied only if the voucher is still in this status. */
  expectedStatus: VoucherStatus;
  status: VoucherStatus;
  invoiceStatus: 'AUTHORISED' | 'REJECTED' | null;
  lastMessages: SriMessage[] | null;
  nextAttemptAt: Date | null;
  authorisation: {
    number: string;
    authorisedAt: Date;
    authorisedXml: string;
  } | null;
}

/** One row of the monitor (SRI-061). Never a clinical datum (SRI-067). */
export interface MonitorRow {
  invoiceId: string;
  voucherId: string | null;
  siteId: string;
  documentNumber: string;
  buyerName: string;
  buyerIdentification: string;
  issuedAt: Date;
  total: string;
  status: VoucherStatus | 'NO_VOUCHER';
  blockedReason: BlockedReason | null;
  accessKey: string | null;
  lastMessages: SriMessage[];
  attemptCount: number;
  nextAttemptAt: Date | null;
}

/** The voucher's state as `billing` shows it beside the invoice (SRI-060). */
export interface VoucherStatusView {
  invoiceId: string;
  voucherId: string;
  status: VoucherStatus;
  blockedReason: BlockedReason | null;
  accessKey: string;
  authorisedAt: Date | null;
  deliveryStatus: DeliveryStatus | null;
  lastMessages: SriMessage[];
}

export interface ElectronicVoucherRepository {
  preparationSource(invoiceId: string): Promise<PreparationSource | null>;

  /**
   * SRI-001, SRI-005, SRI-007. Inserts the voucher AND writes its key on the
   * invoice in one transaction. If another process prepared the same invoice
   * first (`electronic_voucher_one_per_invoice`), returns THAT voucher: the
   * key is never computed twice for one invoice.
   */
  create(voucher: NewVoucher): Promise<VoucherRecord>;

  findById(id: string): Promise<VoucherRecord | null>;
  findByInvoice(invoiceId: string): Promise<VoucherRecord | null>;
  findByIdInSites(
    id: string,
    sites: readonly string[] | 'all',
  ): Promise<VoucherRecord | null>;

  /** SRI-028 to SRI-030. Leaves a PREPARED voucher with its reason. */
  block(id: string, reason: BlockedReason): Promise<void>;

  /** SRI-031. PREPARED → SIGNED with the bytes that will be sent. */
  markSigned(
    id: string,
    signed: {
      unsignedXml: string;
      signedXml: string;
      certificateId: string;
      signedAt: Date;
    },
  ): Promise<void>;

  /**
   * SRI-058. RETURNED / NOT_AUTHORISED → PREPARED with a recomposed XML, the
   * invoice back to ISSUED. The key does not move (the database refuses).
   */
  reopen(id: string, unsignedXml: string): Promise<boolean>;

  /** SRI-051, SRI-057. The attempt row and its effect, in one transaction. */
  recordAttempt(
    id: string,
    attempt: AttemptRecord,
    effect: AttemptEffect,
  ): Promise<boolean>;

  /** SRI-052. When the next job will run, for the monitor. */
  scheduleNext(id: string, nextAttemptAt: Date | null): Promise<void>;

  /** SRI-074 to SRI-076. Only the delivery columns move. */
  recordDelivery(id: string, status: DeliveryStatus, at: Date): Promise<void>;

  /** SRI-056. What the sweep has to look at. */
  pendingWork(limit: number): Promise<{
    invoicesWithoutVoucher: string[];
    unsigned: VoucherRecord[];
    inFlight: VoucherRecord[];
    undelivered: VoucherRecord[];
  }>;

  monitor(sites: readonly string[] | 'all'): Promise<MonitorRow[]>;
  statusOfInvoices(invoiceIds: readonly string[]): Promise<VoucherStatusView[]>;

  /** What `RIDE_ISSUER` and the e-mail need about the invoice (SRI-072). */
  deliveryContext(id: string): Promise<{
    invoiceId: string;
    issuedById: string;
    buyerEmail: string | null;
    buyerName: string;
    documentNumber: string;
    establishmentName: string;
  } | null>;
}
export const ELECTRONIC_VOUCHER_REPOSITORY = Symbol(
  'ElectronicVoucherRepository',
);

/** The certificate as stored: envelopes and what may be said about it. */
export interface StoredCertificate {
  id: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  active: boolean;
  createdAt: Date;
  encryptedPkcs12: Buffer;
  encryptedPassword: Buffer;
  kdfSalt: Buffer;
}

export type CertificateSummary = Omit<
  StoredCertificate,
  'encryptedPkcs12' | 'encryptedPassword' | 'kdfSalt'
>;

export interface SigningCertificateRepository {
  active(): Promise<StoredCertificate | null>;
  /** SRI-080. Activates it and deactivates the previous one, in one transaction. */
  createActive(
    certificate: Omit<StoredCertificate, 'id' | 'active' | 'createdAt'> & {
      uploadedById: string;
    },
  ): Promise<CertificateSummary>;
  list(): Promise<CertificateSummary[]>;
  /** SRI-026. Throws if the row cannot be written: then nothing is signed. */
  recordOpening(certificateId: string, voucherId: string): Promise<void>;
}
export const SIGNING_CERTIFICATE_REPOSITORY = Symbol(
  'SigningCertificateRepository',
);

/** SRI-040. How the next step is put in the persistent queue. */
export interface VoucherQueue {
  schedule(
    step: QueueStep,
    voucher: { id: string; accessKey: string },
    delaySeconds: number,
  ): Promise<void>;
}
export const VOUCHER_QUEUE = Symbol('VoucherQueue');
