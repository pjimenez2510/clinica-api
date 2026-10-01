import { Injectable } from '@nestjs/common';
import {
  signInvoiceXml,
  UnsupportedDocumentTypeError,
  UnsupportedXmlFeatureError,
  XmlFormatError,
} from 'ec-sri-invoice-signer';

import { hasVoucherRootId } from '../domain/invoice-xml';
import { SigningCertificateInvalidError } from '../domain/sri.errors';
import type { XadesSigner } from '../domain/signing';

/**
 * SRI-020, SRI-021. XAdES-BES through `ec-sri-invoice-signer` 1.8.2 (ADR-004).
 *
 * THE LIBRARY, NOT A REIMPLEMENTATION. XAdES-BES is ~500 lines of
 * cryptography where a canonicalisation slip produces intermittent rejections
 * that cannot be debugged against a production web service. Its source was
 * read before adopting it: digest `xmldsig#sha1`, signature `xmldsig#rsa-sha1`,
 * C14N through `xml-crypto`, the signature appended as the last child of the
 * root — exactly what the SRI demands and nothing to configure.
 *
 * ⚠️ IT DOES NOT CHECK `id="comprobante"` (ADR-004 §2). It hard-codes the
 * reference to `#comprobante` and signs happily without the attribute; the SRI
 * then answers 39 without saying why. So this adapter checks first (SRI-015).
 *
 * If the library dies, this file is rewritten over `xml-crypto` and
 * `node-forge` and nothing above the `XadesSigner` port changes.
 */
@Injectable()
export class EcSriXadesSigner implements XadesSigner {
  sign(xml: string, pkcs12: Buffer, password: string): string {
    if (!hasVoucherRootId(xml)) {
      throw new Error(
        'Root element must carry id="comprobante" before signing',
      );
    }
    try {
      return signInvoiceXml(xml, pkcs12, { pkcs12Password: password });
    } catch (error) {
      // An XML the library refuses is OUR defect and keeps its own error.
      if (
        error instanceof XmlFormatError ||
        error instanceof UnsupportedXmlFeatureError ||
        error instanceof UnsupportedDocumentTypeError
      ) {
        throw error;
      }
      // Everything else comes from opening the .p12 — the library's own
      // `UnsuportedPkcs12Error`, or forge's «MAC could not be verified» for a
      // wrong password. SRI-030: the message is NOT forwarded, it may describe
      // the container, and nothing about the certificate belongs in a log.
      throw new SigningCertificateInvalidError();
    }
  }
}
