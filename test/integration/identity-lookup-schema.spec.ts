import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  SAMPLE_REGISTRY_FILE,
  importSriRucRegistry,
} from '../../prisma/import-sri-ruc.mts';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { PrismaIdentityLookupStore } from '../../src/modules/identity-lookup/infrastructure/prisma-identity-lookup.store';
import type { IdentityFinding } from '../../src/modules/identity-lookup/domain/identity-proposal';

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

  it('IL-009 refuses two versions with the same SHA256 in the base, not only in the script', async () => {
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

  it('IL-007 refuses a digest that is not a SHA256 in hex: a cedula cannot sneak in as the key', async () => {
    expect(
      await refusal(
        prisma.identityLookupCache.create({
          data: { cedulaDigest: '1701000018', source: 'PROVIDER', sourceName: 'MORA ANA', fetchedAt: now, expiresAt: new Date(now.getTime() + DAY_MS) }, // prettier-ignore
        }),
      ),
    ).toContain('identity_lookup_cache_digest_format');
  });

  it('IL-007 refuses a source the union does not know, a bad SHA and a negative count', async () => {
    expect(
      await refusal(
        prisma.identityLookupCache.create({
          data: { cedulaDigest: 'a'.repeat(64), source: 'OTHER', sourceName: 'MORA ANA', fetchedAt: now, expiresAt: new Date(now.getTime() + DAY_MS) }, // prettier-ignore
        }),
      ),
    ).toContain('identity_lookup_cache_source_known');
    expect(
      await refusal(
        prisma.sriRucRegistryImport.create({
          data: { fileSha256: 'NOT-HEX', fileName: 'a.csv', rowsImported: 0, importedAt: now }, // prettier-ignore
        }),
      ),
    ).toContain('sri_ruc_registry_import_sha256_format');
    expect(
      await refusal(
        prisma.sriRucRegistryImport.create({
          data: { fileSha256: 'a'.repeat(64), fileName: 'a.csv', rowsImported: -1, importedAt: now }, // prettier-ignore
        }),
      ),
    ).toContain('sri_ruc_registry_import_rows_non_negative');
  });

  it('IL-009 will not delete an import that still has entries (RESTRICT)', async () => {
    const version = await prisma.sriRucRegistryImport.create({
      data: { fileSha256: 'b'.repeat(64), fileName: 'a.csv', rowsImported: 1, importedAt: now }, // prettier-ignore
    });
    await prisma.sriRucRegistryEntry.create({
      data: { cedula: '1701000018', registryName: 'MORA ANA', importId: version.id }, // prettier-ignore
    });
    expect(
      await refusal(prisma.sriRucRegistryImport.delete({ where: { id: version.id } })), // prettier-ignore
    ).toMatch(/Foreign key|foreign key|RESTRICT|P2003/);
    // Positive control: with its entries gone, the import deletes.
    await prisma.sriRucRegistryEntry.deleteMany({ where: { importId: version.id } }); // prettier-ignore
    await prisma.sriRucRegistryImport.delete({ where: { id: version.id } });
    expect(await prisma.sriRucRegistryImport.count()).toBe(0);
  });
});

/**
 * IL-007 against PostgreSQL through the real store: the cache round-trip, the
 * birth-date DATE, the purge of what expired, and the switch. A double would
 * only re-implement the lifetime it is meant to prove.
 */
describe('the identity-lookup store (IL-007, IL-010)', () => {
  const db = useDatabase();
  const DAY = 86_400_000;
  // The store wants a PrismaService; a PrismaClient is structurally the same.
  const storeOf = () =>
    new PrismaIdentityLookupStore(db() as unknown as PrismaService);

  const finding = (name: string): IdentityFinding => ({
    source: 'PROVIDER',
    sourceName: name,
    familyName: name,
    secondFamilyName: null,
    givenName: 'Ana',
    secondGivenName: null,
    birthDate: '1990-05-17', // fecha-fija: la que devolvería el proveedor
    orderToReview: false,
  });

  it('IL-007 reads back a cached answer within thirty days, birth date included', async () => {
    const store = storeOf();
    const now = new Date();
    const digest = 'a'.repeat(64);
    await store.cache(digest, finding('Mora'), now, new Date(now.getTime() + 30 * DAY)); // prettier-ignore

    const hit = await store.cached(digest, new Date(now.getTime() + 30 * DAY - 1)); // prettier-ignore
    expect(hit).toMatchObject({ familyName: 'Mora', birthDate: '1990-05-17' }); // fecha-fija: la fecha de nacimiento que devolvió el proveedor
  });

  it('IL-007 does not return an expired entry and deletes it on read', async () => {
    const store = storeOf();
    const now = new Date();
    const digest = 'b'.repeat(64);
    await store.cache(digest, finding('Vera'), now, new Date(now.getTime() + 30 * DAY)); // prettier-ignore

    expect(await store.cached(digest, new Date(now.getTime() + 30 * DAY))).toBeNull(); // prettier-ignore
    expect(await db().identityLookupCache.count()).toBe(0);
  });

  it('IL-007 purges every expired entry when a new one is written, keeping the live one', async () => {
    const store = storeOf();
    const now = new Date();
    const stale = 'c'.repeat(64);
    const fresh = 'd'.repeat(64);
    // A stale entry written in the past, still in the table.
    const past = new Date(now.getTime() - 40 * DAY);
    await store.cache(stale, finding('Vieja'), past, new Date(past.getTime() + 30 * DAY)); // prettier-ignore
    expect(await db().identityLookupCache.count()).toBe(1);

    await store.cache(fresh, finding('Nueva'), now, new Date(now.getTime() + 30 * DAY)); // prettier-ignore

    const left = await db().identityLookupCache.findMany();
    expect(left.map((r) => r.cedulaDigest)).toEqual([fresh]);
  });

  it('IL-010 enabling with no row answers {before:false}, and disabling clears the cache', async () => {
    const store = storeOf();
    const now = new Date();
    expect(await store.setEnabled(true, now)).toEqual({ before: false });
    expect(await store.isEnabled()).toBe(true);

    await store.cache('e'.repeat(64), finding('Mora'), now, new Date(now.getTime() + 30 * DAY)); // prettier-ignore
    expect(await store.setEnabled(false, now)).toEqual({ before: true });
    expect(await store.isEnabled()).toBe(false);
    // Minimisation: turning it off drops the third-party names at once.
    expect(await db().identityLookupCache.count()).toBe(0);
  });
});
