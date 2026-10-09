import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import type {
  ProcedureConsentView,
  RefusalInput,
  RefusalView,
  RevocationInput,
} from '../domain/procedure-consent';
import {
  PROCEDURE_CONSENT_REPOSITORY,
  type ProcedureConsentRepository,
} from '../domain/procedure-consent.repository';
import type { Requester } from './encounter.service';

/**
 * Its own type in the trail: a refusal or a revocation is a disclosure of
 * its own, apart from the procedure it is about.
 */
const CONSENT_RESOURCE_TYPE = 'procedure_consent';

/**
 * The form 024 beyond registering the procedure with it (EN-152 to EN-154,
 * D-159): the screen's question «¿lo exige?», the refusal and the revocation.
 *
 * A SERVICE OF ITS OWN and not three more methods on `ClinicalCodingService`,
 * which already publishes more than ADR-008 §2's eight use cases and whose
 * questions are about a catalogue concept. These are about a PERSON'S
 * DECISION on an intervention — the A.M. 5316's «proceso de comunicación» —
 * and change when the clinic changes how it documents consent, not when the
 * tariff is republished.
 *
 * ⚠️ NONE OF THEM CLOSES THE ATTENTION (EN-153, D-159.4). «No significa que
 * el profesional dejará de dar atención al paciente»: the refusal is recorded
 * and the attention goes on, with the alternatives the doctor offers.
 */
@Injectable()
export class ProcedureConsentService {
  constructor(
    @Inject(PROCEDURE_CONSENT_REPOSITORY)
    private readonly consents: ProcedureConsentRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProcedureConsentService.name);
  }

  /**
   * EN-152. Whether registering a procedure of this concept on this
   * attention demands the 024. Asked by the screen when the doctor picks the
   * procedure; the write asks again, inside its transaction. Not audited: it
   * says something about the tariff, nothing about the patient.
   */
  async requirement(
    encounterId: string,
    conceptId: string,
    requester: Requester,
  ): Promise<{ required: boolean }> {
    await this.requireEncounter(encounterId, requester);
    return { required: await this.consents.requiresWrittenConsent(conceptId) };
  }

  /** EN-153. The refusal of an intervention, with who refused or the witness. */
  async recordRefusal(
    encounterId: string,
    refusal: RefusalInput,
    requester: Requester,
  ): Promise<RefusalView> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);
    const recorded = await this.consents.addRefusal({
      encounterId: encounter.id,
      refusal,
      recordedById: requester.userId,
      sites: requester.sites,
    });
    await this.audit.record({
      userId: requester.userId,
      resourceType: CONSENT_RESOURCE_TYPE,
      resourceId: recorded.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    this.logger.info(
      { site_id: encounter.siteId, action: 'PROCEDURE_REFUSAL_RECORDED' },
      'procedure refusal recorded',
    );
    return recorded;
  }

  /** EN-154. The revocation of a signed consent; the consent stays as it was. */
  async revoke(
    encounterId: string,
    consentId: string,
    revocation: RevocationInput,
    requester: Requester,
  ): Promise<ProcedureConsentView> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);
    const revoked = await this.consents.revoke({
      encounterId: encounter.id,
      consentId,
      revocation,
      revokedById: requester.userId,
      sites: requester.sites,
    });
    await this.audit.record({
      userId: requester.userId,
      resourceType: CONSENT_RESOURCE_TYPE,
      resourceId: consentId,
      // Nothing is deleted nor changed: the revocation is a row of its own.
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    this.logger.info(
      { site_id: encounter.siteId, action: 'PROCEDURE_CONSENT_REVOKED' },
      'procedure consent revoked',
    );
    return revoked;
  }

  /** EN-121. «No existe» and «es de otra sede» are one refusal. */
  private async requireEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.encounters.findById({
      encounterId,
      sites: requester.sites,
    });
    if (!encounter) throw new EncounterNotFoundError();
    return encounter;
  }

  /**
   * EN-009, D-199.3. A refusal and a revocation are new content: while the
   * attention is open or on hold — the procedure «en curso» of the anexo.
   */
  private async requireLiveEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!acceptsNewClinicalContent(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
    return encounter;
  }
}
