import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  ProgramBlockNotApplicableError,
} from '../domain/encounter.errors';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import {
  nutritionBandOf,
  nutritionProblem,
  riskGroupIsProtected,
  type NutritionAnswer,
  type NutritionBand,
  type NutritionRecord,
  type ObstetricAnswer,
  type ObstetricRecord,
  type VaccinationAnswer,
  type VaccinationRecord,
} from '../domain/program-blocks';
import {
  PROGRAM_BLOCKS_REPOSITORY,
  type ProgramBlocksRepository,
  type VaccineOption,
} from '../domain/program-blocks.repository';
import type { Requester } from './encounter.service';

/** Its own type in the trail: the program blocks of a person's attention. */
const PROGRAM_RESOURCE_TYPE = 'encounter_program';

/**
 * EN-090, EN-092, EN-093, EN-097. Which program blocks the attention takes
 * and what was recorded in each. A block whose population the attention does
 * not reach comes with `applies: false` / `band: null`: the screen does not
 * show it — unless something was recorded while it did (a pregnancy record
 * corrected afterwards), which is shown, never hidden.
 */
export interface ProgramsSheet {
  /** `YYYY-MM-DD` in America/Guayaquil: what the screen proposes weeks against. */
  clinicalDate: string;
  obstetric: { applies: boolean; record: ObstetricRecord | null };
  nutrition: { band: NutritionBand | null; record: NutritionRecord | null };
  vaccination: {
    /** The vaccines in force on the clinical date, in the form's order. */
    vaccines: VaccineOption[];
    record: VaccinationRecord | null;
    /**
     * REQ-115. The risk group of an adult hepatitis B, left out for whoever
     * lacks the second key — whatever group it is, so the absence tells
     * nothing beyond the vaccine everybody sees.
     */
    riskGroupWithheld: boolean;
  };
}

/** Whether the caller holds `record:protected` at a site. */
export type HoldsKeyAt = (siteId: string) => boolean;

/**
 * EN-090 to EN-093, EN-097, EN-249. Blocks G, H and I of the RDACAA form.
 *
 * A SERVICE OF ITS OWN: the instructivo's populations and catalogues are a
 * reason to change none of the attention's other use cases has. Block J is
 * not here: it has the door of the violence screening (EN-095).
 *
 * The population of each block is answered HERE before anything is written,
 * so the 422 names the block; the database refuses the same (its triggers),
 * and the coherence of vaccines and risk groups is the database's alone,
 * which answers naming the field.
 */
@Injectable()
export class ProgramBlocksService {
  constructor(
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(PROGRAM_BLOCKS_REPOSITORY)
    private readonly blocks: ProgramBlocksRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /** EN-090, EN-092, EN-093, EN-097. Audited when something is disclosed. */
  async programsOf(
    encounterId: string,
    requester: Requester,
    holdsKeyAt: HoldsKeyAt,
  ): Promise<ProgramsSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);
    const query = { encounterId: encounter.id, sites: requester.sites };
    const [pregnant, vaccines, obstetric, nutrition, vaccination] =
      await Promise.all([
        this.blocks.isPregnant(encounter.id),
        this.blocks.vaccinesInForce(encounter.id),
        this.blocks.findObstetric(query),
        this.blocks.findNutrition(query),
        this.blocks.findVaccination(query),
      ]);

    const withheld =
      vaccination !== null &&
      vaccination.riskGroup !== null &&
      riskGroupIsProtected(vaccination.doses.map((dose) => dose.code)) &&
      !holdsKeyAt(encounter.siteId);

    if (obstetric || nutrition || vaccination) {
      await this.trail(requester, encounter.id, 'READ');
    }

    return {
      clinicalDate: clinicalDateOf(encounter.startedAt),
      obstetric: { applies: pregnant, record: obstetric },
      nutrition: { band: nutritionBandOf(encounter), record: nutrition },
      vaccination: {
        vaccines,
        record:
          vaccination && withheld
            ? { ...vaccination, riskGroup: null }
            : vaccination,
        riskGroupWithheld: withheld,
      },
    };
  }

  /** EN-090, EN-091, EN-249. Block G, only with the pregnancy on the chart that day. */
  async recordObstetric(
    encounterId: string,
    answer: ObstetricAnswer,
    requester: Requester,
  ): Promise<ObstetricRecord> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);
    if (!(await this.blocks.isPregnant(encounter.id))) {
      throw new ProgramBlockNotApplicableError('OBSTETRIC');
    }
    const saved = await this.blocks.saveObstetric(
      { encounterId: encounter.id, sites: requester.sites },
      answer,
      requester.userId,
    );
    await this.trailSave(requester, encounter.id, saved.outcome);
    return saved.record;
  }

  /** EN-092, EN-249. Block H, with the question of the frozen age's band. */
  async recordNutrition(
    encounterId: string,
    answer: NutritionAnswer,
    requester: Requester,
  ): Promise<NutritionRecord> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);
    const band = nutritionBandOf(encounter);
    const problem = band && nutritionProblem(band, answer);
    if (band === null || problem?.kind === 'notApplicable') {
      throw new ProgramBlockNotApplicableError('NUTRITION');
    }
    // `required` is left to the database, which names the field.
    const saved = await this.blocks.saveNutrition(
      { encounterId: encounter.id, sites: requester.sites },
      answer,
      requester.userId,
    );
    await this.trailSave(requester, encounter.id, saved.outcome);
    return saved.record;
  }

  /**
   * EN-093, EN-249. Block I. Whether the risk group fits the vaccines, and
   * every code is a vaccine in force that day, is the database's. Without
   * the second key at the site, nothing that carries the protected risk
   * group is written (the adapter, under the lock).
   */
  async recordVaccination(
    encounterId: string,
    answer: VaccinationAnswer,
    requester: Requester,
    holdsKeyAt: HoldsKeyAt,
  ): Promise<VaccinationRecord> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);
    const saved = await this.blocks.saveVaccination(
      { encounterId: encounter.id, sites: requester.sites },
      answer,
      requester.userId,
      holdsKeyAt(encounter.siteId),
    );
    await this.trailSave(requester, encounter.id, saved.outcome);
    return saved.record;
  }

  private async trailSave(
    requester: Requester,
    encounterId: string,
    outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED',
  ): Promise<void> {
    if (outcome === 'UNCHANGED') return;
    await this.trail(
      requester,
      encounterId,
      outcome === 'CREATED' ? 'CREATE' : 'UPDATE',
    );
  }

  private async trail(
    requester: Requester,
    encounterId: string,
    action: 'READ' | 'CREATE' | 'UPDATE',
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: PROGRAM_RESOURCE_TYPE,
      resourceId: encounterId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

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
}
