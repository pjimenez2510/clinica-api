import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type ScryptOptions,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../../shared/config/env.schema';
import { SigningCertificateStoreNotConfiguredError } from '../domain/sri.errors';
import type { CertificateCipher } from '../domain/signing';

/**
 * SRI-023 to SRI-025, ADR-004 «Custodia». AES-256-GCM under a key derived by
 * scrypt from a master passphrase that lives in a FILE outside the database.
 *
 * WHY NOT VAULT, WHY NOT AN ENV VAR. ADR-004 weighed both: Vault still needs a
 * root secret of its own and only moves the problem; an environment variable
 * leaks through `docker inspect`, crash dumps and error reports. A Docker
 * secret is a file, so the setting is the file's PATH (SRI-024).
 *
 * THE PASSPHRASE IS READ AT THE POINT OF USE, never cached: rotating the
 * secret file takes effect without a restart, and nothing holds it in memory
 * between two signatures (SRI-025).
 *
 * Envelope: `iv (12) ‖ tag (16) ‖ ciphertext`. GCM authenticates, so a
 * tampered row fails to open instead of decrypting into garbage — which is the
 * difference with the CBC-without-MAC the reference implementation used.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** OWASP's floor for scrypt (N=2^17 is the stronger profile; 2^15 is the minimum). */
const SCRYPT: ScryptOptions = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

@Injectable()
export class AesGcmCertificateCipher implements CertificateCipher {
  constructor(private readonly config: ConfigService<Env, true>) {}

  newSalt(): Buffer {
    return randomBytes(SALT_BYTES);
  }

  async seal(plain: Buffer, salt: Buffer): Promise<Buffer> {
    const key = await this.deriveKey(salt);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    key.fill(0);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async open(sealed: Buffer, salt: Buffer): Promise<Buffer> {
    const key = await this.deriveKey(salt);
    try {
      const iv = sealed.subarray(0, IV_BYTES);
      const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } finally {
      key.fill(0);
    }
  }

  private async deriveKey(salt: Buffer): Promise<Buffer> {
    const passphrase = await this.readPassphrase();
    return new Promise((resolve, reject) => {
      scrypt(passphrase, salt, KEY_BYTES, SCRYPT, (error, key) =>
        error ? reject(error) : resolve(key),
      );
    });
  }

  private async readPassphrase(): Promise<string> {
    const path = this.config.get('SRI_CERTIFICATE_MASTER_KEY_FILE', {
      infer: true,
    });
    if (!path) throw new SigningCertificateStoreNotConfiguredError();
    let passphrase: string;
    try {
      passphrase = (await readFile(path, 'utf8')).trim();
    } catch {
      throw new SigningCertificateStoreNotConfiguredError();
    }
    // A passphrase too short to resist an offline attack on a stolen dump is
    // a misconfiguration, not a passphrase.
    if (passphrase.length < 16) {
      throw new SigningCertificateStoreNotConfiguredError();
    }
    return passphrase;
  }
}
