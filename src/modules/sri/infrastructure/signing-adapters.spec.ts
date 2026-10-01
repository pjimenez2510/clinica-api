import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DOMParser } from '@xmldom/xmldom';
import type { ConfigService } from '@nestjs/config';
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';

import { createTestPkcs12 } from '../../../../test/support/test-pkcs12';
import type { Env } from '../../../shared/config/env.schema';
import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { composeAccessKey } from '../domain/access-key';
import { composeInvoiceXml } from '../domain/invoice-xml';
import {
  SigningCertificateInvalidError,
  SigningCertificateStoreNotConfiguredError,
} from '../domain/sri.errors';

import { AesGcmCertificateCipher } from './aes-gcm-certificate.cipher';
import { EcSriXadesSigner } from './ec-sri-xades.signer';
import { ForgePkcs12Inspector } from './forge-pkcs12.inspector';

/** The clock of these tests: the instant they run, never a written date. */
const NOW = new Date();

const ISSUED_ON = parseClinicalDate('2026-09-30'); // fecha-fija: dato de entrada de una función pura, sin reloj

function anInvoiceXml(): string {
  return composeInvoiceXml({
    environment: '1',
    accessKey: composeAccessKey({
      issuedOn: ISSUED_ON,
      documentType: '01',
      ruc: '1790001563001',
      environment: '1',
      establishmentCode: '001',
      emissionPointCode: '001',
      sequential: '000000001',
      numericCode: '00000001',
    }),
    issuer: {
      ruc: '1790001563001',
      legalName: 'Clínica de Desarrollo S.A.',
      headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
      establishmentAddress: null,
      keepsAccounting: false,
      specialTaxpayerResolution: null,
      withholdingAgentResolution: null,
      rimpeRegime: 'NONE',
    },
    establishmentCode: '001',
    emissionPointCode: '001',
    sequential: '000000001',
    issuedOn: ISSUED_ON,
    buyer: {
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
      email: null,
    },
    lines: [
      {
        code: 'CONS-MG-PV',
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
    softwareProviderRuc: null,
  });
}

/**
 * Verifies a XAdES signature for real, with `xml-crypto` and the certificate's
 * public key — a test that only looked for `<ds:Signature>` would pass with a
 * signature over the wrong bytes.
 */
function verify(
  signedXml: string,
  certificatePem: string,
): {
  valid: boolean;
  signatureAlgorithm: string | null;
  digestAlgorithms: string[];
  references: string[];
} {
  const document = new DOMParser().parseFromString(signedXml, 'text/xml');
  const signature = document.getElementsByTagNameNS(
    'http://www.w3.org/2000/09/xmldsig#',
    'Signature',
  )[0];
  if (!signature) throw new Error('no signature');
  const verifier = new SignedXml({ publicCert: certificatePem });
  // @xmldom's Element and the DOM lib's Node are the same thing to xml-crypto.
  verifier.loadSignature(signature as unknown as Node);
  const valid = verifier.checkSignature(signedXml);

  const method = signature.getElementsByTagNameNS(
    'http://www.w3.org/2000/09/xmldsig#',
    'SignatureMethod',
  )[0];
  const digests = Array.from(
    signature.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'DigestMethod',
    ),
  ).map((node) => node.getAttribute('Algorithm') ?? '');
  const references = Array.from(
    signature.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'Reference',
    ),
  ).map((node) => node.getAttribute('URI') ?? '');
  return {
    valid,
    signatureAlgorithm: method?.getAttribute('Algorithm') ?? null,
    digestAlgorithms: digests,
    references,
  };
}

describe('SRI-020, SRI-021 la firma XAdES-BES', () => {
  const certificate = createTestPkcs12({ now: NOW });
  const signer = new EcSriXadesSigner();

  it('SRI-020 SRI-021 firma con RSA-SHA1 y SHA-1, y la firma se verifica criptográficamente', () => {
    const signed = signer.sign(
      anInvoiceXml(),
      certificate.pkcs12,
      certificate.password,
    );
    const result = verify(signed, certificate.certificatePem);

    expect(result.valid).toBe(true);
    expect(result.signatureAlgorithm).toBe(
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    );
    expect(new Set(result.digestAlgorithms)).toEqual(
      new Set(['http://www.w3.org/2000/09/xmldsig#sha1']),
    );
    expect(result.references).toContain('#comprobante');
    expect(signed).toContain('xades:SignedProperties');
  });

  it('SRI-020 control: una factura alterada después de firmar ya no verifica', () => {
    const signed = signer.sign(
      anInvoiceXml(),
      certificate.pkcs12,
      certificate.password,
    );
    const tampered = signed.replace(
      '<importeTotal>30.00</importeTotal>',
      '<importeTotal>3.00</importeTotal>',
    );
    expect(tampered).not.toBe(signed);
    expect(verify(tampered, certificate.certificatePem).valid).toBe(false);
  });

  it('SRI-015 se niega a firmar una raíz sin id="comprobante"', () => {
    const withoutId = anInvoiceXml().replace(' id="comprobante"', '');
    expect(() =>
      signer.sign(withoutId, certificate.pkcs12, certificate.password),
    ).toThrow(/id="comprobante"/);
  });

  it('SRI-030 una clave que no abre el .p12 es SigningCertificateInvalidError, sin el detalle de la librería', () => {
    expect(() =>
      signer.sign(anInvoiceXml(), certificate.pkcs12, 'otra-clave'),
    ).toThrow(SigningCertificateInvalidError);
  });
});

describe('SRI-022, SRI-081 la inspección del .p12', () => {
  const inspector = new ForgePkcs12Inspector();

  it('SRI-022 describe titular, emisor, serie y vigencia', () => {
    const certificate = createTestPkcs12({
      now: NOW,
      commonName: 'MARIA JOSE GUAMAN',
    });
    const description = inspector.inspect(
      certificate.pkcs12,
      certificate.password,
    );
    expect(description.subject).toContain('CN=MARIA JOSE GUAMAN');
    expect(description.issuer).toContain('O=ENTIDAD DE PRUEBA');
    expect(description.serialNumber).toBe(certificate.serialNumber);
    expect(description.notBefore.getTime()).toBe(
      Math.floor(certificate.notBefore.getTime() / 1000) * 1000,
    );
    expect(description.notAfter.getTime()).toBe(
      Math.floor(certificate.notAfter.getTime() / 1000) * 1000,
    );
  });

  it('SRI-081 una clave equivocada y un fichero que no es PKCS#12 dan el mismo error', () => {
    const certificate = createTestPkcs12({ now: NOW });
    const wrongPassword = (() => {
      try {
        inspector.inspect(certificate.pkcs12, 'no-es-la-clave');
        return null;
      } catch (error) {
        return error;
      }
    })();
    const notPkcs12 = (() => {
      try {
        inspector.inspect(Buffer.from('esto no es un p12'), 'x');
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(wrongPassword).toBeInstanceOf(SigningCertificateInvalidError);
    expect(notPkcs12).toBeInstanceOf(SigningCertificateInvalidError);
    expect((wrongPassword as Error).message).toBe((notPkcs12 as Error).message);
  });
});

describe('SRI-023, SRI-024, SRI-025 el cifrado del certificado', () => {
  function cipherWith(passphrase: string | null): AesGcmCertificateCipher {
    let path: string | undefined;
    if (passphrase !== null) {
      const directory = mkdtempSync(join(tmpdir(), 'sri-master-'));
      path = join(directory, 'master');
      writeFileSync(path, passphrase);
    }
    const config = {
      get: (key: keyof Env) =>
        key === 'SRI_CERTIFICATE_MASTER_KEY_FILE' ? path : undefined,
    } as unknown as ConfigService<Env, true>;
    return new AesGcmCertificateCipher(config);
  }

  it('SRI-023 lo sellado no contiene el original y se abre con la misma frase y sal', async () => {
    const cipher = cipherWith('frase-maestra-de-prueba-larga');
    const plain = createTestPkcs12({ now: NOW }).pkcs12;
    const salt = cipher.newSalt();

    const sealed = await cipher.seal(plain, salt);
    expect(sealed.includes(plain.subarray(0, 32))).toBe(false);
    expect(sealed.length).toBeGreaterThan(28);
    await expect(cipher.open(sealed, salt)).resolves.toEqual(plain);
  });

  it('SRI-023 GCM autentica: un byte alterado o otra frase no abren', async () => {
    const cipher = cipherWith('frase-maestra-de-prueba-larga');
    const salt = cipher.newSalt();
    const sealed = await cipher.seal(Buffer.from('secreto'), salt);

    const tampered = Buffer.from(sealed);
    const last = tampered.length - 1;
    tampered.writeUInt8(tampered.readUInt8(last) ^ 0xff, last);
    await expect(cipher.open(tampered, salt)).rejects.toThrow();
    await expect(
      cipherWith('otra-frase-maestra-distinta').open(sealed, salt),
    ).rejects.toThrow();
  });

  it('SRI-024 sin fichero de frase maestra, o con una frase corta, la custodia no está configurada', async () => {
    await expect(
      cipherWith(null).seal(Buffer.from('x'), Buffer.alloc(16)),
    ).rejects.toBeInstanceOf(SigningCertificateStoreNotConfiguredError);
    await expect(
      cipherWith('corta').seal(Buffer.from('x'), Buffer.alloc(16)),
    ).rejects.toBeInstanceOf(SigningCertificateStoreNotConfiguredError);
  });
});
