import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  ProgramBlockNotApplicableError,
} from '../domain/encounter.errors';
import type {
  EncounterRepository,
  EncounterView,
} from '../domain/encounter.repository';
import type {
  NutritionAnswer,
  NutritionRecord,
  ObstetricAnswer,
  ObstetricRecord,
  PrescribedMedicine,
  SupplementAnswer,
  SupplementRecord,
  VaccinationAnswer,
  VaccinationRecord,
} from '../domain/program-blocks';
import type {
  ProgramBlockSave,
  ProgramBlocksRepository,
  VaccineOption,
} from '../domain/program-blocks.repository';

import type { Requester } from './encounter.service';
import { ProgramBlocksService } from './program-blocks.service';

/**
 * EN-090, EN-092, EN-093, EN-097, EN-249 against in-memory ports: which
 * blocks the attention takes, what the service refuses before writing, and
 * the protected risk group left out without the key. The same rules are the
 * database's (`test/integration/encounter-programs.spec.ts`).
 */
const SITE = 'site-1';
const requester: Requester = { userId: 'user-1', sites: [SITE] };

const anEncounter = (overrides: Partial<EncounterView> = {}): EncounterView =>
  ({
    id: 'encounter-1',
    siteId: SITE,
    status: 'OPEN',
    startedAt: new Date(),
    ageYears: 28,
    ageMonths: 2,
    ageDays: 3,
    ...overrides,
  }) as EncounterView;

const stamp = () => ({ recordedAt: new Date(), editedAt: null });

class FakeBlocks implements ProgramBlocksRepository {
  pregnant = false;
  obstetric: ObstetricRecord | null = null;
  nutrition: NutritionRecord | null = null;
  vaccination: VaccinationRecord | null = null;
  protectedWrites: boolean[] = [];

  isPregnant() {
    return Promise.resolve(this.pregnant);
  }
  sex = 'FEMALE';
  lactating = false;
  medicines: PrescribedMedicine[] = [];
  supplement: SupplementRecord | null = null;
  patientSexOf() {
    return Promise.resolve(this.sex);
  }
  isLactating() {
    return Promise.resolve(this.lactating);
  }
  prescribedMedicines() {
    return Promise.resolve(this.medicines);
  }
  findSupplement() {
    return Promise.resolve(this.supplement);
  }
  saveSupplement(
    _q: unknown,
    answer: SupplementAnswer,
  ): Promise<ProgramBlockSave<SupplementRecord>> {
    this.supplement = { ...answer, ...stamp() };
    return Promise.resolve({ record: this.supplement, outcome: 'CREATED' });
  }
  vaccinesInForce(): Promise<VaccineOption[]> {
    return Promise.resolve([{ code: '55', display: 'BCG' }]);
  }
  findObstetric() {
    return Promise.resolve(this.obstetric);
  }
  findNutrition() {
    return Promise.resolve(this.nutrition);
  }
  findVaccination() {
    return Promise.resolve(this.vaccination);
  }
  saveObstetric(
    _q: unknown,
    answer: ObstetricAnswer,
  ): Promise<ProgramBlockSave<ObstetricRecord>> {
    const outcome = this.obstetric ? 'UPDATED' : 'CREATED';
    this.obstetric = { ...answer, ...stamp() };
    return Promise.resolve({ record: this.obstetric, outcome });
  }
  saveNutrition(
    _q: unknown,
    answer: NutritionAnswer,
  ): Promise<ProgramBlockSave<NutritionRecord>> {
    this.nutrition = { ...answer, ...stamp() };
    return Promise.resolve({ record: this.nutrition, outcome: 'CREATED' });
  }
  saveVaccination(
    _q: unknown,
    answer: VaccinationAnswer,
    _author: string,
    canWriteProtected: boolean,
  ): Promise<ProgramBlockSave<VaccinationRecord>> {
    this.protectedWrites.push(canWriteProtected);
    this.vaccination = { ...answer, ...stamp() };
    return Promise.resolve({ record: this.vaccination, outcome: 'UNCHANGED' });
  }
}

const OBSTETRIC: ObstetricAnswer = {
  risk: 'LOW',
  birthPlan: true,
  transportPlan: true,
  plannedPregnancy: true,
  gestationalAgeMethod: 'CLINICAL',
  lastMenstrualPeriod: null,
  gestationalWeeks: 20,
  nonTreponemalTest: null,
  treponemalTest: null,
  syphilisTreatment: null,
  partnerTreatment: null,
  bacteriuria: null,
};

describe('ProgramBlocksService (EN-090 a EN-093)', () => {
  let encounter: EncounterView | null;
  let blocks: FakeBlocks;
  let trail: AccessAuditEntry[];
  let service: ProgramBlocksService;

  beforeEach(() => {
    encounter = anEncounter();
    blocks = new FakeBlocks();
    trail = [];
    const encounters = {
      findById: () => Promise.resolve(encounter),
    } as unknown as EncounterRepository;
    const audit: AccessAuditRecorder = {
      record: (entry) => {
        trail.push(entry);
        return Promise.resolve();
      },
    };
    service = new ProgramBlocksService(encounters, blocks, audit);
  });

  it('EN-097 una atención sin bloques registrados no deja fila de bitácora; con uno, una', async () => {
    blocks.sex = 'MALE';
    const empty = await service.programsOf('encounter-1', requester, () => true); // prettier-ignore
    expect(empty.obstetric).toEqual({ applies: false, record: null });
    expect(empty.nutrition.band).toBeNull();
    expect(trail).toHaveLength(0);

    blocks.nutrition = { motherBreastfeeding: true, exclusiveBreastfeeding: true, complementaryFeeding: null, ...stamp() }; // prettier-ignore
    await service.programsOf('encounter-1', requester, () => true);
    expect(trail.map((entry) => entry.action)).toEqual(['READ']);
  });

  it('EN-090 rechaza el bloque obstétrico sin embarazo, y lo registra con él', async () => {
    await expect(service.recordObstetric('encounter-1', OBSTETRIC, requester)).rejects.toBeInstanceOf(ProgramBlockNotApplicableError); // prettier-ignore
    expect(blocks.obstetric).toBeNull();

    blocks.pregnant = true;
    await service.recordObstetric('encounter-1', OBSTETRIC, requester);
    expect(blocks.obstetric).toMatchObject({ risk: 'LOW' });
    expect(trail.map((entry) => entry.action)).toEqual(['CREATE']);
  });

  it('EN-092 el SIVAN pasados los 8 meses, o con la pregunta del otro tramo, no corresponde', async () => {
    const answer = { motherBreastfeeding: true, exclusiveBreastfeeding: true, complementaryFeeding: null }; // prettier-ignore
    await expect(service.recordNutrition('encounter-1', answer, requester)).rejects.toBeInstanceOf(ProgramBlockNotApplicableError); // prettier-ignore

    encounter = anEncounter({ ageYears: 0, ageMonths: 7 });
    await expect(service.recordNutrition('encounter-1', answer, requester)).rejects.toBeInstanceOf(ProgramBlockNotApplicableError); // prettier-ignore

    encounter = anEncounter({ ageYears: 0, ageMonths: 4 });
    await service.recordNutrition('encounter-1', answer, requester);
    expect(blocks.nutrition).toMatchObject(answer);
  });

  it('EN-260 a la mujer de 10 a 49 años se le ofrece su lactancia, sin las preguntas del lactante; a un hombre, no', async () => {
    const own = { motherBreastfeeding: true, exclusiveBreastfeeding: null, complementaryFeeding: null }; // prettier-ignore
    expect((await service.programsOf('encounter-1', requester, () => true)).nutrition.band).toBe('LACTATING_AGE_WOMAN'); // prettier-ignore
    await expect(service.recordNutrition('encounter-1', { ...own, exclusiveBreastfeeding: true }, requester)).rejects.toBeInstanceOf(ProgramBlockNotApplicableError); // prettier-ignore
    await service.recordNutrition('encounter-1', own, requester);
    expect(blocks.nutrition).toMatchObject(own);

    blocks.sex = 'MALE';
    expect((await service.programsOf('encounter-1', requester, () => true)).nutrition.band).toBeNull(); // prettier-ignore
    await expect(service.recordNutrition('encounter-1', own, requester)).rejects.toBeInstanceOf(ProgramBlockNotApplicableError); // prettier-ignore
  });

  it('EN-262 propone los suplementos de la población desde la receta, y EN-096 rechaza el de otra población', async () => {
    encounter = anEncounter({ ageYears: 3, ageMonths: 0 });
    blocks.medicines = [{ cnmbCode: 'B03AA07', dosageFormCode: 'SYRUP' }];
    const sheet = await service.programsOf('encounter-1', requester, () => true); // prettier-ignore
    expect(sheet.supplements.applies).toEqual({ micronutrientPowder: false, vitaminA: true, ironSyrup: true, ironFolicAcid: false }); // prettier-ignore
    expect(sheet.supplements.proposed).toEqual({ micronutrientPowder: null, vitaminA: false, ironSyrup: true, ironFolicAcid: null }); // prettier-ignore
    expect(sheet.supplements.record).toBeNull();

    const none = { micronutrientPowder: null, vitaminA: null, ironSyrup: null, ironFolicAcid: null }; // prettier-ignore
    await expect(service.recordSupplements('encounter-1', { ...none, ironFolicAcid: true }, requester)).rejects.toBeInstanceOf(ProgramBlockNotApplicableError); // prettier-ignore
    // «Sí» without a prescription is the MSP's programme: it goes in.
    await service.recordSupplements('encounter-1', { ...none, vitaminA: true, ironSyrup: true }, requester); // prettier-ignore
    expect(blocks.supplement).toMatchObject({
      vitaminA: true,
      ironSyrup: true,
    });
  });

  it('EN-096 EN-260 a la mujer lactante se le ofrece el hierro con ácido fólico', async () => {
    blocks.lactating = true;
    expect((await service.programsOf('encounter-1', requester, () => true)).supplements.applies.ironFolicAcid).toBe(true); // prettier-ignore
  });

  it('EN-249 con la atención de alta no se escribe ningún bloque; sin atención en el alcance, 404', async () => {
    blocks.pregnant = true;
    encounter = anEncounter({ status: 'DISCHARGED' });
    await expect(service.recordObstetric('encounter-1', OBSTETRIC, requester)).rejects.toBeInstanceOf(EncounterAlreadyClosedError); // prettier-ignore
    encounter = null;
    await expect(service.programsOf('encounter-1', requester, () => true)).rejects.toBeInstanceOf(EncounterNotFoundError); // prettier-ignore
  });

  it('EN-093 sin la llave en la sede, el grupo del HB adulto no sale; con ella, sí; y la llave llega al guardado', async () => {
    blocks.vaccination = { doses: [{ code: '70', dose: 'FIRST', riskGroup: 'LIVING_WITH_HIV' }, { code: '67', dose: 'FIRST', riskGroup: 'AGES_AT_RISK' }], ...stamp() }; // prettier-ignore

    const without = await service.programsOf('encounter-1', requester, () => false); // prettier-ignore
    expect(without.vaccination.record?.doses.map((dose) => dose.riskGroup)).toEqual([null, 'AGES_AT_RISK']); // prettier-ignore
    expect(without.vaccination.riskGroupWithheld).toBe(true);

    const withKey = await service.programsOf('encounter-1', requester, (site) => site === SITE); // prettier-ignore
    expect(withKey.vaccination.record?.doses[0]?.riskGroup).toBe(
      'LIVING_WITH_HIV',
    );
    expect(withKey.vaccination.riskGroupWithheld).toBe(false);

    // EN-261. The save's answer withholds it too.
    const saved = await service.recordVaccination('encounter-1', blocks.vaccination, requester, () => false); // prettier-ignore
    expect(saved.doses[0]?.riskGroup).toBeNull();
    expect(blocks.protectedWrites).toEqual([false]);
    // UNCHANGED leaves no trail row of a write.
    expect(trail.filter((entry) => entry.action !== 'READ')).toHaveLength(0);
  });
});
