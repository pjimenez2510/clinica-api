import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  SAMPLE_REGISTRY_FILE,
  importSriRucRegistry,
} from '../../prisma/import-sri-ruc.mts';

import { useDatabase } from './setup/database';

/**
 * What the base guarantees for D-206, against PostgreSQL 18, each refusal next
 * to its positive control: the single row of the switch (IL-010), the shape of
 * the registry (IL-009) and the lifetime of the cache (IL-007).
 */
const DAY_MS = 86_400_000;
const DIGEST = 'b'.repeat(64);

describe('the identity-lookup tables', () => {
  const db = useDatabase();
  let prisma: PrismaClient;
  let now: Date;

  beforeEach(() => {
    prisma = db();
    now = new Date();
  });

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => 'accepted',
      (error: unknown) => String(error),
    );

  it('IL-010 admits one row of settings and no second one', async () => {
    await prisma.$executeRaw`
      INSERT INTO identity_lookup_setting (id, external_sources_enabled, updated_at)
      VALUES (true, true, ${now})`;
    expect(await prisma.identityLookupSetting.count()).toBe(1);

    expect(
      await refusal(prisma.$executeRaw`
        INSERT INTO identity_lookup_setting (id, external_sources_enabled, updated_at)
        VALUES (false, false, ${now})`),
    ).toContain('identity_lookup_setting_single_row');
  });

  it('IL-009 refuses a cedula that is not ten digits and a blank name, and keeps a well-formed one', async () => {
    const version = await prisma.sriRucRegistryImport.create({
      data: { fileSha256: 'c'.repeat(64), fileName: 'manual.csv', rowsImported: 0, importedAt: now }, // prettier-ignore
    });
    await prisma.sriRucRegistryEntry.create({
      data: { cedula: '1701000018', registryName: 'MORA ANA', importId: version.id }, // prettier-ignore
    });

    expect(
      await refusal(prisma.sriRucRegistryEntry.create({ data: { cedula: '17010000AB', registryName: 'MORA ANA', importId: version.id } })), // prettier-ignore
    ).toContain('sri_ruc_registry_entry_cedula_format');
    expect(
      await refusal(prisma.sriRucRegistryEntry.create({ data: { cedula: '1701000026', registryName: '   ', importId: version.id } })), // prettier-ignore
    ).toContain('sri_ruc_registry_entry_name_not_blank');
  });

  it('IL-009 imports the same file once: the second run changes nothing', async () => {
    const first = await importSriRucRegistry(prisma, { file: SAMPLE_REGISTRY_FILE, now }); // prettier-ignore
    expect(first).toMatchObject({ status: 'imported', kept: 6 });
    const rows = await prisma.sriRucRegistryEntry.findMany({ orderBy: { cedula: 'asc' } }); // prettier-ignore

    const second = await importSriRucRegistry(prisma, { file: SAMPLE_REGISTRY_FILE, now }); // prettier-ignore

    expect(second.status).toBe('unchanged');
    expect(await prisma.sriRucRegistryImport.count()).toBe(1);
    expect(await prisma.sriRucRegistryEntry.findMany({ orderBy: { cedula: 'asc' } })).toEqual(rows); // prettier-ignore
    // Only natural persons, and only cedula and name: no company, no
    // establishment 002, no blank name.
    expect(rows.map((r) => r.cedula)).toEqual([
      '0101000065',
      '0901000042',
      '0901000059',
      '1701000018',
      '1701000026',
      '1701000034',
    ]);
    expect(rows.find((r) => r.cedula === '1701000034')?.registryName).toBe('MUÑOZ ARÉVALO ANA'); // prettier-ignore
  });

  it('IL-009 refuses two versions with the same SHA-256 in the base, not only in the script', async () => {
    const data = { fileSha256: 'd'.repeat(64), fileName: 'a.csv', rowsImported: 0, importedAt: now }; // prettier-ignore
    await prisma.sriRucRegistryImport.create({ data });
    expect(await refusal(prisma.sriRucRegistryImport.create({ data }))).toMatch(/Unique|unique|P2002/); // prettier-ignore
  });

  it('IL-009 updates a cedula that reappears with the newer file, and reads a Latin-1 file', async () => {
    await importSriRucRegistry(prisma, { file: SAMPLE_REGISTRY_FILE, now });
    const dir = mkdtempSync(join(tmpdir(), 'catastro-'));
    const file = join(dir, 'otra-provincia.csv');
    writeFileSync(
      file,
      Buffer.from('NUMERO_RUC;RAZON_SOCIAL\n1701000018001;GUAMAN QUISPE MARÍA JOSÉ\n1801000074001;PEÑA ORTIZ LUIS\n', 'latin1'), // prettier-ignore
    );

    expect(await importSriRucRegistry(prisma, { file, now })).toMatchObject({ status: 'imported', kept: 2 }); // prettier-ignore

    expect(await prisma.sriRucRegistryImport.count()).toBe(2);
    expect((await prisma.sriRucRegistryEntry.findUnique({ where: { cedula: '1701000018' } }))?.registryName).toBe('GUAMAN QUISPE MARÍA JOSÉ'); // prettier-ignore
    expect((await prisma.sriRucRegistryEntry.findUnique({ where: { cedula: '1801000074' } }))?.registryName).toBe('PEÑA ORTIZ LUIS'); // prettier-ignore
  });

  it('IL-007 keeps a cache entry for up to ninety days and refuses one beyond, or already expired', async () => {
    const entry = (expiresAt: Date, digest = DIGEST) =>
      prisma.identityLookupCache.create({
        data: { cedulaDigest: digest, source: 'PROVIDER', sourceName: 'MORA ANA', familyName: 'MORA', givenName: 'ANA', fetchedAt: now, expiresAt }, // prettier-ignore
      });

    await entry(new Date(now.getTime() + 90 * DAY_MS));
    expect(await prisma.identityLookupCache.count()).toBe(1);

    expect(await refusal(entry(new Date(now.getTime() + 90 * DAY_MS + 1000), 'e'.repeat(64)))).toContain('identity_lookup_cache_lifetime'); // prettier-ignore
    expect(await refusal(entry(now, 'f'.repeat(64)))).toContain('identity_lookup_cache_lifetime'); // prettier-ignore
  });

  it('IL-007 refuses a digest that is not a SHA-256 in hex: a cedula cannot sneak in as the key', async () => {
    expect(
      await refusal(
        prisma.identityLookupCache.create({
          data: { cedulaDigest: '1701000018', source: 'PROVIDER', sourceName: 'MORA ANA', fetchedAt: now, expiresAt: new Date(now.getTime() + DAY_MS) }, // prettier-ignore
        }),
      ),
    ).toContain('identity_lookup_cache_digest_format');
  });
});
