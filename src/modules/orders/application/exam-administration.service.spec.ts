import { describe, expect, it, vi } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import type { ReferenceRange } from '../domain/analyte';
import {
  AnalyteUnitWithRangesError,
  ExamDefinitionNotFoundError,
  ExamHasOpenOrdersError,
} from '../domain/orders.errors';
import type {
  AdminAnalyteView,
  AdminExamView,
  ExamAdministrationRepository,
} from '../domain/exam-administration.repository';

import { ExamAdministrationService } from './exam-administration.service';

/**
 * ORD-105, ORD-142, against a double of the port: what the SERVICE hands to
 * the trail. Whether the base accepts a payload on `service_exam` and
 * `analyte_definition` is the CHECK's business, and is exercised against a
 * real PostgreSQL in `test/integration/admin-edit-in-place.spec.ts`.
 *
 * The exam's own fields are the service's since ADR-013, written by billing
 * (BI-280, BI-284): what is left here is its structure and its analytes.
 */
const EDITOR = { userId: 'user-1', ip: '10.0.0.1' };

const RANGE: ReferenceRange = {
  rangeKind: 'REFERENCE',
  sex: null,
  ageMinDays: null,
  ageMaxDays: null,
  low: 70,
  high: 100,
  text: null,
};

const ANALYTE: AdminAnalyteView = {
  id: 'analyte-glu',
  code: 'GLU',
  name: 'Glucosa',
  unit: 'mg/dL',
  valueType: 'NUMERIC',
  decimals: 0,
  allowedValues: null,
  ranges: [RANGE],
  loincCode: null,
  active: true,
  usedBy: [{ id: 'service-glu', code: 'LAB-GLU', name: 'Glucosa en ayunas' }],
};

const EXAM: AdminExamView = {
  id: 'service-glu',
  code: 'LAB-GLU',
  name: 'Glucosa en ayunas',
  category: 'LABORATORY',
  form010Section: 'QUIMICA SANGUINEA',
  specimenType: 'Suero',
  patientPreparation: null,
  turnaroundHours: 24,
  requiresFasting: true,
  fastingHours: 8,
  mspCode: null,
  performedExternally: false,
  externalLabName: null,
  externalLabCode: null,
  active: true,
  analytes: [{ analyte: ANALYTE, position: 1, isReflex: false }],
};

function build(overrides: Partial<Record<string, unknown>> = {}) {
  const recorded: AccessAuditEntry[] = [];
  const repository = {
    exam: vi.fn().mockResolvedValue(EXAM),
    analyte: vi.fn().mockResolvedValue(ANALYTE),
    setStructure: vi.fn().mockResolvedValue(EXAM),
    pendingLines: vi.fn().mockResolvedValue(0),
    analyteHasResults: vi.fn().mockResolvedValue(false),
    updateAnalyte: vi.fn().mockResolvedValue(ANALYTE),
    setRanges: vi.fn().mockResolvedValue(ANALYTE),
    ...overrides,
  };
  const service = new ExamAdministrationService(
    repository as unknown as ExamAdministrationRepository,
    {
      record: (entry) => {
        recorded.push(entry);
        return Promise.resolve();
      },
    },
  );
  return { service, recorded };
}

const POTASSIUM = { ...ANALYTE, id: 'analyte-k', code: 'K' };
const WITH_POTASSIUM = [
  { analyteDefinitionId: ANALYTE.id, isReflex: false },
  { analyteDefinitionId: POTASSIUM.id, isReflex: true },
];

describe('ExamAdministrationService · la estructura vive en el servicio (ORD-105)', () => {
  it('ORD-105 fija la estructura sobre el servicio con extensión de orden', async () => {
    const setStructure = vi.fn().mockResolvedValue(EXAM);
    const { service } = build({ setStructure });

    await service.setStructure(EXAM.id, WITH_POTASSIUM, EDITOR);

    expect(setStructure).toHaveBeenCalledWith(EXAM.id, WITH_POTASSIUM);
  });

  it('ORD-105 un servicio sin extensión de orden se rechaza con EXAM_DEFINITION_NOT_FOUND, sin escribir', async () => {
    const setStructure = vi.fn();
    const { service, recorded } = build({
      exam: vi.fn().mockResolvedValue(undefined),
      setStructure,
    });

    await expect(
      service.setStructure('service-consulta', WITH_POTASSIUM, EDITOR),
    ).rejects.toBeInstanceOf(ExamDefinitionNotFoundError);
    expect(setStructure).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('ORD-110 cambiar las determinaciones con líneas esperando resultado se rechaza', async () => {
    const setStructure = vi.fn();
    const { service } = build({
      pendingLines: vi.fn().mockResolvedValue(2),
      setStructure,
    });

    await expect(
      service.setStructure(EXAM.id, WITH_POTASSIUM, EDITOR),
    ).rejects.toBeInstanceOf(ExamHasOpenOrdersError);
    expect(setStructure).not.toHaveBeenCalled();
  });
});

describe('ExamAdministrationService · bitácora con antes y después (ORD-142)', () => {
  it('ORD-142 records the structure a service had and the one it was given, as service_exam', async () => {
    const { service, recorded } = build({
      setStructure: vi.fn().mockResolvedValue({
        ...EXAM,
        analytes: [
          { analyte: ANALYTE, position: 1, isReflex: false },
          { analyte: POTASSIUM, position: 2, isReflex: true },
        ],
      }),
    });

    await service.setStructure(EXAM.id, WITH_POTASSIUM, EDITOR);

    expect(recorded[0]).toMatchObject({
      resourceType: 'service_exam',
      resourceId: EXAM.id,
      action: 'UPDATE',
    });
    expect(recorded[0]?.before).toEqual({
      analytes: [{ analyteDefinitionId: ANALYTE.id, isReflex: false }],
    });
    expect(recorded[0]?.after).toEqual({ analytes: WITH_POTASSIUM });
  });

  it('ORD-142 records the analyte before and after an edit, without its usage', async () => {
    const { service, recorded } = build({
      updateAnalyte: vi
        .fn()
        .mockResolvedValue({ ...ANALYTE, loincCode: '2345-7' }),
    });

    await service.updateAnalyte(ANALYTE.id, { loincCode: '2345-7' }, EDITOR);

    expect(recorded[0]).toMatchObject({
      resourceType: 'analyte_definition',
      resourceId: ANALYTE.id,
      action: 'UPDATE',
    });
    expect(recorded[0]?.before).toEqual({
      code: 'GLU',
      name: 'Glucosa',
      valueType: 'NUMERIC',
      unit: 'mg/dL',
      decimals: 0,
      allowedValues: null,
      loincCode: null,
      active: true,
    });
    expect(recorded[0]?.after).toMatchObject({ loincCode: '2345-7' });
  });

  it('ORD-142 records the ranges an analyte had and the ones it was given', async () => {
    const moved: ReferenceRange = { ...RANGE, high: 110 };
    const { service, recorded } = build({
      setRanges: vi.fn().mockResolvedValue({ ...ANALYTE, ranges: [moved] }),
    });

    await service.setRanges(ANALYTE.id, [moved], EDITOR);

    expect(recorded[0]?.before).toEqual({ ranges: [RANGE] });
    expect(recorded[0]?.after).toEqual({ ranges: [moved] });
  });
});

describe('ExamAdministrationService · corregir en el sitio (ORD-141)', () => {
  it('ORD-141 la unidad y sus rangos nuevos van juntos, en una sola escritura', async () => {
    const mmol: ReferenceRange = { ...RANGE, low: 3.9, high: 5.6 };
    const setRanges = vi
      .fn()
      .mockResolvedValue({ ...ANALYTE, unit: 'mmol/L', ranges: [mmol] });
    const updateAnalyte = vi.fn();
    const { service } = build({ setRanges, updateAnalyte });

    const updated = await service.updateAnalyte(
      'analyte-glu',
      { unit: 'mmol/L', decimals: 1 },
      EDITOR,
      [mmol],
    );

    expect(updated.unit).toBe('mmol/L');
    expect(updateAnalyte).not.toHaveBeenCalled();
    expect(setRanges).toHaveBeenCalledWith(
      'analyte-glu',
      [mmol],
      expect.any(Date),
      expect.objectContaining({ unit: 'mmol/L', decimals: 1 }),
    );
  });

  it('ORD-141 rangos con los mismos límites de la unidad anterior se rechazan: el crítico se apagaría', async () => {
    const setRanges = vi.fn();
    const { service } = build({ setRanges });

    await expect(
      service.updateAnalyte('analyte-glu', { unit: 'mmol/L' }, EDITOR, [RANGE]),
    ).rejects.toBeInstanceOf(AnalyteUnitWithRangesError);
    expect(setRanges).not.toHaveBeenCalled();
  });

  it('ORD-141 sin rangos en la petición, cambiar la unidad de un analito con rangos sigue rechazándose', async () => {
    const { service } = build();

    await expect(
      service.updateAnalyte('analyte-glu', { unit: 'mmol/L' }, EDITOR),
    ).rejects.toBeInstanceOf(AnalyteUnitWithRangesError);
  });
});
