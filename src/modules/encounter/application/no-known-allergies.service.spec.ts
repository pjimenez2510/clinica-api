import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type {
  ActiveAllergy,
  ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  AllergyRefutedAloneError,
  ChartHasAllergiesError,
  NoKnownAllergiesNotStandingError,
  PatientChartNotOpenError,
} from '../domain/encounter.errors';
import type {
  EncounterRepository,
  PatientChartStatus,
} from '../domain/encounter.repository';
import { BULK_REFUTATION_NOTE } from '../domain/allergy-refutation';
import type {
  AllergyAbsenceAssertion,
  NewAllergyAbsence,
  PatientAllergyRepository,
  RefuteAndAssertNoKnownAllergies,
  RefutedAndAsserted,
  RetractNoKnownAllergies,
} from '../domain/patient-allergy.repository';
import type { Requester } from './encounter.service';
import { NoKnownAllergiesService } from './no-known-allergies.service';

/**
 * EN-087 and EN-226 against in-memory ports: the rules a double CAN show —
 * whose name goes on the assertion, that the brake holds when an active
 * allergy was not named, what reaches the trail. That the refutations and the
 * assertion are one transaction, and that the database refuses the rest, is in
 * `test/integration/patient-background-edit.spec.ts`.
 */

const PATIENT = 'patient-1';
const USER = 'user-1';

const requester: Requester = {
  userId: USER,
  sites: ['site-1'],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anActiveAllergy = (
  id: string,
  criticality: ActiveAllergy['criticality'] = 'LOW',
): ActiveAllergy => ({
  id,
  patientId: PATIENT,
  substanceConceptId: null,
  substanceText: 'Penicilina',
  reaction: null,
  criticality,
  recordedAt: new Date(),
});

const anAssertion = (): AllergyAbsenceAssertion => ({
  id: 'absence-1',
  patientId: PATIENT,
  assertedById: USER,
  assertedByName: 'Ana Villacís',
  assertedAt: new Date(),
});

class FakeEncounters {
  chart: PatientChartStatus | null = { id: PATIENT, mergedIntoId: null };

  findPatientChart(patientId: string): Promise<PatientChartStatus | null> {
    return Promise.resolve(
      this.chart !== null && this.chart.id === patientId ? this.chart : null,
    );
  }
}

/** Only what this service reaches; the rest of the port is unused here. */
class FakeAbsences {
  absences: NewAllergyAbsence[] = [];
  composite: RefuteAndAssertNoKnownAllergies[] = [];
  retractions: RetractNoKnownAllergies[] = [];
  standing: AllergyAbsenceAssertion | null = anAssertion();
  retractAnswer = true;
  /** The ones the step really refuted; `null` answers «all it was given». */
  refutedAnswer: string[] | null = null;

  assertNoKnownAllergies(
    assertion: NewAllergyAbsence,
  ): Promise<AllergyAbsenceAssertion> {
    this.absences.push(assertion);
    return Promise.resolve(anAssertion());
  }

  refuteAndAssertNoKnownAllergies(
    request: RefuteAndAssertNoKnownAllergies,
  ): Promise<RefutedAndAsserted> {
    this.composite.push(request);
    return Promise.resolve({
      assertion: anAssertion(),
      refutedAllergyIds: this.refutedAnswer ?? [...request.allergyIds],
    });
  }

  standingAbsenceFor(): Promise<AllergyAbsenceAssertion | null> {
    return Promise.resolve(this.standing);
  }

  retractNoKnownAllergies(request: RetractNoKnownAllergies): Promise<boolean> {
    this.retractions.push(request);
    return Promise.resolve(this.retractAnswer);
  }
}

class FakeActiveReader implements ActiveAllergyReader {
  asked: string[] = [];
  rows: ActiveAllergy[] = [anActiveAllergy('allergy-1')];

  activeFor(chartId: string): Promise<readonly ActiveAllergy[]> {
    this.asked.push(chartId);
    return Promise.resolve(this.rows);
  }
}

describe('«sin alergias conocidas»', () => {
  let encounters: FakeEncounters;
  let absences: FakeAbsences;
  let reader: FakeActiveReader;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: NoKnownAllergiesService;

  beforeEach(() => {
    encounters = new FakeEncounters();
    absences = new FakeAbsences();
    reader = new FakeActiveReader();
    const entries: AccessAuditEntry[] = [];
    audit = {
      entries,
      record: (entry: AccessAuditEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
    } as unknown as PinoLogger;

    service = new NoKnownAllergiesService(
      absences as unknown as PatientAllergyRepository,
      reader,
      encounters as unknown as EncounterRepository,
      audit,
      logger,
    );
  });

  it('EN-087 afirma «sin alergias conocidas» con el autor de la SESIÓN, nunca con uno del cuerpo', async () => {
    // «Una afirmación positiva por parte de un usuario clínico, y no una
    // posición por defecto afirmada por un sistema informático».
    reader.rows = [];

    const assertion = await service.assertNoKnownAllergies(PATIENT, requester);

    expect(absences.absences).toEqual([
      { patientId: PATIENT, assertedById: USER },
    ]);
    expect(assertion.assertedByName).toBe('Ana Villacís');
  });

  it('EN-087 audita la afirmación como una creación: es contenido clínico sobre una persona', async () => {
    reader.rows = [];

    await service.assertNoKnownAllergies(PATIENT, requester);

    expect(audit.entries).toEqual([
      expect.objectContaining({
        userId: USER,
        resourceType: 'patient_allergy',
        action: 'CREATE',
      }),
    ]);
  });

  it('EN-087 rechaza «sin alergias conocidas» sobre una ficha que tiene alergias', async () => {
    // La pregunta se hace por el lector COMPARTIDO: la misma «¿a qué es
    // alérgica esta persona?» que comprueba una receta.
    await expect(
      service.assertNoKnownAllergies(PATIENT, requester),
    ).rejects.toBeInstanceOf(ChartHasAllergiesError);

    expect(reader.asked).toEqual([PATIENT]);
    expect(absences.absences).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('EN-087 rechaza afirmarlo sobre una ficha absorbida, igual que registrar una alergia', async () => {
    reader.rows = [];
    encounters.chart = { id: PATIENT, mergedIntoId: 'ficha-superviviente' };

    await expect(
      service.assertNoKnownAllergies(PATIENT, requester),
    ).rejects.toBeInstanceOf(PatientChartNotOpenError);
    await expect(
      service.assertRefuting(PATIENT, ['allergy-1'], requester),
    ).rejects.toBeInstanceOf(PatientChartNotOpenError);

    expect(absences.absences).toHaveLength(0);
    expect(absences.composite).toHaveLength(0);
  });

  it('EN-226 descarta las alergias nombradas y afirma en un paso, con quien está en la sesión', async () => {
    reader.rows = [anActiveAllergy('allergy-1'), anActiveAllergy('allergy-2')];

    await service.assertRefuting(
      PATIENT,
      ['allergy-2', 'allergy-1', 'allergy-1'],
      requester,
    );

    expect(absences.composite).toEqual([
      expect.objectContaining({
        patientId: PATIENT,
        allergyIds: ['allergy-2', 'allergy-1'],
        actorId: USER,
      }),
    ]);
    // Una entrada por alergia descartada y una por la afirmación.
    expect(audit.entries.map((e) => [e.resourceId, e.action])).toEqual([
      ['allergy-2', 'UPDATE'],
      ['allergy-1', 'UPDATE'],
      ['absence-1', 'CREATE'],
    ]);
  });

  it('EN-226 descarta con el motivo «Descartada al afirmar sin alergias conocidas» y audita sólo las que descartó de verdad', async () => {
    reader.rows = [anActiveAllergy('allergy-1'), anActiveAllergy('allergy-2')];
    // Un colega descartó allergy-1 a la vez: el paso se la salta.
    absences.refutedAnswer = ['allergy-2'];

    const result = await service.assertRefuting(
      PATIENT,
      ['allergy-1', 'allergy-2'],
      requester,
    );

    expect(BULK_REFUTATION_NOTE).toBe(
      'Descartada al afirmar sin alergias conocidas',
    );
    expect(absences.composite[0]?.notes).toBe(BULK_REFUTATION_NOTE);
    expect(result.refutedAllergyIds).toEqual(['allergy-2']);
    expect(audit.entries.map((e) => [e.resourceId, e.action])).toEqual([
      ['allergy-2', 'UPDATE'],
      ['absence-1', 'CREATE'],
    ]);
  });

  it('EN-226 una alergia de criticidad alta no entra en el descarte en bloque: se rechaza sin descartar ninguna (D-140.3)', async () => {
    reader.rows = [
      anActiveAllergy('allergy-1'),
      anActiveAllergy('anafilaxia', 'HIGH'),
    ];

    await expect(
      service.assertRefuting(PATIENT, ['allergy-1', 'anafilaxia'], requester),
    ).rejects.toBeInstanceOf(AllergyRefutedAloneError);
    expect(absences.composite).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);

    // Control positivo: sin la de criticidad alta en la ficha, el paso entra.
    reader.rows = [anActiveAllergy('allergy-1')];
    await service.assertRefuting(PATIENT, ['allergy-1'], requester);
    expect(absences.composite).toHaveLength(1);
  });

  it('EN-226 el freno sigue: una alergia activa que no se nombró no se descarta y no se afirma nada', async () => {
    // La de un colega registrada hace un momento no estaba en la pantalla.
    reader.rows = [anActiveAllergy('allergy-1'), anActiveAllergy('nueva')];

    await expect(
      service.assertRefuting(PATIENT, ['allergy-1'], requester),
    ).rejects.toBeInstanceOf(ChartHasAllergiesError);

    expect(absences.composite).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('EN-226 retira la afirmación vigente con quien está en la sesión', async () => {
    await service.retract(PATIENT, requester);

    expect(absences.retractions).toEqual([
      expect.objectContaining({
        assertionId: 'absence-1',
        patientId: PATIENT,
        retractedById: USER,
      }),
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({ resourceId: 'absence-1', action: 'UPDATE' }),
    ]);
  });

  it('EN-226 sin afirmación vigente, o si otro la retiró a la vez, responde que no hay nada que retirar', async () => {
    absences.standing = null;
    await expect(service.retract(PATIENT, requester)).rejects.toBeInstanceOf(
      NoKnownAllergiesNotStandingError,
    );

    absences.standing = anAssertion();
    absences.retractAnswer = false;
    await expect(service.retract(PATIENT, requester)).rejects.toBeInstanceOf(
      NoKnownAllergiesNotStandingError,
    );
    expect(audit.entries).toHaveLength(0);
  });
});
