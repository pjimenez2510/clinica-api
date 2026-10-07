import { describe, expect, it, vi } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import type { ReferenceRange } from '../domain/analyte';
import {
  AnalyteUnitWithRangesError,
  ExamCodeInUseError,
} from '../domain/orders.errors';
import type {
  AdminAnalyteView,
  AdminExamView,
  ExamAdministrationRepository,
} from '../domain/exam-administration.repository';

import { ExamAdministrationService } from './exam-administration.service';

/**
 * ORD-142, against a double of the port: what the SERVICE hands to the trail.
 * Whether the base accepts a payload on `exam_definition` and
 * `analyte_definition` is the CHECK's business, and is exercised against a
 * real PostgreSQL in `test/integration/admin-edit-in-place.spec.ts`.
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
  usedBy: [{ id: 'exam-1', code: 'EX-GLU', name: 'Glucosa en ayunas' }],
};

const EXAM: AdminExamView = {
  id: 'exam-1',
  code: 'EX-GLU',
  name: 'Glucosa en ayunas',
  category: 'LABORATORY',
  form010Section: 'QUIMICA SANGUINEA',
  specimenType: 'Suero',
  patientPreparation: null,
  turnaroundHours: 24,
  requiresFasting: true,
  fastingHours: 8,
  tariffCode: null,
  performedExternally: false,
  externalLabName: null,
  externalLabCode: null,
  billableService: null,
  active: true,
  analytes: [{ analyte: ANALYTE, position: 1, isReflex: false }],
};

function build(overrides: Partial<Record<string, unknown>> = {}) {
  const recorded: AccessAuditEntry[] = [];
  const repository = {
    exam: vi.fn().mockResolvedValue(EXAM),
    analyte: vi.fn().mockResolvedValue(ANALYTE),
    createExam: vi.fn().mockResolvedValue(EXAM),
    updateExam: vi.fn().mockResolvedValue(EXAM),
    setStructure: vi.fn().mockResolvedValue(EXAM),
    pendingLines: vi.fn().mockResolvedValue(0),
    analyteHasResults: vi.fn().mockResolvedValue(false),
    examWasOrdered: vi.fn().mockResolvedValue(false),
    updateAnalyte: vi.fn().mockResolvedValue(ANALYTE),
    setRanges: vi.fn().mockResolvedValue(ANALYTE),
    service: vi.fn().mockResolvedValue(undefined),
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

describe('ExamAdministrationService · bitácora con antes y después (ORD-142)', () => {
  it('ORD-142 records the exam before and after an edit', async () => {
    const { service, recorded } = build({
      updateExam: vi
        .fn()
        .mockResolvedValue({ ...EXAM, turnaroundHours: 48, fastingHours: 12 }),
    });

    await service.updateExam(
      EXAM.id,
      { turnaroundHours: 48, fastingHours: 12 },
      EDITOR,
    );

    expect(recorded[0]).toMatchObject({
      resourceType: 'exam_definition',
      resourceId: EXAM.id,
      action: 'UPDATE',
      before: { code: 'EX-GLU', turnaroundHours: 24, fastingHours: 8 },
      after: { code: 'EX-GLU', turnaroundHours: 48, fastingHours: 12 },
    });
    // The analytes are the structure's, audited by `setStructure`.
    expect(recorded[0]?.before).not.toHaveProperty('analytes');
  });

  it('ORD-142 records the structure an exam had and the one it was given', async () => {
    const POTASSIUM = { ...ANALYTE, id: 'analyte-k', code: 'K' };
    const { service, recorded } = build({
      setStructure: vi.fn().mockResolvedValue({
        ...EXAM,
        analytes: [
          { analyte: ANALYTE, position: 1, isReflex: false },
          { analyte: POTASSIUM, position: 2, isReflex: true },
        ],
      }),
    });

    await service.setStructure(
      EXAM.id,
      [
        { analyteDefinitionId: ANALYTE.id, isReflex: false },
        { analyteDefinitionId: POTASSIUM.id, isReflex: true },
      ],
      EDITOR,
    );

    expect(recorded[0]?.before).toEqual({
      analytes: [{ analyteDefinitionId: ANALYTE.id, isReflex: false }],
    });
    expect(recorded[0]?.after).toEqual({
      analytes: [
        { analyteDefinitionId: ANALYTE.id, isReflex: false },
        { analyteDefinitionId: POTASSIUM.id, isReflex: true },
      ],
    });
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

  it('ORD-142 a new exam carries only the after half', async () => {
    const { service, recorded } = build();

    await service.createExam(
      'EX-GLU',
      {
        name: EXAM.name,
        category: 'LABORATORY',
        form010Section: null,
        specimenType: null,
        patientPreparation: null,
        turnaroundHours: null,
        requiresFasting: false,
        fastingHours: null,
        performedExternally: false,
        externalLabName: null,
        externalLabCode: null,
        tariffCode: null,
        billableServiceId: null,
        active: true,
      },
      EDITOR,
    );

    expect(recorded[0]).toMatchObject({ action: 'CREATE' });
    expect(recorded[0]?.before).toBeUndefined();
    expect(recorded[0]?.after).toMatchObject({ code: 'EX-GLU' });
  });
});

describe('ExamAdministrationService · corregir en el sitio (ORD-140, ORD-141)', () => {
  it('ORD-140 corrige el código de un examen que ninguna orden pidió', async () => {
    const updateExam = vi
      .fn()
      .mockResolvedValue({ ...EXAM, code: 'EX-GLU-AY' });
    const { service } = build({
      examWasOrdered: vi.fn().mockResolvedValue(false),
      updateExam,
    });

    await service.updateExam('exam-1', { code: 'EX-GLU-AY' }, EDITOR);

    expect(updateExam).toHaveBeenCalledWith('exam-1', { code: 'EX-GLU-AY' });
  });

  it('ORD-140 el código de un examen ya pedido no cambia: EXAM_CODE_IN_USE, sin escribir', async () => {
    const updateExam = vi.fn();
    const { service } = build({
      examWasOrdered: vi.fn().mockResolvedValue(true),
      updateExam,
    });

    await expect(
      service.updateExam('exam-1', { code: 'EX-GLU-AY' }, EDITOR),
    ).rejects.toBeInstanceOf(ExamCodeInUseError);
    expect(updateExam).not.toHaveBeenCalled();
  });

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

  it('ORD-141 sin rangos en la petición, cambiar la unidad de un analito con rangos sigue rechazándose', async () => {
    const { service } = build();

    await expect(
      service.updateAnalyte('analyte-glu', { unit: 'mmol/L' }, EDITOR),
    ).rejects.toBeInstanceOf(AnalyteUnitWithRangesError);
  });
});
