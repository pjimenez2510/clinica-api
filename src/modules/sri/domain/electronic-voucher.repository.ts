import type { SriEnvironment } from './access-key';
import type { RimpeRegime, VoucherLine, VoucherTotals } from './invoice-xml';
import type {
  BlockedReason,
  QueueStep,
  SriFailedResponse,
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
    /** OR-031. A person stated the fiscal flags above; false, never. */
    fiscalProfileDeclared: boolean;
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

/**
 * The document a voucher is of (SRI-086): exactly one, and the database says
 * so (`electronic_voucher_one_document`).
 */
export type VoucherDocument =
  | { kind: 'INVOICE'; invoiceId: string }
  | { kind: 'CREDIT_NOTE'; creditNoteId: string };

/** SRI table 3, by the document. */
export function documentTypeOf(document: VoucherDocument): '01' | '04' {
  return document.kind === 'INVOICE' ? '01' : '04';
}

/**
 * Everything an issued credit note offers to become a voucher (SRI-085): what
 * was copied onto it when it was issued, the invoice it modifies as ITS key
 * says, and the issuer as the installation says now — like the invoice's.
 */
export interface CreditNotePreparationSource extends Omit<
  PreparationSource,
  'invoiceId' | 'invoiceStatus' | 'paymentMethod'
> {
  creditNoteId: string;
  creditNoteStatus: string;
  reason: string;
  /** The invoice's key: its series, sequential and date are read from it. */
  modifiedInvoiceKey: string;
}

/** A voucher as the application handles it. */
export interface VoucherRecord {
  id: string;
  document: VoucherDocument;
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
  /** SRI-074. When the SRI authorised it; the e-mail's retries grow from it. */
  authorisedAt: Date | null;
  deliveryStatus: DeliveryStatus | null;
}

/** SRI-091. `UNDELIVERABLE`: the relay still refusing the address 72 h after the authorisation; never retried. */
export type DeliveryStatus =
  'PENDING' | 'SENT' | 'NO_EMAIL' | 'FAILED' | 'UNDELIVERABLE';

/** SRI-100. A copy of a voucher that left, to whom and by whom. */
export interface VoucherMailing {
  voucherId: string;
  sentById: string;
  sentAt: Date;
  recipient: string;
  /** SRI-095. The document's buyer address: their delivery is now done. */
  toBuyer: boolean;
}

/** SRI-098. What the monitor says about e-mails the relay keeps refusing. */
export interface StalledDeliveries {
  count: number;
  oldestAuthorisedAt: Date | null;
}

export interface NewVoucher {
  document: VoucherDocument;
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
  /** SRI-059. What the SRI answered, when the failure had an answer. */
  transportResponse: SriFailedResponse | null;
}

/** What an attempt changes, applied in one transaction with the attempt row. */
export interface AttemptEffect {
  /** SRI-057. Applied only if the voucher is still in this status. */
  expectedStatus: VoucherStatus;
  status: VoucherStatus;
  documentStatus: 'AUTHORISED' | 'REJECTED' | null;
  lastMessages: SriMessage[] | null;
  nextAttemptAt: Date | null;
  authorisation: {
    number: string;
    authorisedAt: Date;
    authorisedXml: string;
  } | null;
}

/**
 * SRI-069. The last attempt, when it was a transport failure: what the SRI
 * said, without the body — that one is asked for apart.
 */
export interface LastTransportFailure {
  at: Date;
  httpStatus: number | null;
  faultCode: string | null;
  /** D-107. The first 500 characters of the fault string, with the cut mark. */
  faultSummary: string | null;
  /** Why, in one line — only when there is no `faultString` to say it. */
  error: string | null;
  hasResponseBody: boolean;
}

/** SRI-069. The same failure with its detail and its body. */
export interface TransportFailureDetail extends Omit<
  LastTransportFailure,
  'hasResponseBody' | 'error' | 'faultSummary'
> {
  error: string;
  /** Whole, as SRI-059 kept it. */
  faultString: string | null;
  faultDetail: string | null;
  responseBody: string | null;
}

/** One row of the monitor (SRI-061). Never a clinical datum (SRI-067). */
export interface MonitorRow {
  /** SRI-088. Which document the row is. */
  document: 'INVOICE' | 'CREDIT_NOTE';
  /** The invoice, or the one the credit note modifies. */
  invoiceId: string;
  creditNoteId: string | null;
  /** SRI-088. The number of the invoice a credit note modifies. */
  modifiedDocumentNumber: string | null;
  /**
   * BI-303. A credit note's reason code: which corrections its «Editar»
   * admits; `null` for an invoice.
   */
  creditNoteReasonCode: string | null;
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
  /** SRI-062. The SRI's last reception of it; `null` while it has none. */
  receivedAt: Date | null;
  /** SRI-069. `null` unless the last attempt was a transport failure. */
  lastTransportFailure: LastTransportFailure | null;
  /** SRI-108. Whether the SRI ever authorised it, by number or by attempt. */
  authorisationNumber: string | null;
  everAuthorised: boolean;
}

/**
 * SRI-109. A number of a document the SRI returned with the 45, and what
 * replaced it; read from `voucher_renumbering`.
 */
export interface RenumberingView {
  /** The invoice's or the credit note's id. */
  documentId: string;
  /** The number the SRI already held, as it was printed: `001-001-000000019`. */
  previousNumber: string;
  newSequential: string;
  renumberedAt: Date;
  renumberedByName: string;
  sriMessage: string;
}

/** SRI-108. What decides whether a voucher is renumbered, read under lock. */
export interface RenumberCandidate {
  status: VoucherStatus;
  authorisationNumber: string | null;
  everAuthorised: boolean;
  lastMessages: SriMessage[];
  /** `REJECTED` is the only one renumbered; a withdrawn note is not. */
  documentStatus: string;
}

/** SRI-109. What a renumbering did. */
export interface Renumbered {
  document: VoucherDocument;
  siteId: string;
  previousSequential: string;
  newSequential: string;
}

/** The voucher's state as `billing` shows it beside the invoice (SRI-060). */
export interface VoucherStatusView {
  /** The invoice's or the credit note's id, whichever was asked for. */
  documentId: string;
  voucherId: string;
  status: VoucherStatus;
  blockedReason: BlockedReason | null;
  accessKey: string;
  authorisedAt: Date | null;
  deliveryStatus: DeliveryStatus | null;
  lastMessages: SriMessage[];
  /** SRI-108. Whether the SRI ever authorised it, by number or by attempt. */
  authorisationNumber: string | null;
  everAuthorised: boolean;
  /** SRI-110. The invoice's or the credit note's status. */
  documentStatus: string;
}

export interface ElectronicVoucherRepository {
  preparationSource(invoiceId: string): Promise<PreparationSource | null>;
  /** SRI-085. `null` when the credit note does not exist. */
  creditNotePreparationSource(
    creditNoteId: string,
  ): Promise<CreditNotePreparationSource | null>;

  /**
   * SRI-001, SRI-005, SRI-007, SRI-086. Inserts the voucher AND writes its
   * key on its invoice or credit note in one transaction. If another process
   * prepared the same document first (`electronic_voucher_one_per_invoice`,
   * `…_one_per_credit_note`), returns THAT voucher: the key is never computed
   * twice for one document.
   */
  create(voucher: NewVoucher): Promise<VoucherRecord>;

  /** SRI-109. The renumberings of these documents, oldest first. */
  renumberingsOf(documents: {
    invoiceIds: readonly string[];
    creditNoteIds: readonly string[];
  }): Promise<RenumberingView[]>;

  /** SRI-112. A SUPERSEDED voucher is not found by id: it has no document. */
  findById(id: string): Promise<VoucherRecord | null>;
  /** SRI-110. The site of any voucher, SUPERSEDED included. */
  siteOf(id: string): Promise<string | null>;
  findByInvoice(invoiceId: string): Promise<VoucherRecord | null>;
  findByCreditNote(creditNoteId: string): Promise<VoucherRecord | null>;
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
   * SRI-058. RETURNED / NOT_AUTHORISED → PREPARED with a recomposed XML, its
   * invoice or credit note back to ISSUED. The key does not move (the database refuses).
   */
  reopen(id: string, unsignedXml: string): Promise<boolean>;

  /**
   * SRI-109, SRI-111. Under the voucher's and the document's row locks, and
   * only if `admits` says so of what it reads there: the next number of the
   * point (`next_voucher_sequential`), the row of `voucher_renumbering`, the
   * document ISSUED with the new number and no key, and the voucher
   * SUPERSEDED with no document — in one transaction. `null` when it does not
   * admit it, or the voucher is not there.
   */
  /**
   * SRI-108. What decides a renumbering, read WITHOUT locks: only to know
   * whether the SRI is worth asking before `renumber` decides under lock.
   */
  renumberCandidate(id: string): Promise<RenumberCandidate | null>;

  renumber(
    id: string,
    by: { userId: string; at: Date },
    admits: (voucher: RenumberCandidate) => boolean,
  ): Promise<Renumbered | null>;

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

  /**
   * SRI-100, SRI-095. One copy that LEFT, in one transaction: its row in
   * `electronic_voucher_mailing` and, when it went to the buyer, the buyer's
   * delivery noted `SENT` if it was still owed.
   */
  recordMailing(mailing: VoucherMailing): Promise<void>;

  /** SRI-101. The copies `userId` e-mailed from `since` on. */
  countMailingsSince(userId: string, since: Date): Promise<number>;

  /**
   * SRI-098. Authorised vouchers whose e-mail is still `FAILED` and were
   * authorised at or before `authorisedBefore`, in the sites.
   */
  stalledDeliveries(
    sites: readonly string[] | 'all',
    authorisedBefore: Date,
  ): Promise<StalledDeliveries>;

  /** SRI-084. Releases what waited for a certificate, for the sweep to sign. */
  unblockForCertificate(): Promise<number>;

  /**
   * SRI-056. What the sweep has to look at: unsigned vouchers it can retry
   * (`SWEPT_REASONS`), in-flight ones whose next attempt is due at `now`.
   */
  pendingWork(
    limit: number,
    now: Date,
    /** SRI-055. In-flight vouchers of the other environment are left out. */
    environment: SriEnvironment,
  ): Promise<{
    invoicesWithoutVoucher: string[];
    /** SRI-087. The same, for credit notes. */
    creditNotesWithoutVoucher: string[];
    unsigned: VoucherRecord[];
    inFlight: VoucherRecord[];
    undelivered: VoucherRecord[];
  }>;

  monitor(sites: readonly string[] | 'all'): Promise<MonitorRow[]>;
  /** SRI-069. The voucher's last attempt, if it was a transport failure. */
  lastTransportFailure(
    voucherId: string,
  ): Promise<TransportFailureDetail | null>;
  statusOfInvoices(invoiceIds: readonly string[]): Promise<VoucherStatusView[]>;
  /** SRI-088. The same beside each credit note. */
  statusOfCreditNotes(
    creditNoteIds: readonly string[],
  ): Promise<VoucherStatusView[]>;

  /**
   * What `RIDE_ISSUER` and the e-mail need about the voucher's document: the
   * invoice (SRI-072) or the credit note (SRI-089).
   */
  deliveryContext(id: string): Promise<DeliveryContext | null>;
}

/** SRI-072, SRI-089. The receiver and the document an e-mail is about. */
export type DeliveryContext = {
  /** Whoever issued the document: the RIDE is filed in their name. */
  issuedById: string;
  /**
   * SRI-096. The DOCUMENT's own status (`AUTHORISED`, `VOIDED`…): a voided
   * invoice keeps its authorised voucher, and is not sent out again.
   */
  documentStatus: string;
  buyerEmail: string | null;
  buyerName: string;
  /** `001-001-000000123`, the document's own. */
  documentNumber: string;
  establishmentName: string;
} & (
  | { document: 'INVOICE'; invoiceId: string }
  | { document: 'CREDIT_NOTE'; creditNoteId: string }
);
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
  /** SRI-102. As the certificate states it; `null` if it does not. */
  holderRuc: string | null;
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
  /** SRI-102. The establishment's RUC and every site's own, if any. */
  issuerRucs(): Promise<string[]>;
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
