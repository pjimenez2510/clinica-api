import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type { EncounterRepository } from '../domain/encounter.repository';
import {
  PatientChartNotOpenError,
  PatientHistoryNotFoundError,
  RefutationReasonRequiredError,
} from '../domain/encounter.errors';
import type {
  HistoryView,
  NewHistory,
  PatientHistoryRepository,
  RefuteHistory,
} from '../domain/patient-history.repository';

import type { Requester } from './encounter.service';
import { PatientHistoryService } from './patient-history.service';

const PATIENT = 'patient-1';
const USER = 'user-nurse';

const requester: Requester = {
  userId: USER,
  sites: 'all',
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anEntry = (overrides: Partial<HistoryView> = {}): HistoryView => ({
  id: 'history-1',
  patientId: PATIENT,
  kind: 'FAMILY',
  description: 'Diabetes tipo 2',
  relative: 'Madre',
  recordedAt: new Date(0),
  recordedBy: { id: USER, name: 'Carmen Salazar' },
  refutedAt: null,
  refutedNotes: null,
  refutedBy: null,
  ...overrides,
});

class FakeHistory implements PatientHistoryRepository {
  written: NewHistory[] = [];
  refutations: RefuteHistory[] = [];
  refuteAnswer: HistoryView | null = anEntry({ refutedAt: new Date(0) });

  record(entry: NewHistory): Promise<HistoryView> {
    this.written.push(entry);
    return Promise.resolve(anEntry({ kind: entry.kind }));
  }

  refute(refutation: RefuteHistory): Promise<HistoryView | null> {
    this.refutations.push(refutation);
    return Promise.resolve(this.refuteAnswer);
  }

  listFor(): Promise<HistoryView[]> {
    return Promise.resolve([anEntry()]);
  }

  activeFor(): Promise<HistoryView[]> {
    return Promise.resolve([anEntry()]);
  }
}

describe('los antecedentes del paciente', () => {
  let history: FakeHistory;
  let chart: { id: string; mergedIntoId: string | null } | null;
  let entries: AccessAuditEntry[];
  let service: PatientHistoryService;

  beforeEach(() => {
    history = new FakeHistory();
    chart = { id: PATIENT, mergedIntoId: null };
    entries = [];
    const audit: AccessAuditRecorder = {
      record: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
    const encounters = {
      findPatientChart: () => Promise.resolve(chart),
    } as unknown as EncounterRepository;
    const logger = {
      setContext: () => undefined,
      info: () => undefined,
    } as unknown as PinoLogger;

    service = new PatientHistoryService(history, encounters, audit, logger);
  });

  it('EN-085 registra el antecedente con el autor de la sesion, nunca del cuerpo', async () => {
    await service.record(
      {
        patientId: PATIENT,
        kind: 'FAMILY',
        description: 'Diabetes tipo 2',
        relative: 'Madre',
      },
      requester,
    );

    expect(history.written).toEqual([
      expect.objectContaining({ recordedById: USER, relative: 'Madre' }),
    ]);
    expect(entries).toEqual([
      expect.objectContaining({
        resourceType: 'patient_history',
        action: 'CREATE',
      }),
    ]);
  });

  it('EN-085 no registra sobre una ficha absorbida: lo nuevo va a la superviviente', async () => {
    chart = { id: PATIENT, mergedIntoId: 'patient-2' };

    await expect(
      service.record(
        { patientId: PATIENT, kind: 'PERSONAL', description: 'Asma' },
        requester,
      ),
    ).rejects.toBeInstanceOf(PatientChartNotOpenError);
    expect(history.written).toEqual([]);
  });

  it('EN-085 exige el motivo al descartar, y lo dice del antecedente y no de una alergia', async () => {
    const refusal = await service
      .refute(
        { patientId: PATIENT, historyId: 'history-1', notes: '   ' },
        requester,
      )
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RefutationReasonRequiredError);
    expect((refusal as RefutationReasonRequiredError).userTitle).toContain(
      'el antecedente',
    );
    expect(history.refutations).toEqual([]);
  });

  it('EN-085 responde el mismo 404 para el antecedente que no esta en la ficha', async () => {
    history.refuteAnswer = null;

    await expect(
      service.refute(
        { patientId: PATIENT, historyId: 'ajeno', notes: 'Error de registro' },
        requester,
      ),
    ).rejects.toBeInstanceOf(PatientHistoryNotFoundError);
  });

  it('EN-085 descarta con quien esta en la sesion como autor de la refutacion', async () => {
    await service.refute(
      {
        patientId: PATIENT,
        historyId: 'history-1',
        notes: 'Error de registro',
      },
      requester,
    );

    expect(history.refutations[0]).toMatchObject({ refutedById: USER });
  });
});
