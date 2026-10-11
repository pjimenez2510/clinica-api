import { Injectable } from '@nestjs/common';
import forge from 'node-forge';

import { SigningCertificateInvalidError } from '../domain/sri.errors';
import type {
  CertificateDescription,
  Pkcs12Inspector,
} from '../domain/signing';

/**
 * SRI-022, SRI-081. Opens a PKCS#12 to say whose it is, who issued it and
 * until when it is valid — with `node-forge`, the same library the signer
 * reads it with, so a file this accepts is a file the signer can open.
 *
 * ⚠️ ONE ERROR FOR EVERY FAILURE. Wrong password, not PKCS#12, no RSA key, no
 * certificate: all `SigningCertificateInvalidError`, because telling them apart
 * is an oracle for whoever is guessing the password of a stolen file.
 */
@Injectable()
export class ForgePkcs12Inspector implements Pkcs12Inspector {
  inspect(pkcs12: Buffer, password: string): CertificateDescription {
    let container: forge.pkcs12.Pkcs12Pfx;
    try {
      const asn1 = forge.asn1.fromDer(pkcs12.toString('binary'));
      container = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
    } catch {
      throw new SigningCertificateInvalidError();
    }

    const shrouded = forge.pki.oids.pkcs8ShroudedKeyBag as string;
    const plainKey = forge.pki.oids.keyBag as string;
    const certBag = forge.pki.oids.certBag as string;

    const keys: forge.pkcs12.Bag[] = [
      ...(container.getBags({ bagType: shrouded })[shrouded] ?? []),
      ...(container.getBags({ bagType: plainKey })[plainKey] ?? []),
    ];
    const key = keys.find((bag) => bag.key !== undefined)?.key;
    if (!key || typeof (key as { n?: unknown }).n !== 'object') {
      throw new SigningCertificateInvalidError();
    }

    // The certificate whose public key matches the private key: entities ship
    // the chain in the same file, and the first bag is not always the signer.
    const certificates = (
      container.getBags({ bagType: certBag })[certBag] ?? []
    )
      .map((bag: forge.pkcs12.Bag) => bag.cert)
      .filter((cert): cert is forge.pki.Certificate => cert !== undefined);
    const own = certificates.find((cert) => {
      const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
      return publicKey.n?.equals(key.n) === true;
    });
    if (!own) throw new SigningCertificateInvalidError();

    return {
      subject: distinguishedName(own.subject.attributes),
      issuer: distinguishedName(own.issuer.attributes),
      serialNumber: own.serialNumber,
      notBefore: own.validity.notBefore,
      notAfter: own.validity.notAfter,
      holderRuc: holderRucOf(own),
    };
  }
}

/**
 * SRI-102. «OID — Objetos Identificadores Únicos de los Certificados»,
 * Security Data v9 (07-07-2020): 3.11 is the RUC of a company member, a legal
 * representative and a natural person with one. Other Ecuadorian CAs were not
 * verified; for them the subject is searched for a 13-digit RUC.
 */
const SECURITY_DATA_RUC_OID = '1.3.6.1.4.1.37746.3.11';

/** A RUC: 13 digits ending in an establishment number, never a cédula. */
const RUC = /(?<!\d)(\d{10}0\d{2})(?!\d)/;

function holderRucOf(certificate: forge.pki.Certificate): string | null {
  const extension = certificate.extensions.find(
    (candidate: { id?: string }) => candidate.id === SECURITY_DATA_RUC_OID,
  ) as { value?: string } | undefined;
  const fromExtension = extension?.value && rucIn(decoded(extension.value));
  if (fromExtension) return fromExtension;

  for (const attribute of certificate.subject.attributes) {
    const found = rucIn(String(attribute.value));
    if (found) return found;
  }
  return null;
}

/** The extension's value is DER; its text is whatever string type it holds. */
function decoded(der: string): string {
  try {
    const node = forge.asn1.fromDer(der);
    return typeof node.value === 'string'
      ? forge.util.decodeUtf8(node.value)
      : '';
  } catch {
    return der;
  }
}

function rucIn(text: string): string | null {
  return RUC.exec(text)?.[1] ?? null;
}

function distinguishedName(
  attributes: readonly forge.pki.CertificateField[],
): string {
  return attributes
    .map(
      (attribute) =>
        `${attribute.shortName ?? attribute.name}=${String(attribute.value)}`,
    )
    .join(', ');
}
