import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type {
  ElectronicVoucherStatusReader,
  ElectronicVoucherSummary,
} from '../../../shared/billing/electronic-voucher.port';
import {
  ELECTRONIC_VOUCHER_REPOSITORY,
  type ElectronicVoucherRepository,
  type MonitorRow,
  type TransportFailureDetail,
} from '../domain/electronic-voucher.repository';
import {
  ElectronicVoucherNotFoundError,
  ElectronicVoucherNotRetriableError,
} from '../domain/sri.errors';
import {
  SRI_CLOCK,
  SRI_SETTINGS,
  SRI_WEB_SERVICE,
  type SriClock,
  type SriSettings,
  type SriWebService,
} from '../domain/sri-web-service';
import {
  isRetriableByAPerson,
  needsAPerson,
} from '../domain/voucher-lifecycle';

import {
  missingIssuerData,
  VoucherPreparationService,
} from './voucher-preparation.service';
import {
  SigningCertificateService,
  type CertificateHealth,
} from './signing-certificate.service';

const VOUCHER_RESOURCE_TYPE = 'electronic_voucher';

export interface Requester {
  userId: string;
  sites: readonly string[] | 'all';
  ip?: string;
  userAgent?: string;
}

/** SRI-061 to SRI-063. The monitor, with what it says about the installation. */
export interface MonitorView {
  rows: (MonitorRow & {
    needsAPerson: boolean;
    missingData: string[];
    /** SRI-055, D-102. Its key is of the environment not configured. */
    environmentMismatch: boolean;
  })[];
  certificate: CertificateHealth;
  /** SRI-054. The web service is not declared: vouchers wait signed. */
  webServiceConfigured: boolean;
}

/**
 * SRI-058, SRI-060 to SRI-068. What caja sees of the SRI, and the one action
 * it has: re-sending what the SRI returned.
 */
@Injectable()
export class VoucherMonitorService implements ElectronicVoucherStatusReader {
  constructor(
    @Inject(ELECTRONIC_VOUCHER_REPOSITORY)
    private readonly vouchers: ElectronicVoucherRepository,
    @Inject(SRI_WEB_SERVICE) private readonly sri: SriWebService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    private readonly preparation: VoucherPreparationService,
    private readonly certificates: SigningCertificateService,
    @Inject(SRI_CLOCK) private readonly clock: SriClock,
    @Inject(SRI_SETTINGS) private readonly settings: SriSettings,
  ) {}

  /** SRI-061, SRI-062. People first, the queue's own work after. */
  async monitor(sites: Requester['sites']): Promise<MonitorView> {
    const now = this.clock();
    const rows = await Promise.all(
      (await this.vouchers.monitor(sites)).map(async (row) => {
        // The 24th digit of the key is its environment (SRI-070).
        const environmentMismatch =
          row.accessKey !== null &&
          row.accessKey.charAt(23) !== this.settings.environment;
        return {
          ...row,
          environmentMismatch,
          needsAPerson:
            environmentMismatch ||
            needsAPerson(row.status, row.receivedAt ?? row.issuedAt, now),
          // SRI-008. An invoice without a voucher says which datum it lacks.
          missingData:
            row.status === 'NO_VOUCHER'
              ? await this.missingDataOf(row.invoiceId)
              : [],
        };
      }),
    );
    rows.sort((a, b) =>
      a.needsAPerson === b.needsAPerson
        ? b.issuedAt.getTime() - a.issuedAt.getTime()
        : a.needsAPerson
          ? -1
          : 1,
    );
    return {
      rows,
      certificate: await this.certificates.health(),
      webServiceConfigured: this.sri.isConfigured(),
    };
  }

  private async missingDataOf(invoiceId: string): Promise<string[]> {
    const source = await this.vouchers.preparationSource(invoiceId);
    return source ? missingIssuerData(source) : [];
  }

  /** SRI-058, SRI-065, SRI-066. */
  async retry(voucherId: string, requester: Requester): Promise<void> {
    const voucher = await this.vouchers.findByIdInSites(
      voucherId,
      requester.sites,
    );
    if (!voucher) throw new ElectronicVoucherNotFoundError();
    if (!isRetriableByAPerson(voucher.status)) {
      throw new ElectronicVoucherNotRetriableError();
    }

    const unsignedXml = await this.preparation.recompose(voucher);
    if (unsignedXml === null) throw new ElectronicVoucherNotFoundError();
    const reopened = await this.vouchers.reopen(voucher.id, unsignedXml);
    // Somebody retried it a moment earlier: theirs carries on.
    if (!reopened) throw new ElectronicVoucherNotRetriableError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: VOUCHER_RESOURCE_TYPE,
      resourceId: voucher.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    await this.preparation.sign({
      ...voucher,
      status: 'PREPARED',
      blockedReason: null,
      unsignedXml,
      signedXml: null,
    });
  }

  /**
   * SRI-069, SRI-065. What the SRI answered the last time it failed, body
   * included; out of the requester's sites it does not exist.
   */
  async lastTransportFailure(
    voucherId: string,
    sites: Requester['sites'],
  ): Promise<TransportFailureDetail | null> {
    const voucher = await this.vouchers.findByIdInSites(voucherId, sites);
    if (!voucher) throw new ElectronicVoucherNotFoundError();
    return this.vouchers.lastTransportFailure(voucher.id);
  }

  /** SRI-068. The signed XML, or the authorisation document once there is one. */
  async xml(
    voucherId: string,
    kind: 'signed' | 'authorised',
    sites: Requester['sites'],
  ): Promise<{ content: string; fileName: string }> {
    const voucher = await this.vouchers.findByIdInSites(voucherId, sites);
    const content =
      kind === 'signed' ? voucher?.signedXml : voucher?.authorisedXml;
    if (!voucher || !content) throw new ElectronicVoucherNotFoundError();
    return {
      content,
      fileName: `${voucher.accessKey}${kind === 'signed' ? '-firmado' : ''}.xml`,
    };
  }

  /** SRI-060. The port `billing` reads beside each invoice. */
  async summariesOf(
    invoiceIds: readonly string[],
  ): Promise<Map<string, ElectronicVoucherSummary>> {
    const views = await this.vouchers.statusOfInvoices(invoiceIds);
    return new Map(
      views.map((view) => {
        const last = view.lastMessages.at(-1) ?? null;
        return [
          view.invoiceId,
          {
            voucherId: view.voucherId,
            state: view.status,
            blockedReason: view.blockedReason,
            accessKey: view.accessKey,
            authorisedAt: view.authorisedAt,
            deliveryStatus: view.deliveryStatus,
            lastMessage: last
              ? { identifier: last.identifier, message: last.message }
              : null,
          },
        ];
      }),
    );
  }
}
