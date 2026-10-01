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
    const key = keys.find((bag) => bag.key !== undefined)?.key as
      forge.pki.rsa.PrivateKey | undefined;
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
    };
  }
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
