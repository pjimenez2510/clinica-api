import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type { EncounterRepository } from '../domain/encounter.repository';
import { PatientChartNotOpenError } from '../domain/encounter.errors';
import type {
  VitalsHistoryQuery,
  VitalsHistoryRepository,
  VitalsTaking,
} from '../domain/vitals-history.repository';

import type { Requester } from './encounter.service';
import {
  VITALS_HISTORY_LIMIT,
  VitalsHistoryService,
} from './vitals-history.service';

const requester: Requester = {
  userId: 'user-doctor',
  sites: ['site-north'],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const aTaking = (): VitalsTaking => ({
  encounterId: 'encounter-1',
  siteId: 'site-north',
  measuredAt: new Date(0),
  ageYears: 40,
  ageMonths: 2,
  ageDays: 3,
  weightKg: 72.5,
  heightCm: 170,
  heightPosition: 'STANDING',
  headCircumferenceCm: null,
  abdominalCircumferenceCm: null,
  bmi: 25.09,
  systolicBp: 128,
  diastolicBp: 82,
  heartRate: 70,
  respiratoryRate: 16,
  temperatureC: 36.6,
  oxygenSaturation: 98,
  hemoglobinGDl: null,
  hemoglobinCorrectedGDl: null,
});

class FakeTakings implements VitalsHistoryRepository {
  queries: VitalsHistoryQuery[] = [];
  counted: Omit<VitalsHistoryQuery, 'limit'>[] = [];

  takings(query: VitalsHistoryQuery): Promise<VitalsTaking[]> {
    this.queries.push(query);
    return Promise.resolve([aTaking()]);
  }

  countTakings(query: Omit<VitalsHistoryQuery, 'limit'>): Promise<number> {
    this.counted.push(query);
    return Promise.resolve(130);
  }

  bloodPressureReference(): Promise<{ systolic: number; diastolic: number }> {
    return Promise.resolve({ systolic: 140, diastolic: 90 });
  }
}

describe('la evolución de los signos de una ficha', () => {
  let takings: FakeTakings;
  let audited: AccessAuditEntry[];
  let chart: { id: string; mergedIntoId: string | null } | null;
  let service: VitalsHistoryService;

  beforeEach(() => {
    takings = new FakeTakings();
    audited = [];
    chart = { id: 'patient-1', mergedIntoId: null };
    const encounters = {
      findPatientChart: () => Promise.resolve(chart),
    } as unknown as EncounterRepository;
    const audit: AccessAuditRecorder = {
      record: (entry) => {
        audited.push(entry);
        return Promise.resolve();
      },
    };
    service = new VitalsHistoryService(takings, encounters, audit);
  });

  it('EN-269 lee la ficha dentro de las sedes de quien llama, acotada a 100, con el total y la línea de la TA', async () => {
    const history = await service.forChart('patient-1', requester);

    expect(takings.queries).toEqual([
      { patientId: 'patient-1', sites: ['site-north'], limit: 100 },
    ]);
    expect(VITALS_HISTORY_LIMIT).toBe(100);
    // La cuenta responde a la MISMA pregunta que la lista, sin el límite.
    expect(takings.counted).toEqual([
      { patientId: 'patient-1', sites: ['site-north'] },
    ]);
    expect(history).toMatchObject({
      patientId: 'patient-1',
      total: 130,
      bloodPressureReference: { systolic: 140, diastolic: 90 },
    });
    expect(history.items).toHaveLength(1);
  });

  it('EN-271 deja UNA entrada de bitácora sobre la ficha, no una por toma', async () => {
    await service.forChart('patient-1', requester);

    expect(audited).toEqual([
      {
        userId: 'user-doctor',
        resourceType: 'patient_vitals_history',
        resourceId: 'patient-1',
        action: 'READ',
        ip: '10.0.0.9',
        userAgent: 'vitest',
      },
    ]);
  });

  it('EN-271 una ficha absorbida o inexistente responde PATIENT_CHART_NOT_OPEN sin leer ni dejar bitácora', async () => {
    for (const closed of [
      { id: 'patient-1', mergedIntoId: 'patient-2' },
      null,
    ]) {
      chart = closed;
      await expect(service.forChart('patient-1', requester)).rejects.toThrow(
        PatientChartNotOpenError,
      );
    }
    expect(takings.queries).toEqual([]);
    expect(audited).toEqual([]);
  });
});
