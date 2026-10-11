import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { IdentityFinding } from '../domain/identity-proposal';
import type {
  IdentityLookupStore,
  RegistryStatus,
} from '../domain/identity-lookup.store';

/** IL-007, IL-009, IL-010 over PostgreSQL. */
@Injectable()
export class PrismaIdentityLookupStore implements IdentityLookupStore {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(): Promise<boolean> {
    const row = await this.prisma.identityLookupSetting.findUnique({
      where: { id: true },
    });
    return row?.externalSourcesEnabled ?? false;
  }

  /**
   * The value it replaced is read in the same transaction as the write, so
   * two administrators saving at once chain their trail entries.
   */
  setEnabled(enabled: boolean, at: Date): Promise<{ before: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // The row is materialised first (OFF, the «no row» default), so the
      // `FOR UPDATE` below has something to lock. Without this, two first-time
      // writers both read «no row», both insert, and one hits the primary key
      // with a 500 while neither waits for the other — their trail entries
      // would not chain. `DO NOTHING` keeps the «no row = OFF» meaning.
      await tx.$executeRaw`
        INSERT INTO identity_lookup_setting (id, external_sources_enabled, updated_at)
        VALUES (true, false, ${at})
        ON CONFLICT (id) DO NOTHING`;
      const [current] = await tx.$queryRaw<{ enabled: boolean }[]>`
        SELECT external_sources_enabled AS enabled
        FROM identity_lookup_setting WHERE id FOR UPDATE`;
      await tx.identityLookupSetting.update({
        where: { id: true },
        data: { externalSourcesEnabled: enabled, updatedAt: at },
      });
      // Turning the sources off drops every cached third-party name now, rather
      // than keeping it until it expires or someone writes over it: minimisation
      // (LOPDP), and the reason the switch is the right place to purge.
      if (!enabled) await tx.identityLookupCache.deleteMany({});
      return { before: current?.enabled ?? false };
    });
  }

  async registryStatus(): Promise<RegistryStatus | null> {
    const latest = await this.prisma.sriRucRegistryImport.findFirst({
      orderBy: { importedAt: 'desc' },
      select: { fileName: true, importedAt: true },
    });
    if (!latest) return null;
    const people = await this.prisma.sriRucRegistryEntry.count();
    return { ...latest, people };
  }

  async cached(digest: string, now: Date): Promise<IdentityFinding | null> {
    const row = await this.prisma.identityLookupCache.findUnique({
      where: { cedulaDigest: digest },
    });
    if (!row) return null;
    if (row.expiresAt <= now) {
      await this.prisma.identityLookupCache.deleteMany({
        where: { cedulaDigest: digest, expiresAt: { lte: now } },
      });
      return null;
    }
    return {
      source: 'PROVIDER',
      sourceName: row.sourceName,
      familyName: row.familyName,
      secondFamilyName: row.secondFamilyName,
      givenName: row.givenName,
      secondGivenName: row.secondGivenName,
      birthDate: row.birthDate?.toISOString().slice(0, 10) ?? null,
      orderToReview: false,
    };
  }

  async cache(
    digest: string,
    finding: IdentityFinding,
    fetchedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    const data = {
      source: finding.source,
      sourceName: finding.sourceName,
      familyName: finding.familyName,
      secondFamilyName: finding.secondFamilyName,
      givenName: finding.givenName,
      secondGivenName: finding.secondGivenName,
      // A DATE column: midnight UTC is the calendar day, whatever the zone.
      birthDate: finding.birthDate ? new Date(`${finding.birthDate}T00:00:00Z`) : null, // prettier-ignore
      fetchedAt,
      expiresAt,
    };
    await this.prisma.$transaction([
      // Minimisation: what expired is deleted, not kept until somebody asks.
      this.prisma.identityLookupCache.deleteMany({
        where: { expiresAt: { lte: fetchedAt } },
      }),
      this.prisma.identityLookupCache.upsert({
        where: { cedulaDigest: digest },
        create: { cedulaDigest: digest, ...data },
        update: data,
      }),
    ]);
  }
}
