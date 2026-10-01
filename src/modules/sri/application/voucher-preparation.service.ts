import { randomInt } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { ElectronicVoucherPreparer } from '../../../shared/billing/electronic-voucher.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  accessKeyParts,
  composeAccessKey,
  numericCodeFrom,
} from '../domain/access-key';
import {
  ELECTRONIC_VOUCHER_REPOSITORY,
  SIGNING_CERTIFICATE_REPOSITORY,
  VOUCHER_QUEUE,
  type ElectronicVoucherRepository,
  type PreparationSource,
  type SigningCertificateRepository,
  type VoucherQueue,
  type VoucherRecord,
} from '../domain/electronic-voucher.repository';
import {
  composeInvoiceXml,
  INVOICE_SCHEMA_VERSION,
  type InvoiceVoucherSource,
} from '../domain/invoice-xml';
import {
  CERTIFICATE_CIPHER,
  isWithinValidity,
  XADES_SIGNER,
  type CertificateCipher,
  type XadesSigner,
} from '../domain/signing';
import {
  SigningCertificateInvalidError,
  SigningCertificateStoreNotConfiguredError,
} from '../domain/sri.errors';
import {
  SRI_CLOCK,
  SRI_SETTINGS,
  SRI_WEB_SERVICE,
  type SriClock,
  type SriSettings,
  type SriWebService,
} from '../domain/sri-web-service';
import type { BlockedReason } from '../domain/voucher-lifecycle';

/** SRI-008. The issuer data a voucher cannot exist without. */
export type MissingIssuerDatum =
  | 'ISSUER_RUC'
  | 'ISSUER_LEGAL_NAME'
  | 'SRI_ESTABLISHMENT_CODE'
  | 'HEAD_OFFICE_ADDRESS'
  | 'FISCAL_PROFILE';

/** SRI-008. Which of them this invoice's installation still lacks. */
export function missingIssuerData(
  source: Pick<PreparationSource, 'issuer' | 'establishmentCode'>,
): MissingIssuerDatum[] {
  const missing: MissingIssuerDatum[] = [];
  if (!source.issuer.ruc || !/^[0-9]{13}$/.test(source.issuer.ruc)) {
    missing.push('ISSUER_RUC');
  }
  if (!source.issuer.legalName?.trim()) missing.push('ISSUER_LEGAL_NAME');
  if (!source.establishmentCode) missing.push('SRI_ESTABLISHMENT_CODE');
  if (!source.issuer.headOfficeAddress?.trim()) {
    missing.push('HEAD_OFFICE_ADDRESS');
  }
  // OR-031. `obligadoContabilidad` and RIMPE have defaults; declaring them
  // because nobody looked is a fiscal statement the system does not make.
  if (!source.issuer.fiscalProfileDeclared) missing.push('FISCAL_PROFILE');
  return missing;
}

/**
 * SRI-001 to SRI-031, SRI-041. From an issued invoice to a signed voucher,
 * without a single network call.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS FIXED ONCE AND WHAT IS RECOMPOSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The KEY —and the numeric code and the environment inside it— is fixed the
 * first time and never again (SRI-005): `create` returns the existing voucher
 * if another process got there first, and the database refuses a change.
 *
 * The unsigned XML of a PREPARED voucher IS recomposed before signing, from
 * the same frozen invoice and with the same key: a voucher that waited for a
 * certificate, a payment method or a head-office address must be signed with
 * what the installation says NOW. Once SIGNED, the bytes never change (SRI-031).
 */
@Injectable()
export class VoucherPreparationService implements ElectronicVoucherPreparer {
  constructor(
    @Inject(ELECTRONIC_VOUCHER_REPOSITORY)
    private readonly vouchers: ElectronicVoucherRepository,
    @Inject(SIGNING_CERTIFICATE_REPOSITORY)
    private readonly certificates: SigningCertificateRepository,
    @Inject(CERTIFICATE_CIPHER) private readonly cipher: CertificateCipher,
    @Inject(XADES_SIGNER) private readonly signer: XadesSigner,
    @Inject(VOUCHER_QUEUE) private readonly queue: VoucherQueue,
    @Inject(SRI_WEB_SERVICE) private readonly sri: SriWebService,
    @Inject(SRI_SETTINGS) private readonly settings: SriSettings,
    @Inject(SRI_CLOCK) private readonly clock: SriClock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VoucherPreparationService.name);
  }

  /**
   * SRI-041. The port `billing` calls after its transaction commits. NEVER
   * throws: an invoice that exists must not become an error on the cashier's
   * screen because of its voucher. The sweep retries what fails here.
   */
  async prepare(invoiceId: string): Promise<void> {
    try {
      await this.prepareInvoice(invoiceId);
    } catch (error) {
      this.logger.error(
        {
          err: error,
          invoice_id: invoiceId,
          error_code: 'SRI_PREPARATION_FAILED',
        },
        'the electronic voucher could not be prepared; the sweep will retry',
      );
    }
  }

  /**
   * SRI-001, SRI-008. Creates the voucher if the invoice has none, then signs
   * it if it can. Returns `null` when the invoice cannot have one yet.
   */
  async prepareInvoice(invoiceId: string): Promise<VoucherRecord | null> {
    const existing = await this.vouchers.findByInvoice(invoiceId);
    if (existing) {
      if (existing.status === 'PREPARED') return this.sign(existing);
      return existing;
    }

    const source = await this.vouchers.preparationSource(invoiceId);
    if (!source || source.invoiceStatus !== 'ISSUED') return null;
    if (missingIssuerData(source).length > 0) return null;

    const issuedOn = clinicalDateOf(source.issuedAt);
    const numericCode = numericCodeFrom((max) => randomInt(max));
    const accessKey = composeAccessKey({
      issuedOn,
      documentType: '01',
      ruc: source.issuer.ruc!,
      environment: this.settings.environment,
      establishmentCode: source.establishmentCode!,
      emissionPointCode: source.emissionPointCode,
      sequential: source.sequential,
      numericCode,
    });

    const voucher = await this.vouchers.create({
      invoiceId: source.invoiceId,
      siteId: source.siteId,
      accessKey,
      numericCode,
      environment: this.settings.environment,
      schemaVersion: INVOICE_SCHEMA_VERSION,
      unsignedXml: composeInvoiceXml(this.voucherSource(source, accessKey)),
      blockedReason: null,
    });

    return this.sign(voucher);
  }

  /**
   * SRI-020 to SRI-031. Signs a PREPARED voucher, or leaves it PREPARED with
   * the reason it cannot be signed yet. Then queues it for sending.
   */
  async sign(voucher: VoucherRecord): Promise<VoucherRecord> {
    if (voucher.status !== 'PREPARED') return voucher;

    const source = await this.vouchers.preparationSource(voucher.invoiceId);
    if (!source) return voucher;

    // SRI-008. A datum of the issuer removed after the voucher was created:
    // it waits, said, rather than failing the sweep on every pass.
    if (missingIssuerData(source).length > 0) {
      return this.blocked(voucher, 'MISSING_ISSUER_DATA');
    }

    // SRI-017, BI-170. The cashier declares it; an older invoice without it
    // is not signed, and nothing here invents one.
    if (source.paymentMethod === null) {
      return this.blocked(voucher, 'NO_PAYMENT_METHOD');
    }

    const certificate = await this.certificates.active();
    if (!certificate) return this.blocked(voucher, 'NO_CERTIFICATE');
    if (!isWithinValidity(certificate, this.clock())) {
      return this.blocked(voucher, 'CERTIFICATE_NOT_VALID');
    }

    const unsignedXml = composeInvoiceXml(
      this.voucherSource(source, voucher.accessKey),
    );

    // SRI-024. Without the passphrase nothing opens: said, and with no
    // opening recorded for a decryption that never happened.
    if (!(await this.cipher.ready())) {
      return this.blocked(voucher, 'CERTIFICATE_STORE_NOT_CONFIGURED');
    }

    // SRI-026. The opening is recorded BEFORE decrypting; if the row cannot be
    // written this throws, and nothing is decrypted or signed.
    await this.certificates.recordOpening(certificate.id, voucher.id);

    let pkcs12: Buffer | null = null;
    let signedXml: string;
    try {
      const [container, passwordBytes] = await this.cipher.open(
        [certificate.encryptedPkcs12, certificate.encryptedPassword],
        certificate.kdfSalt,
      );
      pkcs12 = container!;
      try {
        signedXml = this.signer.sign(
          unsignedXml,
          pkcs12,
          passwordBytes!.toString('utf8'),
        );
      } finally {
        passwordBytes!.fill(0);
      }
    } catch (error) {
      if (error instanceof SigningCertificateStoreNotConfiguredError) {
        return this.blocked(voucher, 'CERTIFICATE_STORE_NOT_CONFIGURED');
      }
      if (error instanceof SigningCertificateInvalidError) {
        return this.blocked(voucher, 'CERTIFICATE_UNREADABLE');
      }
      // SRI-030. Logged by code only: nothing of the certificate or its
      // password travels in the entry.
      this.logger.error(
        { voucher_id: voucher.id, error_code: 'SRI_SIGNING_FAILED' },
        'the voucher could not be signed',
      );
      return this.blocked(voucher, 'SIGNING_FAILED');
    } finally {
      // SRI-025. The decrypted container does not outlive the signature.
      pkcs12?.fill(0);
    }

    const signedAt = this.clock();
    await this.vouchers.markSigned(voucher.id, {
      unsignedXml,
      signedXml,
      certificateId: certificate.id,
      signedAt,
    });

    // SRI-054. Without the web service declared, it waits signed.
    if (this.sri.isConfigured()) {
      await this.queue.schedule('SEND', voucher, 0);
    }

    return {
      ...voucher,
      status: 'SIGNED',
      blockedReason: null,
      unsignedXml,
      signedXml,
    };
  }

  /** SRI-058. The XML of a voucher, recomposed with its own key. */
  async recompose(voucher: VoucherRecord): Promise<string | null> {
    const source = await this.vouchers.preparationSource(voucher.invoiceId);
    if (!source || missingIssuerData(source).length > 0) return null;
    return composeInvoiceXml(this.voucherSource(source, voucher.accessKey));
  }

  private async blocked(
    voucher: VoucherRecord,
    reason: BlockedReason,
  ): Promise<VoucherRecord> {
    if (voucher.blockedReason !== reason) {
      await this.vouchers.block(voucher.id, reason);
    }
    return { ...voucher, blockedReason: reason };
  }

  /**
   * SRI-019. What the voucher says about itself —date, RUC, environment,
   * series, sequential— comes from its key, which never changes, and not from
   * the site as it is today: a code corrected after issuing would otherwise
   * produce a voucher the SRI returns and that can never be fixed.
   */
  private voucherSource(
    source: PreparationSource,
    accessKey: string,
  ): InvoiceVoucherSource {
    const key = accessKeyParts(accessKey);
    return {
      environment: key.environment,
      accessKey,
      issuer: {
        ruc: key.ruc,
        legalName: source.issuer.legalName!,
        headOfficeAddress: source.issuer.headOfficeAddress!,
        establishmentAddress: source.issuer.establishmentAddress,
        keepsAccounting: source.issuer.keepsAccounting,
        specialTaxpayerResolution: source.issuer.specialTaxpayerResolution,
        withholdingAgentResolution: source.issuer.withholdingAgentResolution,
        rimpeRegime: source.issuer.rimpeRegime,
      },
      establishmentCode: key.establishmentCode,
      emissionPointCode: key.emissionPointCode,
      sequential: key.sequential,
      issuedOn: key.issuedOn,
      buyer: source.buyer,
      lines: source.lines,
      totals: source.totals,
      paymentMethod: source.paymentMethod,
      softwareProviderRuc: this.settings.softwareProviderRuc,
    };
  }
}
