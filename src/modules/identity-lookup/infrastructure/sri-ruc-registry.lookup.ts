import { Injectable } from '@nestjs/common';

import type { Cedula } from '../../../shared/domain/value-objects/cedula.vo';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  IdentityFinding,
  IdentityLookup,
} from '../domain/identity-proposal';
import {
  normaliseRegistryName,
  splitRegistryName,
} from '../domain/registry-name';

/**
 * IL-001, IL-005 (D-206 §1 b). The SRI RUC registry, as IMPORTED into the
 * local table by `pnpm db:import:sri-ruc`. Nothing here leaves the database:
 * the registry is a downloaded file, never a request to the SRI.
 *
 * Only people with a RUC are in it. The name is one field, so the proposal is
 * always marked «revise el orden» (D-209).
 */
@Injectable()
export class SriRucRegistryLookup implements IdentityLookup {
  readonly source = 'SRI_RUC_REGISTRY' as const;

  constructor(private readonly prisma: PrismaService) {}

  async findByCedula(cedula: Cedula): Promise<IdentityFinding | null> {
    const entry = await this.prisma.sriRucRegistryEntry.findUnique({
      where: { cedula: cedula.toString() },
      select: { registryName: true },
    });
    if (!entry) return null;

    const sourceName = normaliseRegistryName(entry.registryName);
    return {
      source: this.source,
      sourceName,
      ...splitRegistryName(sourceName),
      birthDate: null,
      orderToReview: true,
    };
  }
}
