import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { invoiceDocumentNumber } from '../../../shared/billing/document-number';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { SriEnvironment } from '../domain/access-key';
import type {
  AttemptEffect,
  AttemptRecord,
  DeliveryStatus,
  ElectronicVoucherRepository,
  MonitorRow,
  NewVoucher,
  PreparationSource,
  VoucherRecord,
  VoucherStatusView,
} from '../domain/electronic-voucher.repository';
import type {
  BlockedReason,
  SriMessage,
  VoucherStatus,
} from '../domain/voucher-lifecycle';

const VOUCHER_SELECT = {
  id: true,
  invoiceId: true,
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
  deliveryStatus: true,
} satisfies Prisma.ElectronicVoucherSelect;

type VoucherRow = Prisma.ElectronicVoucherGetPayload<{
  select: typeof VOUCHER_SELECT;
}>;

function toRecord(row: VoucherRow): VoucherRecord {
  return {
    ...row,
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
        site: {
          select: {
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
              },
            },
          },
        },
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

    const establishment = row.site.establishment;
    const money = (value: Prisma.Decimal) => value.toFixed(2);
    return {
      invoiceId: row.id,
      siteId: row.siteId,
      invoiceStatus: row.status,
      issuedAt: row.issuedAt,
      sequential: row.sequential,
      emissionPointCode: row.emissionPoint.code,
      establishmentCode: row.site.sriEstablishmentCode,
      issuer: {
        // The same precedence the RIDE prints (DOC-077): the site's own RUC,
        // else the establishment's; the legal name is the establishment's.
        ruc: row.site.ruc ?? establishment?.ruc ?? null,
        legalName: establishment?.legalName ?? null,
        headOfficeAddress: establishment?.headOfficeAddress ?? null,
        establishmentAddress: row.site.addressLine,
        keepsAccounting: establishment?.keepsAccounting ?? false,
        specialTaxpayerResolution:
          establishment?.specialTaxpayerResolution ?? null,
        withholdingAgentResolution:
          establishment?.withholdingAgentResolution ?? null,
        rimpeRegime: establishment?.rimpeRegime ?? 'NONE',
      },
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
        unitPrice: money(charge.unitAmount),
        discount: money(charge.discountAmount),
        taxSriCode: charge.taxSriCode,
        // «No objeto» and «exento» carry no rate: the SRI's `tarifa` is 0.
        taxPercentage: charge.taxPercentage?.toFixed(2) ?? '0.00',
      })),
      totals: {
        subtotalTaxed: money(row.subtotalTaxed),
        subtotalUntaxed: money(row.subtotalUntaxed),
        discountTotal: money(row.discountTotal),
        taxTotal: money(row.taxTotal),
        total: money(row.total),
      },
      paymentMethod: row.paymentMethod,
    };
  }

  async create(voucher: NewVoucher): Promise<VoucherRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.electronicVoucher.create({
          data: {
            invoiceId: voucher.invoiceId,
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
        // SRI-007. The key on the invoice, in the same breath, so the RIDE
        // handed over now already carries it (SRI-071).
        await tx.invoice.update({
          where: { id: voucher.invoiceId },
          data: { accessKey: voucher.accessKey },
        });
        return toRecord(created);
      });
    } catch (error) {
      // SRI-006. Another process prepared this invoice a moment earlier: its
      // voucher is THE voucher, and its key is the one that stands.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByInvoice(voucher.invoiceId);
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
    await this.prisma.electronicVoucher.updateMany({
      where: { id, status: 'PREPARED' },
      data: { blockedReason: reason },
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
        },
      });
      if (voucher.count === 0) return false;
      const row = await tx.electronicVoucher.findUniqueOrThrow({
        where: { id },
        select: { invoiceId: true },
      });
      // SRI-058. Back to ISSUED: it is not rejected while it is being re-sent.
      await tx.invoice.updateMany({
        where: { id: row.invoiceId, status: 'REJECTED' },
        data: { status: 'ISSUED' },
      });
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
        { status: string; access_key: string; invoice_id: string }[]
      >`
        SELECT "status", "access_key", "invoice_id"
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
          transportError: attempt.transportError?.slice(0, 500) ?? null,
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

      if (effect.invoiceStatus !== null) {
        await tx.invoice.update({
          where: { id: locked.invoice_id },
          data: {
            status: effect.invoiceStatus,
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

  async pendingWork(limit: number) {
    const [withoutVoucher, unsigned, inFlight, undelivered] = await Promise.all(
      [
        this.prisma.invoice.findMany({
          where: { status: 'ISSUED', electronicVoucher: null },
          orderBy: { issuedAt: 'asc' },
          take: limit,
          select: { id: true },
        }),
        this.prisma.electronicVoucher.findMany({
          where: { status: 'PREPARED' },
          orderBy: { createdAt: 'asc' },
          take: limit,
          select: VOUCHER_SELECT,
        }),
        this.prisma.electronicVoucher.findMany({
          where: { status: { in: IN_FLIGHT } },
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
      ],
    );
    return {
      invoicesWithoutVoucher: withoutVoucher.map((row) => row.id),
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
    const rows = await this.prisma.invoice.findMany({
      where: {
        ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }),
        status: { in: ['ISSUED', 'REJECTED'] },
        OR: [
          { electronicVoucher: null },
          { electronicVoucher: { status: { not: 'AUTHORISED' } } },
        ],
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
        emissionPoint: {
          select: {
            code: true,
            site: { select: { sriEstablishmentCode: true } },
          },
        },
        electronicVoucher: {
          select: {
            id: true,
            status: true,
            blockedReason: true,
            accessKey: true,
            lastMessages: true,
            attemptCount: true,
            nextAttemptAt: true,
          },
        },
      },
    });

    return rows.map((row) => {
      const voucher = row.electronicVoucher;
      return {
        invoiceId: row.id,
        voucherId: voucher?.id ?? null,
        siteId: row.siteId,
        documentNumber: invoiceDocumentNumber({
          accessKey: voucher?.accessKey ?? null,
          establishmentCode: row.emissionPoint.site.sriEstablishmentCode,
          emissionPointCode: row.emissionPoint.code,
          sequential: row.sequential,
        }),
        buyerName: row.buyerName,
        buyerIdentification: row.buyerIdentification,
        issuedAt: row.issuedAt ?? new Date(0),
        total: row.total.toFixed(2),
        status: (voucher?.status ?? 'NO_VOUCHER') as MonitorRow['status'],
        blockedReason: (voucher?.blockedReason ?? null) as BlockedReason | null,
        accessKey: voucher?.accessKey ?? null,
        lastMessages: voucher ? messagesOf(voucher.lastMessages) : [],
        attemptCount: voucher?.attemptCount ?? 0,
        nextAttemptAt: voucher?.nextAttemptAt ?? null,
      };
    });
  }

  async statusOfInvoices(
    invoiceIds: readonly string[],
  ): Promise<VoucherStatusView[]> {
    if (invoiceIds.length === 0) return [];
    const rows = await this.prisma.electronicVoucher.findMany({
      where: { invoiceId: { in: [...invoiceIds] } },
      select: {
        id: true,
        invoiceId: true,
        status: true,
        blockedReason: true,
        accessKey: true,
        authorisedAt: true,
        deliveryStatus: true,
        lastMessages: true,
      },
    });
    return rows.map((row) => ({
      invoiceId: row.invoiceId,
      voucherId: row.id,
      status: row.status as VoucherStatus,
      blockedReason: row.blockedReason as BlockedReason | null,
      accessKey: row.accessKey,
      authorisedAt: row.authorisedAt,
      deliveryStatus: row.deliveryStatus as DeliveryStatus | null,
      lastMessages: messagesOf(row.lastMessages),
    }));
  }

  async deliveryContext(id: string) {
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
            emissionPoint: {
              select: {
                code: true,
                site: {
                  select: {
                    name: true,
                    sriEstablishmentCode: true,
                    establishment: { select: { legalName: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!row) return null;
    const { invoice } = row;
    const site = invoice.emissionPoint.site;
    return {
      invoiceId: invoice.id,
      issuedById: invoice.issuedById,
      buyerEmail: invoice.buyerEmail,
      buyerName: invoice.buyerName,
      documentNumber: invoiceDocumentNumber({
        accessKey: invoice.accessKey,
        establishmentCode: site.sriEstablishmentCode,
        emissionPointCode: invoice.emissionPoint.code,
        sequential: invoice.sequential,
      }),
      establishmentName: site.establishment?.legalName ?? site.name,
    };
  }
}
