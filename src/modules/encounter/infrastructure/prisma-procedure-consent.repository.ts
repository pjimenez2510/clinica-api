import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  ConceptWrongCatalogueError,
  ConsentNotFoundError,
  ConsentNotRevocableError,
  ConsentRepresentativeRequiredError,
  ConsentWitnessRequiredError,
} from '../domain/encounter.errors';
import type { SiteScopeFilter } from '../domain/encounter.repository';
import {
  refusalProblem,
  revocationProblem,
  type ProcedureConsentView,
  type RefusalInput,
  type RefusalView,
  type RevocationInput,
} from '../domain/procedure-consent';
import type { ProcedureConsentRepository } from '../domain/procedure-consent.repository';

import {
  conceptForEncounter,
  requireEncounterInScope,
} from './prisma-clinical-coding.repository';
import {
  consentById,
  refusalById,
  representativeColumns,
  requiresWrittenConsent,
  resolveInformer,
} from './procedure-consent.records';

/**
 * The refusal and the revocation of the form 024 over PostgreSQL (EN-153,
 * EN-154). `procedure_consent` and `procedure_consent_revocation` refuse,
 * underneath, every row that does not say who and when, and every edit.
 */
@Injectable()
export class PrismaProcedureConsentRepository implements ProcedureConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  requiresWrittenConsent(conceptId: string): Promise<boolean> {
    return requiresWrittenConsent(this.prisma, conceptId);
  }

  /** EN-153. Under the attention's lock, which must still be live (EN-009). */
  async addRefusal(request: {
    encounterId: string;
    refusal: RefusalInput;
    recordedById: string;
    sites: SiteScopeFilter;
  }): Promise<RefusalView> {
    const { refusal } = request;
    const problem = refusalProblem(refusal);
    if (problem === 'WITNESS_REQUIRED') throw new ConsentWitnessRequiredError();
    if (problem === 'REPRESENTATIVE_REQUIRED') {
      throw new ConsentRepresentativeRequiredError();
    }
    const now = new Date();
    const id = await this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(tx, request.encounterId, request.sites);
      const concept = await conceptForEncounter(
        tx,
        request.encounterId,
        refusal.conceptId,
      );
      if (concept === undefined || concept.system_code !== 'TARIFF') {
        throw new ConceptWrongCatalogueError('TARIFF');
      }
      // D-199.4. Who informed, as in the signed consent.
      const informedById = await resolveInformer(
        tx,
        request.encounterId,
        refusal.informedById,
      );
      const witness =
        refusal.signer === 'NONE' && refusal.witness !== null
          ? {
              witnessName: refusal.witness.name.trim(),
              witnessDocument: refusal.witness.document.trim(),
            }
          : {};
      const row = await tx.procedureConsent.create({
        data: {
          encounterId: request.encounterId,
          conceptId: refusal.conceptId,
          kind: 'REFUSED',
          signer: refusal.signer,
          ...representativeColumns(
            refusal.signer === 'REPRESENTATIVE' ? refusal.representative : null,
          ),
          ...witness,
          informedById,
          signedAt: now,
          recordedAt: now,
          recordedById: request.recordedById,
        },
        select: { id: true },
      });
      return row.id;
    });
    return refusalById(this.prisma, id);
  }

  /**
   * EN-154. A row of its own: `procedure_consent_revocation_pkey` makes it
   * once, `…_of_signed` only of a signed consent. Both are asked first so the
   * answer is a sentence, not a constraint.
   */
  async revoke(request: {
    encounterId: string;
    consentId: string;
    revocation: RevocationInput;
    revokedById: string;
    sites: SiteScopeFilter;
  }): Promise<ProcedureConsentView> {
    const { revocation } = request;
    if (revocationProblem(revocation) !== null) {
      throw new ConsentRepresentativeRequiredError();
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(tx, request.encounterId, request.sites);
      const consent = await tx.procedureConsent.findFirst({
        where: { id: request.consentId, encounterId: request.encounterId },
        select: { kind: true, revocation: { select: { consentId: true } } },
      });
      if (consent === null) throw new ConsentNotFoundError();
      if (consent.kind !== 'SIGNED' || consent.revocation !== null) {
        throw new ConsentNotRevocableError();
      }
      await tx.procedureConsentRevocation.create({
        data: {
          consentId: request.consentId,
          signer: revocation.signer,
          ...representativeColumns(
            revocation.signer === 'REPRESENTATIVE'
              ? revocation.representative
              : null,
          ),
          revokedAt: now,
          revokedById: request.revokedById,
        },
      });
    });
    return consentById(this.prisma, request.consentId);
  }
}
