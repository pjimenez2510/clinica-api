import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { invoiceDocumentNumber } from '../../../shared/billing/document-number';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { SriEnvironment } from '../domain/access-key';
import {
  documentTypeOf,
  type AttemptEffect,
  type AttemptRecord,
  type CreditNotePreparationSource,
  type DeliveryContext,
  type DeliveryStatus,
  type ElectronicVoucherRepository,
  type LastTransportFailure,
  type MonitorRow,
  type NewVoucher,
  type PreparationSource,
  type TransportFailureDetail,
  type VoucherRecord,
  type VoucherDocument,
  type VoucherStatusView,
} from '../domain/electronic-voucher.repository';
import {
  CERTIFICATE_REASONS,
  SWEPT_REASONS,
  type BlockedReason,
  type SriMessage,
  type VoucherStatus,
} from '../domain/voucher-lifecycle';
import { summaryOf } from '../domain/kept-text';

const VOUCHER_SELECT = {
  id: true,
  invoiceId: true,
  creditNoteId: true,
  siteId: true,
  accessKey: true,
  numericCode: true,
  environment: true,
  status: true,
  blockedReason: true,
  unsignedXml: true,
  signedXml: true,
  signedAt: true,
  attemptCount: true,
  nextAttemptAt: true,
  authorisedXml: true,
  authorisedAt: true,
  deliveryStatus: true,
} satisfies Prisma.ElectronicVoucherSelect;

type VoucherRow = Prisma.ElectronicVoucherGetPayload<{
  select: typeof VOUCHER_SELECT;
}>;

/**
 * The invoice a voucher belongs to, on the paths that only concern invoices.
 * The database guarantees a `01` voucher carries its invoice
 * (`electronic_voucher_type_matches_its_document`).
 */
function invoiceIdOf(row: { id: string; invoiceId: string | null }): string {
  if (row.invoiceId === null) {
    throw new Error(`Voucher ${row.id} is not an invoice's voucher`);
  }
  return row.invoiceId;
}

/** SRI-086. The database guarantees exactly one of the two. */
function documentOf(row: {
  id: string;
  invoiceId: string | null;
  creditNoteId: string | null;
}): VoucherDocument {
  if (row.creditNoteId !== null) {
    return { kind: 'CREDIT_NOTE', creditNoteId: row.creditNoteId };
  }
  return { kind: 'INVOICE', invoiceId: invoiceIdOf(row) };
}

function toRecord(row: VoucherRow): VoucherRecord {
  const { invoiceId, creditNoteId, ...rest } = row;
  return {
    ...rest,
    document: documentOf({ id: row.id, invoiceId, creditNoteId }),
    environment: row.environment as SriEnvironment,
    status: row.status as VoucherStatus,
    blockedReason: row.blockedReason as BlockedReason | null,
    deliveryStatus: row.deliveryStatus as DeliveryStatus | null,
  };
}

function messagesOf(value: Prisma.JsonValue): SriMessage[] {
  return Array.isArray(value) ? (value as unknown as SriMessage[]) : [];
}

const asJson = (messages: SriMessage[]): Prisma.InputJsonValue =>
  messages as unknown as Prisma.InputJsonValue;

/** What a voucher reads of the site and its establishment (SRI-018). */
const ISSUER_SITE_SELECT = {
  ruc: true,
  addressLine: true,
  sriEstablishmentCode: true,
  establishment: {
    select: {
      legalName: true,
      ruc: true,
      headOfficeAddress: true,
      keepsAccounting: true,
      specialTaxpayerResolution: true,
      withholdingAgentResolution: true,
      rimpeRegime: true,
      fiscalProfileDeclaredAt: true,
    },
  },
} satisfies Prisma.SiteSelect;

function issuerOf(
  site: Prisma.SiteGetPayload<{ select: typeof ISSUER_SITE_SELECT }>,
): PreparationSource['issuer'] {
  const { establishment } = site;
  return {
    // The same precedence the RIDE prints (DOC-077): the site's own RUC,
    // else the establishment's; the legal name is the establishment's.
    // OR-032: every site has its establishment.
    ruc: site.ruc ?? establishment.ruc,
    legalName: establishment.legalName,
    headOfficeAddress: establishment.headOfficeAddress,
    establishmentAddress: site.addressLine,
    keepsAccounting: establishment.keepsAccounting,
    specialTaxpayerResolution: establishment.specialTaxpayerResolution,
    withholdingAgentResolution: establishment.withholdingAgentResolution,
    rimpeRegime: establishment.rimpeRegime,
    fiscalProfileDeclared: establishment.fiscalProfileDeclaredAt !== null,
  };
}

const amount = (value: Prisma.Decimal) => value.toFixed(2);

function totalsOf(row: {
  subtotalTaxed: Prisma.Decimal;
  subtotalUntaxed: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  amount: Prisma.Decimal;
}): PreparationSource['totals'] {
  return {
    subtotalTaxed: amount(row.subtotalTaxed),
    subtotalUntaxed: amount(row.subtotalUntaxed),
    discountTotal: amount(row.discountTotal),
    taxTotal: amount(row.taxTotal),
    total: amount(row.amount),
  };
}

/** SRI-060, SRI-088. What `billing` shows beside each document. */
const STATUS_SELECT = {
  id: true,
  invoiceId: true,
  creditNoteId: true,
  status: true,
  blockedReason: true,
  accessKey: true,
  authorisedAt: true,
  deliveryStatus: true,
  lastMessages: true,
} satisfies Prisma.ElectronicVoucherSelect;

function toStatusView(
  row: Prisma.ElectronicVoucherGetPayload<{ select: typeof STATUS_SELECT }>,
  documentId: string,
): VoucherStatusView {
  return {
    documentId,
    voucherId: row.id,
    status: row.status as VoucherStatus,
    blockedReason: row.blockedReason as BlockedReason | null,
    accessKey: row.accessKey,
    authorisedAt: row.authorisedAt,
    deliveryStatus: row.deliveryStatus as DeliveryStatus | null,
    lastMessages: messagesOf(row.lastMessages),
  };
}

/** SRI-061. What the monitor reads of an emission point. */
const MONITOR_POINT_SELECT = {
  code: true,
  site: { select: { sriEstablishmentCode: true } },
} satisfies Prisma.EmissionPointSelect;

/** SRI-061, SRI-062. What the monitor reads of a voucher. */
const MONITOR_VOUCHER_SELECT = {
  id: true,
  status: true,
  blockedReason: true,
  accessKey: true,
  lastMessages: true,
  attemptCount: true,
  nextAttemptAt: true,
  // SRI-062. When the SRI last took it in: a day without an answer is
  // counted from here, not from the issuance.
  attempts: {
    where: {
      operation: 'RECEPTION',
      outcome: { in: ['RECIBIDA', 'DEVUELTA'] },
    },
    orderBy: { startedAt: 'desc' },
    take: 1,
    select: { startedAt: true },
  },
} satisfies Prisma.ElectronicVoucherSelect;

type MonitorVoucherRow = Prisma.ElectronicVoucherGetPayload<{
  select: typeof MONITOR_VOUCHER_SELECT;
}>;

/** SRI-084. How often the sweep retries what only a certificate fixes. */
const CERTIFICATE_RETRY_MS = 3600 * 1000;

/** The statuses the queue is still working on (SRI-056). */
const IN_FLIGHT: VoucherStatus[] = ['SIGNED', 'RECEIVED'];

/**
 * The voucher, its attempts and the two columns of `invoice` this module
 * writes: the key and what the SRI decided.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE WRITES ON `invoice`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `invoice.access_key`, `invoice.status ∈ {AUTHORISED, REJECTED}` and
 * `invoice.authorised_at` ARE the voucher's state, copied where `billing`,
 * `documents` and `trg_invoice_immutable` read it. They are written in the
 * SAME transaction as the voucher row, so the invoice and its voucher can
 * never tell two stories — and the database backs it: the invoice can only
 * carry its own voucher's key (`invoice_access_key_is_its_vouchers`) and never
 * another once written (`trg_invoice_access_key_permanent`). Nothing else of
 * the invoice is touched here.
 */
@Injectable()
export class PrismaElectronicVoucherRepository implements ElectronicVoucherRepository {
  constructor(private readonly prisma: PrismaService) {}

  async preparationSource(
    invoiceId: string,
  ): Promise<PreparationSource | null> {
    const row = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        siteId: true,
        status: true,
        issuedAt: true,
        sequential: true,
        buyerIdentificationType: true,
        buyerIdentification: true,
        buyerName: true,
        buyerEmail: true,
        paymentMethod: true,
        subtotalTaxed: true,
        subtotalUntaxed: true,
        discountTotal: true,
        taxTotal: true,
        total: true,
        emissionPoint: { select: { code: true } },
        site: { select: ISSUER_SITE_SELECT },
        // BI-169, SRI-012. THIS invoice's charges, with what was frozen on them.
        chargeItems: {
          orderBy: { createdAt: 'asc' },
          select: {
            serviceDisplay: true,
            quantity: true,
            unitAmount: true,
            discountAmount: true,
            taxSriCode: true,
            taxPercentage: true,
            billableService: { select: { code: true } },
          },
        },
      },
    });
    if (!row || !row.issuedAt) return null;

    return {
      invoiceId: row.id,
      siteId: row.siteId,
      invoiceStatus: row.status,
      issuedAt: row.issuedAt,
      sequential: row.sequential,
      emissionPointCode: row.emissionPoint.code,
      establishmentCode: row.site.sriEstablishmentCode,
      issuer: issuerOf(row.site),
      buyer: {
        identificationType: row.buyerIdentificationType,
        identification: row.buyerIdentification,
        name: row.buyerName,
        email: row.buyerEmail,
      },
      lines: row.chargeItems.map((charge) => ({
        code: charge.billableService.code,
        description: charge.serviceDisplay,
        quantity: charge.quantity.toFixed(3),
        unitPrice: amount(charge.unitAmount),
        discount: amount(charge.discountAmount),
        taxSriCode: charge.taxSriCode,
        // «No objeto» and «exento» carry no rate: the SRI's `tarifa` is 0.
        taxPercentage: charge.taxPercentage?.toFixed(2) ?? '0.00',
      })),
      totals: totalsOf({ ...row, amount: row.total }),
      paymentMethod: row.paymentMethod,
    };
  }

  async creditNotePreparationSource(
    creditNoteId: string,
  ): Promise<CreditNotePreparationSource | null> {
    const row = await this.prisma.creditNote.findUnique({
      where: { id: creditNoteId },
      select: {
        id: true,
        siteId: true,
        status: true,
        issuedAt: true,
        sequential: true,
        reason: true,
        buyerIdentificationType: true,
        buyerIdentification: true,
        buyerName: true,
        buyerEmail: true,
        subtotalTaxed: true,
        subtotalUntaxed: true,
        discountTotal: true,
        taxTotal: true,
        amount: true,
        emissionPoint: { select: { code: true } },
        site: { select: ISSUER_SITE_SELECT },
        invoice: { select: { accessKey: true } },
        // BI-210, SRI-085. The credited lines, as they were copied.
        lines: {
          orderBy: { createdAt: 'asc' },
          select: {
            serviceCode: true,
            description: true,
            quantity: true,
            unitAmount: true,
            discountAmount: true,
            taxSriCode: true,
            taxPercentage: true,
          },
        },
      },
    });
    // An authorised invoice always carries its key (BI-208,
    // `invoice_authorised_carries_its_key`).
    if (!row || !row.issuedAt || !row.invoice.accessKey) return null;

    return {
      creditNoteId: row.id,
      siteId: row.siteId,
      creditNoteStatus: row.status,
      issuedAt: row.issuedAt,
      sequential: row.sequential,
      emissionPointCode: row.emissionPoint.code,
      establishmentCode: row.site.sriEstablishmentCode,
      issuer: issuerOf(row.site),
      buyer: {
        identificationType: row.buyerIdentificationType,
        identification: row.buyerIdentification,
        name: row.buyerName,
        email: row.buyerEmail,
      },
      lines: row.lines.map((line) => ({
        code: line.serviceCode,
        description: line.description,
        quantity: line.quantity.toFixed(3),
        unitPrice: amount(line.unitAmount),
        discount: amount(line.discountAmount),
        taxSriCode: line.taxSriCode,
        taxPercentage: line.taxPercentage?.toFixed(2) ?? '0.00',
      })),
      totals: totalsOf(row),
      reason: row.reason,
      modifiedInvoiceKey: row.invoice.accessKey,
    };
  }

  async create(voucher: NewVoucher): Promise<VoucherRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { document } = voucher;
        const created = await tx.electronicVoucher.create({
          data: {
            ...(document.kind === 'INVOICE'
              ? { invoiceId: document.invoiceId }
              : { creditNoteId: document.creditNoteId }),
            documentType: documentTypeOf(document),
            siteId: voucher.siteId,
            accessKey: voucher.accessKey,
            numericCode: voucher.numericCode,
            environment: voucher.environment,
            schemaVersion: voucher.schemaVersion,
            unsignedXml: voucher.unsignedXml,
            blockedReason: voucher.blockedReason,
          },
          select: VOUCHER_SELECT,
        });
        // SRI-007, SRI-086. The key on its document, in the same breath, so
        // the RIDE handed over now already carries it (SRI-071).
        if (document.kind === 'INVOICE') {
          await tx.invoice.update({
            where: { id: document.invoiceId },
            data: { accessKey: voucher.accessKey },
          });
        } else {
          await tx.creditNote.update({
            where: { id: document.creditNoteId },
            data: { accessKey: voucher.accessKey },
          });
        }
        return toRecord(created);
      });
    } catch (error) {
      // SRI-006. Another process prepared this invoice a moment earlier: its
      // voucher is THE voucher, and its key is the one that stands.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing =
          voucher.document.kind === 'INVOICE'
            ? await this.findByInvoice(voucher.document.invoiceId)
            : await this.findByCreditNote(voucher.document.creditNoteId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<VoucherRecord | null> {
    const row = await this.prisma.electronicVoucher.findUnique({
      where: { id },
      select: VOUCHER_SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async findByInvoice(invoiceId: string): Promise<VoucherRecord | null> {
    const row = await this.prisma.electronicVoucher.findUnique({
      where: { invoiceId },
      select: VOUCHER_SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async findByCreditNote(creditNoteId: string): Promise<VoucherRecord | null> {
    const row = await this.prisma.electronicVoucher.findUnique({
      where: { creditNoteId },
      select: VOUCHER_SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async findByIdInSites(
    id: string,
    sites: readonly string[] | 'all',
  ): Promise<VoucherRecord | null> {
    const row = await this.prisma.electronicVoucher.findFirst({
      where: { id, ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }) },
      select: VOUCHER_SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async block(id: string, reason: BlockedReason): Promise<void> {
    // `updated_at` moves every time, same reason or not: the sweep retries a
    // certificate's reason an hour after it was last seen (SRI-056).
    await this.prisma.electronicVoucher.updateMany({
      where: { id, status: 'PREPARED' },
      data: { blockedReason: reason, updatedAt: new Date() },
    });
  }

  async markSigned(
    id: string,
    signed: {
      unsignedXml: string;
      signedXml: string;
      certificateId: string;
      signedAt: Date;
    },
  ): Promise<void> {
    await this.prisma.electronicVoucher.updateMany({
      where: { id, status: 'PREPARED' },
      data: {
        status: 'SIGNED',
        blockedReason: null,
        unsignedXml: signed.unsignedXml,
        signedXml: signed.signedXml,
        signingCertificateId: signed.certificateId,
        signedAt: signed.signedAt,
      },
    });
  }

  async reopen(id: string, unsignedXml: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const voucher = await tx.electronicVoucher.updateMany({
        where: { id, status: { in: ['RETURNED', 'NOT_AUTHORISED'] } },
        data: {
          status: 'PREPARED',
          unsignedXml,
          signedXml: null,
          signingCertificateId: null,
          signedAt: null,
          nextAttemptAt: null,
          // SRI-052. A re-send starts its own waits: the history stays in
          // `electronic_voucher_attempt`, not in a count that makes the first
          // retry wait an hour.
          attemptCount: 0,
        },
      });
      if (voucher.count === 0) return false;
      const row = await tx.electronicVoucher.findUniqueOrThrow({
        where: { id },
        select: { id: true, invoiceId: true, creditNoteId: true },
      });
      // SRI-058. Back to ISSUED: it is not rejected while it is being re-sent.
      const document = documentOf(row);
      if (document.kind === 'INVOICE') {
        await tx.invoice.updateMany({
          where: { id: document.invoiceId, status: 'REJECTED' },
          data: { status: 'ISSUED' },
        });
      } else {
        await tx.creditNote.updateMany({
          where: { id: document.creditNoteId, status: 'REJECTED' },
          data: { status: 'ISSUED' },
        });
      }
      return true;
    });
  }

  async recordAttempt(
    id: string,
    attempt: AttemptRecord,
    effect: AttemptEffect,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // SRI-057. The row lock serialises two jobs of the same voucher; the
      // status check makes the second one a no-op.
      const [locked] = await tx.$queryRaw<
        {
          status: string;
          access_key: string;
          invoice_id: string | null;
          credit_note_id: string | null;
        }[]
      >`
        SELECT "status", "access_key", "invoice_id", "credit_note_id"
          FROM "electronic_voucher"
         WHERE "id" = ${id}::uuid
           FOR UPDATE`;
      if (!locked || locked.status !== effect.expectedStatus) return false;

      await tx.electronicVoucherAttempt.create({
        data: {
          voucherId: id,
          accessKey: locked.access_key,
          operation: attempt.operation,
          startedAt: attempt.startedAt,
          durationMs: attempt.durationMs,
          outcome: attempt.outcome,
          messages: asJson(attempt.messages),
          // SRI-059. Whole: the client already capped it, with the cut marked.
          transportError: attempt.transportError,
          httpStatus: attempt.transportResponse?.httpStatus ?? null,
          faultCode: attempt.transportResponse?.faultCode ?? null,
          faultString: attempt.transportResponse?.faultString ?? null,
          faultDetail: attempt.transportResponse?.faultDetail ?? null,
          responseBody: attempt.transportResponse?.responseBody ?? null,
        },
      });

      await tx.electronicVoucher.update({
        where: { id },
        data: {
          status: effect.status,
          attemptCount: { increment: 1 },
          nextAttemptAt: effect.nextAttemptAt,
          ...(effect.lastMessages === null
            ? {}
            : { lastMessages: asJson(effect.lastMessages) }),
          ...(effect.authorisation === null
            ? {}
            : {
                authorisationNumber: effect.authorisation.number,
                authorisedAt: effect.authorisation.authorisedAt,
                authorisedXml: effect.authorisation.authorisedXml,
                deliveryStatus: 'PENDING',
              }),
        },
      });

      if (effect.documentStatus !== null && locked.credit_note_id !== null) {
        // SRI-087. The credit note follows its voucher the same way.
        await tx.creditNote.updateMany({
          where: {
            id: locked.credit_note_id,
            status: { in: ['ISSUED', 'REJECTED'] },
          },
          data: { status: effect.documentStatus },
        });
      } else if (effect.documentStatus !== null && locked.invoice_id !== null) {
        // Only an invoice still in the SRI's hands: a voided one (billing B3)
        // keeps its status whatever answer arrives late.
        await tx.invoice.updateMany({
          where: {
            id: locked.invoice_id,
            status: { in: ['ISSUED', 'REJECTED'] },
          },
          data: {
            status: effect.documentStatus,
            ...(effect.authorisation
              ? { authorisedAt: effect.authorisation.authorisedAt }
              : {}),
          },
        });
      }
      return true;
    });
  }

  async scheduleNext(id: string, nextAttemptAt: Date | null): Promise<void> {
    await this.prisma.electronicVoucher.update({
      where: { id },
      data: { nextAttemptAt },
    });
  }

  async recordDelivery(
    id: string,
    status: DeliveryStatus,
    at: Date,
  ): Promise<void> {
    await this.prisma.electronicVoucher.updateMany({
      where: { id, status: 'AUTHORISED' },
      data: {
        deliveryStatus: status,
        deliveredAt: status === 'SENT' ? at : null,
      },
    });
  }

  async unblockForCertificate(): Promise<number> {
    const { count } = await this.prisma.electronicVoucher.updateMany({
      where: {
        status: 'PREPARED',
        blockedReason: { in: [...CERTIFICATE_REASONS] },
      },
      data: { blockedReason: null },
    });
    return count;
  }

  async pendingWork(limit: number, now: Date, environment: SriEnvironment) {
    const anHourAgo = new Date(now.getTime() - CERTIFICATE_RETRY_MS);
    const issuerReady = {
      sriEstablishmentCode: { not: null },
      establishment: {
        is: {
          headOfficeAddress: { not: null },
          fiscalProfileDeclaredAt: { not: null },
        },
      },
    } satisfies Prisma.SiteWhereInput;
    const [
      withoutVoucher,
      creditNotesWithoutVoucher,
      unsigned,
      inFlight,
      undelivered,
    ] = await Promise.all([
      // SRI-008. An invoice whose site or establishment still lacks the
      // data is shown by the monitor; here it would only take a place that
      // a recoverable one —a notice lost to a database hiccup— needs.
      this.prisma.invoice.findMany({
        where: {
          status: 'ISSUED',
          electronicVoucher: null,
          site: issuerReady,
        },
        orderBy: { issuedAt: 'asc' },
        take: limit,
        select: { id: true },
      }),
      // SRI-087. The same for the credit notes.
      this.prisma.creditNote.findMany({
        where: {
          status: 'ISSUED',
          electronicVoucher: null,
          site: issuerReady,
        },
        orderBy: { issuedAt: 'asc' },
        take: limit,
        select: { id: true },
      }),
      this.prisma.electronicVoucher.findMany({
        where: {
          status: 'PREPARED',
          OR: [
            { blockedReason: null },
            { blockedReason: { in: [...SWEPT_REASONS] } },
            // SRI-084. What only a certificate fixes is retried hourly as
            // well: a certificate that became valid, a signature that failed
            // for a defect since deployed, an upload that raced the block.
            {
              blockedReason: { in: [...CERTIFICATE_REASONS] },
              updatedAt: { lte: anHourAgo },
            },
          ],
        },
        // What nobody blocked first: a broken site cannot hold the places.
        orderBy: [
          { blockedReason: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
        take: limit,
        select: VOUCHER_SELECT,
      }),
      this.prisma.electronicVoucher.findMany({
        where: {
          status: { in: IN_FLIGHT },
          // SRI-055. A voucher of the other environment is not sent; it
          // waits in the monitor for a person (D-102).
          environment,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: VOUCHER_SELECT,
      }),
      this.prisma.electronicVoucher.findMany({
        where: {
          status: 'AUTHORISED',
          OR: [
            { deliveryStatus: null },
            { deliveryStatus: { in: ['PENDING', 'FAILED'] } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: VOUCHER_SELECT,
      }),
    ] as const);
    return {
      invoicesWithoutVoucher: withoutVoucher.map((row) => row.id),
      creditNotesWithoutVoucher: creditNotesWithoutVoucher.map((row) => row.id),
      unsigned: unsigned.map(toRecord),
      inFlight: inFlight.map(toRecord),
      undelivered: undelivered.map(toRecord),
    };
  }

  /**
   * SRI-061. The invoices of the caller's sites that are not authorised: with
   * a voucher in any status but AUTHORISED, or issued and still without one.
   * Voided invoices are out of it — B3 will decide what a void is to the SRI.
   *
   * SRI-067. The select names no clinical column: an invoice, a buyer, a key.
   */
  async monitor(sites: readonly string[] | 'all'): Promise<MonitorRow[]> {
    const inSites = sites === 'all' ? {} : { siteId: { in: [...sites] } };
    const notAuthorised = {
      OR: [
        { electronicVoucher: null },
        { electronicVoucher: { status: { not: 'AUTHORISED' } } },
      ],
    };
    const [invoices, creditNotes] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          ...inSites,
          status: { in: ['ISSUED', 'REJECTED'] },
          ...notAuthorised,
        },
        orderBy: { issuedAt: 'desc' },
        take: 500,
        select: {
          id: true,
          siteId: true,
          sequential: true,
          buyerName: true,
          buyerIdentification: true,
          issuedAt: true,
          total: true,
          emissionPoint: { select: MONITOR_POINT_SELECT },
          electronicVoucher: { select: MONITOR_VOUCHER_SELECT },
        },
      }),
      // SRI-088. The credit notes the SRI has not authorised, the same way.
      this.prisma.creditNote.findMany({
        where: {
          ...inSites,
          status: { in: ['ISSUED', 'REJECTED'] },
          ...notAuthorised,
        },
        orderBy: { issuedAt: 'desc' },
        take: 500,
        select: {
          id: true,
          siteId: true,
          sequential: true,
          buyerName: true,
          buyerIdentification: true,
          issuedAt: true,
          amount: true,
          emissionPoint: { select: MONITOR_POINT_SELECT },
          electronicVoucher: { select: MONITOR_VOUCHER_SELECT },
          invoice: {
            select: {
              id: true,
              accessKey: true,
              sequential: true,
              emissionPoint: { select: MONITOR_POINT_SELECT },
            },
          },
        },
      }),
    ]);

    const failures = await this.lastTransportFailures(
      [...invoices, ...creditNotes].flatMap((row) =>
        row.electronicVoucher ? [row.electronicVoucher.id] : [],
      ),
    );

    const voucherPart = (
      voucher: MonitorVoucherRow | null,
    ): Pick<
      MonitorRow,
      | 'voucherId'
      | 'status'
      | 'blockedReason'
      | 'accessKey'
      | 'lastMessages'
      | 'attemptCount'
      | 'nextAttemptAt'
      | 'receivedAt'
      | 'lastTransportFailure'
    > => ({
      voucherId: voucher?.id ?? null,
      status: (voucher?.status ?? 'NO_VOUCHER') as MonitorRow['status'],
      blockedReason: (voucher?.blockedReason ?? null) as BlockedReason | null,
      accessKey: voucher?.accessKey ?? null,
      lastMessages: voucher ? messagesOf(voucher.lastMessages) : [],
      attemptCount: voucher?.attemptCount ?? 0,
      nextAttemptAt: voucher?.nextAttemptAt ?? null,
      receivedAt: voucher?.attempts[0]?.startedAt ?? null,
      lastTransportFailure: (voucher && failures.get(voucher.id)) ?? null,
    });

    return [
      ...invoices.map((row): MonitorRow => ({
        document: 'INVOICE',
        invoiceId: row.id,
        creditNoteId: null,
        modifiedDocumentNumber: null,
        siteId: row.siteId,
        documentNumber: invoiceDocumentNumber({
          accessKey: row.electronicVoucher?.accessKey ?? null,
          establishmentCode: row.emissionPoint.site.sriEstablishmentCode,
          emissionPointCode: row.emissionPoint.code,
          sequential: row.sequential,
        }),
        buyerName: row.buyerName,
        buyerIdentification: row.buyerIdentification,
        issuedAt: row.issuedAt ?? new Date(0),
        total: row.total.toFixed(2),
        ...voucherPart(row.electronicVoucher),
      })),
      ...creditNotes.map((row): MonitorRow => ({
        document: 'CREDIT_NOTE',
        invoiceId: row.invoice.id,
        creditNoteId: row.id,
        modifiedDocumentNumber: invoiceDocumentNumber({
          accessKey: row.invoice.accessKey,
          establishmentCode:
            row.invoice.emissionPoint.site.sriEstablishmentCode,
          emissionPointCode: row.invoice.emissionPoint.code,
          sequential: row.invoice.sequential,
        }),
        siteId: row.siteId,
        documentNumber: invoiceDocumentNumber({
          accessKey: row.electronicVoucher?.accessKey ?? null,
          establishmentCode: row.emissionPoint.site.sriEstablishmentCode,
          emissionPointCode: row.emissionPoint.code,
          sequential: row.sequential,
        }),
        buyerName: row.buyerName,
        buyerIdentification: row.buyerIdentification,
        issuedAt: row.issuedAt ?? new Date(0),
        total: row.amount.toFixed(2),
        ...voucherPart(row.electronicVoucher),
      })),
    ];
  }

  /**
   * SRI-069. Each voucher's LAST attempt, kept only if it failed in transport:
   * a later answer means the failure is over. The body stays in the database;
   * the monitor learns only whether there is one.
   */
  private async lastTransportFailures(
    voucherIds: readonly string[],
  ): Promise<Map<string, LastTransportFailure>> {
    if (voucherIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      {
        voucher_id: string;
        outcome: string;
        started_at: Date;
        http_status: number | null;
        fault_code: string | null;
        fault_head: string | null;
        fault_left_out: number | null;
        transport_error: string | null;
        has_response_body: boolean;
      }[]
    >`
      SELECT v."id" AS "voucher_id", last."outcome", last."started_at",
             last."http_status", last."fault_code",
             -- D-107. The list carries the first 500 characters; the whole
             -- text is asked for apart, with the body.
             left(last."fault_string", 500) AS "fault_head",
             greatest(char_length(last."fault_string") - 500, 0)::int AS "fault_left_out",
             -- The one-line reason only when there is no fault string: it
             -- repeats it whole, and 500 rows of a 6 KB trace twice is what
             -- keeping the body out of the monitor was meant to avoid.
             CASE WHEN last."fault_string" IS NULL THEN last."transport_error" END
               AS "transport_error",
             last."response_body" IS NOT NULL AS "has_response_body"
        FROM "electronic_voucher" v
        -- One row per voucher off the (voucher_id, started_at) index, not
        -- every attempt of an append-only trail.
        CROSS JOIN LATERAL (
          SELECT a."outcome", a."started_at", a."http_status", a."fault_code",
                 a."fault_string", a."transport_error", a."response_body"
            FROM "electronic_voucher_attempt" a
           WHERE a."voucher_id" = v."id"
           ORDER BY a."started_at" DESC, a."id" DESC
           LIMIT 1
        ) last
       WHERE v."id" IN (${Prisma.join(voucherIds.map((id) => Prisma.sql`${id}::uuid`))})`;
    return new Map(
      rows
        .filter((row) => row.outcome === 'TRANSPORT_FAILURE')
        .map((row) => [
          row.voucher_id,
          {
            at: row.started_at,
            httpStatus: row.http_status,
            faultCode: row.fault_code,
            faultSummary: summaryOf(row.fault_head, row.fault_left_out ?? 0),
            error: row.transport_error,
            hasResponseBody: row.has_response_body,
          },
        ]),
    );
  }

  async lastTransportFailure(
    voucherId: string,
  ): Promise<TransportFailureDetail | null> {
    const last = await this.prisma.electronicVoucherAttempt.findFirst({
      where: { voucherId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        outcome: true,
        startedAt: true,
        httpStatus: true,
        faultCode: true,
        faultString: true,
        faultDetail: true,
        transportError: true,
        responseBody: true,
      },
    });
    if (!last || last.outcome !== 'TRANSPORT_FAILURE') return null;
    return {
      at: last.startedAt,
      httpStatus: last.httpStatus,
      faultCode: last.faultCode,
      faultString: last.faultString,
      faultDetail: last.faultDetail,
      error: last.transportError ?? '',
      responseBody: last.responseBody,
    };
  }

  async statusOfInvoices(
    invoiceIds: readonly string[],
  ): Promise<VoucherStatusView[]> {
    if (invoiceIds.length === 0) return [];
    const rows = await this.prisma.electronicVoucher.findMany({
      where: { invoiceId: { in: [...invoiceIds] } },
      select: STATUS_SELECT,
    });
    return rows.map((row) => toStatusView(row, invoiceIdOf(row)));
  }

  async statusOfCreditNotes(
    creditNoteIds: readonly string[],
  ): Promise<VoucherStatusView[]> {
    if (creditNoteIds.length === 0) return [];
    const rows = await this.prisma.electronicVoucher.findMany({
      where: { creditNoteId: { in: [...creditNoteIds] } },
      select: STATUS_SELECT,
    });
    return rows.map((row) => toStatusView(row, row.creditNoteId!));
  }

  async deliveryContext(id: string): Promise<DeliveryContext | null> {
    const site = {
      select: {
        code: true,
        site: {
          select: {
            sriEstablishmentCode: true,
            establishment: { select: { legalName: true } },
          },
        },
      },
    } as const;
    const row = await this.prisma.electronicVoucher.findUnique({
      where: { id },
      select: {
        invoice: {
          select: {
            id: true,
            issuedById: true,
            accessKey: true,
            buyerEmail: true,
            buyerName: true,
            sequential: true,
            emissionPoint: site,
          },
        },
        // SRI-089. A credit note's voucher is delivered like an invoice's.
        creditNote: {
          select: {
            id: true,
            issuedById: true,
            accessKey: true,
            buyerEmail: true,
            buyerName: true,
            sequential: true,
            emissionPoint: site,
          },
        },
      },
    });
    const document = row?.invoice ?? row?.creditNote;
    if (!row || !document) return null;
    const { emissionPoint } = document;
    const common = {
      issuedById: document.issuedById,
      buyerEmail: document.buyerEmail,
      buyerName: document.buyerName,
      // The document's OWN number: a credit note's comes from its own key.
      documentNumber: invoiceDocumentNumber({
        accessKey: document.accessKey,
        establishmentCode: emissionPoint.site.sriEstablishmentCode,
        emissionPointCode: emissionPoint.code,
        sequential: document.sequential,
      }),
      establishmentName: emissionPoint.site.establishment.legalName,
    };
    return row.invoice
      ? { ...common, document: 'INVOICE', invoiceId: row.invoice.id }
      : { ...common, document: 'CREDIT_NOTE', creditNoteId: document.id };
  }
}
