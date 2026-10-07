import { describe, expect, it, vi } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import { answerProposal, EXPORT_OMISSIONS } from '../domain/data-export';
import { legalDueDate } from '../domain/legal-due-date';
import {
  ConsentTextInvalidError,
  ConsentTextNotPublishedError,
  ConsentTextOutdatedError,
  DataExportNotApplicableError,
  DataRequestAlreadyAnsweredError,
  DataRequestNotFoundError,
  DataRequestReceivedInFutureError,
  DataSubjectNotFoundError,
} from '../domain/privacy.errors';
import type {
  ConsentRepository,
  DataRequestView,
  DataSubjectRequestRepository,
  NewDataRequest,
  Requester,
} from '../domain/privacy.repository';

import { ConsentService } from './consent.service';
import { DataSubjectRequestsService } from './data-subject-requests.service';

const WHO: Requester = { userId: 'u-1' };
const NOW = new Date();
const TODAY = clinicalDateOf(NOW);

function consentRepository(
  overrides: Partial<ConsentRepository> = {},
): ConsentRepository {
  return {
    chartOf: vi.fn().mockResolvedValue({ status: 'active' }),
    currentText: vi.fn().mockResolvedValue(null),
    texts: vi.fn().mockResolvedValue([]),
    currentVersionConsents: vi.fn().mockResolvedValue(0),
    correct: vi.fn(),
    publish: vi.fn(),
    record: vi.fn(),
    consentsOf: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function requestView(
  overrides: Partial<DataRequestView> = {},
): DataRequestView {
  return {
    id: 'r-1',
    patientId: 'p-1',
    patient: { mrn: 'HC0000000001', fullName: 'Guamán María' },
    right: 'ACCESS',
    requestedBy: 'HOLDER',
    description: 'Copia',
    receivedAt: NOW,
    dueOn: TODAY,
    registeredAt: NOW,
    registeredBy: { id: 'u-1', fullName: 'Gabriela Mera' },
    answer: null,
    previousAnswers: [],
    changedBy: null,
    changedAt: null,
    ...overrides,
  };
}

function requestRepository(
  overrides: Partial<DataSubjectRequestRepository> = {},
): DataSubjectRequestRepository {
  return {
    chartOf: vi.fn().mockResolvedValue({ status: 'active' }),
    clinicWideHolidays: vi.fn().mockResolvedValue(new Set()),
    register: vi.fn((request: NewDataRequest) =>
      Promise.resolve(
        requestView({ right: request.right, dueOn: request.dueOn }),
      ),
    ),
    answer: vi.fn(),
    edit: vi.fn(),
    correctAnswer: vi.fn(),
    find: vi.fn().mockResolvedValue(null),
    rightOf: vi.fn().mockResolvedValue(null),
    requestsOf: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue([]),
    exportChart: vi.fn(),
    ...overrides,
  };
}

describe('ConsentService', () => {
  it('PD-004 rechaza un texto en blanco o de más de 20 000 caracteres sin llegar al repositorio', async () => {
    const publish = vi.fn();
    const service = new ConsentService(consentRepository({ publish }));

    for (const body of [' \n ', 'x'.repeat(20_001)]) {
      await expect(service.publish(body, WHO)).rejects.toBeInstanceOf(
        ConsentTextInvalidError,
      );
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('PD-001 sin texto publicado, no hay vigente y eso no es un error', async () => {
    const service = new ConsentService(consentRepository());
    await expect(service.currentText()).resolves.toBeNull();
  });

  it('PD-012 consentir una versión que no existe es CONSENT_TEXT_NOT_PUBLISHED', async () => {
    const service = new ConsentService(
      consentRepository({
        record: vi.fn().mockResolvedValue({ status: 'unknown-version' }),
      }),
    );
    await expect(
      service.record(
        {
          patientId: 'p-1',
          textVersionId: 't-1',
          medium: 'ON_SCREEN',
          grantedBy: 'HOLDER',
        },
        WHO,
      ),
    ).rejects.toBeInstanceOf(ConsentTextNotPublishedError);
  });

  it('PD-012 una versión desfasada se rechaza nombrando la vigente', async () => {
    const service = new ConsentService(
      consentRepository({
        record: vi
          .fn()
          .mockResolvedValue({ status: 'outdated', currentVersion: 3 }),
      }),
    );
    const attempt = service.record(
      {
        patientId: 'p-1',
        textVersionId: 't-1',
        medium: 'ON_SCREEN',
        grantedBy: 'HOLDER',
      },
      WHO,
    );
    await expect(attempt).rejects.toBeInstanceOf(ConsentTextOutdatedError);
    await expect(attempt).rejects.toMatchObject({ currentVersion: 3 });
  });

  it('PD-015 no escribe sobre una ficha inexistente ni sobre una absorbida', async () => {
    const consent = {
      patientId: 'p-1',
      textVersionId: 't-1',
      medium: 'ON_SCREEN' as const,
      grantedBy: 'HOLDER' as const,
    };
    const recordOnMissing = vi.fn();
    const missing = consentRepository({
      chartOf: vi.fn().mockResolvedValue({ status: 'missing' }),
      record: recordOnMissing,
    });
    await expect(
      new ConsentService(missing).record(consent, WHO),
    ).rejects.toBeInstanceOf(DataSubjectNotFoundError);

    const recordOnMerged = vi.fn();
    const merged = consentRepository({
      chartOf: vi
        .fn()
        .mockResolvedValue({ status: 'merged', survivingMrn: 'HC0000000002' }),
      record: recordOnMerged,
    });
    await expect(
      new ConsentService(merged).record(consent, WHO),
    ).rejects.toBeInstanceOf(PatientMergedError);
    expect(recordOnMissing).not.toHaveBeenCalled();
    expect(recordOnMerged).not.toHaveBeenCalled();
  });
});

const record = vi.fn().mockResolvedValue(undefined);
function newRequestsService(repository: DataSubjectRequestRepository) {
  return new DataSubjectRequestsService(repository, { record });
}

describe('DataSubjectRequestsService', () => {
  it('PD-031 una recepción posterior a ahora se rechaza antes de tocar nada', async () => {
    const register = vi.fn();
    const service = newRequestsService(requestRepository({ register }));
    await expect(
      service.register(
        {
          patientId: 'p-1',
          right: 'ACCESS',
          requestedBy: 'HOLDER',
          description: 'Copia',
          receivedAt: new Date(NOW.getTime() + 60_000),
        },
        WHO,
        NOW,
      ),
    ).rejects.toBeInstanceOf(DataRequestReceivedInFutureError);
    expect(register).not.toHaveBeenCalled();
  });

  it('PD-032 fija el vencimiento con los feriados de toda la clínica que el repositorio da', async () => {
    const holiday = addDays(TODAY, 1);
    const repository = requestRepository({
      clinicWideHolidays: vi.fn().mockResolvedValue(new Set([holiday])),
    });
    const service = newRequestsService(repository);

    const created = await service.register(
      {
        patientId: 'p-1',
        right: 'PORTABILITY',
        requestedBy: 'HOLDER',
        description: 'Copia',
      },
      WHO,
      NOW,
    );

    expect(created.dueOn).toBe(
      legalDueDate('PORTABILITY', TODAY, new Set([holiday])),
    );
  });

  it('PD-033 traduce una respuesta repetida y una solicitud inexistente', async () => {
    const already = newRequestsService(
      requestRepository({
        answer: vi.fn().mockResolvedValue({ status: 'already-answered' }),
      }),
    );
    await expect(
      already.answer('r-1', { outcome: 'GRANTED', response: 'x' }, WHO),
    ).rejects.toBeInstanceOf(DataRequestAlreadyAnsweredError);

    const missing = newRequestsService(
      requestRepository({
        answer: vi.fn().mockResolvedValue({ status: 'missing' }),
      }),
    );
    await expect(
      missing.answer('r-1', { outcome: 'GRANTED', response: 'x' }, WHO),
    ).rejects.toBeInstanceOf(DataRequestNotFoundError);
  });

  it('PD-035 marca vencida la abierta cuyo vencimiento es anterior a hoy, y nunca la respondida', async () => {
    const yesterday: ClinicalDate = addDays(TODAY, -1);
    const service = newRequestsService(
      requestRepository({
        open: vi
          .fn()
          .mockResolvedValue([
            requestView({ id: 'late', dueOn: yesterday }),
            requestView({ id: 'today', dueOn: TODAY }),
          ]),
        requestsOf: vi.fn().mockResolvedValue([
          requestView({
            id: 'answered-late',
            dueOn: yesterday,
            answer: {
              outcome: 'GRANTED',
              response: 'x',
              answeredAt: NOW,
              answeredBy: { id: 'u-1', fullName: 'Gabriela Mera' },
              isCorrection: false,
            },
          }),
        ]),
      }),
    );

    expect((await service.open(NOW)).map((r) => [r.id, r.isOverdue])).toEqual([
      ['late', true],
      ['today', false],
    ]);
    expect((await service.requestsOf('p-1', WHO, NOW))[0]!.isOverdue).toBe(
      false,
    );
    // REQ-110: reading what the patient asked is a READ of the chart.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'READ',
        resourceType: 'patient_data_requests',
        resourceId: 'p-1',
      }),
    );
  });

  it('PD-042 solo acceso y portabilidad se exportan; PD-041 con las omisiones declaradas', async () => {
    const exportChart = vi.fn().mockResolvedValue({});
    const find = vi
      .fn()
      .mockResolvedValueOnce(requestView({ right: 'ERASURE' }))
      .mockResolvedValueOnce(requestView({ right: 'PORTABILITY' }))
      .mockResolvedValueOnce(null);
    const service = newRequestsService(
      requestRepository({ find, exportChart }),
    );

    await expect(service.export('r-1', WHO, NOW)).rejects.toBeInstanceOf(
      DataExportNotApplicableError,
    );
    expect(exportChart).not.toHaveBeenCalled();

    await service.export('r-1', WHO, NOW);
    expect(exportChart).toHaveBeenCalledWith(
      'r-1',
      'p-1',
      EXPORT_OMISSIONS,
      WHO,
      NOW,
    );

    await expect(service.export('r-1', WHO, NOW)).rejects.toBeInstanceOf(
      DataRequestNotFoundError,
    );
  });
});

describe('la propuesta de respuesta (D-164.2)', () => {
  it.each(['ACCESS', 'PORTABILITY'] as const)(
    'PD-049 a %s le propone lo que el archivo no lleva, sin escribir nada',
    async (right) => {
      const answer = vi.fn();
      const exportChart = vi.fn();
      const find = vi.fn();
      const rightOf = vi.fn().mockResolvedValue(right);
      const audit = { record: vi.fn() };
      const service = new DataSubjectRequestsService(
        requestRepository({ rightOf, find, answer, exportChart }),
        audit,
      );

      await expect(service.answerProposal('r-1')).resolves.toBe(
        answerProposal(EXPORT_OMISSIONS),
      );
      // Only the right is read: not the request's view, with what was asked.
      expect(find).not.toHaveBeenCalled();
      expect(answer).not.toHaveBeenCalled();
      expect(exportChart).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('PD-049 otro derecho es DATA_EXPORT_NOT_APPLICABLE', async () => {
    const service = newRequestsService(
      requestRepository({
        rightOf: vi.fn().mockResolvedValue('RECTIFICATION'),
      }),
    );
    await expect(service.answerProposal('r-1')).rejects.toBeInstanceOf(
      DataExportNotApplicableError,
    );
  });

  it('PD-049 una solicitud inexistente es DATA_REQUEST_NOT_FOUND', async () => {
    const service = newRequestsService(requestRepository());
    await expect(service.answerProposal('r-1')).rejects.toBeInstanceOf(
      DataRequestNotFoundError,
    );
  });
});

describe('corregir en privacidad (D-127)', () => {
  const answered = {
    outcome: 'GRANTED' as const,
    response: 'Entregada',
    answeredAt: NOW,
    answeredBy: { id: 'u-1', fullName: 'Gabriela Mera' },
    isCorrection: false,
  };

  it('PD-044 traduce «no existe» y «ya corregido» a sus códigos', async () => {
    for (const [status, code] of [
      ['missing', 'CONSENT_NOT_FOUND'],
      ['already-corrected', 'CONSENT_ALREADY_CORRECTED'],
    ] as const) {
      const service = new ConsentService(
        consentRepository({ correct: vi.fn().mockResolvedValue({ status }) }),
      );
      await expect(
        service.correct(
          {
            patientId: 'p-1',
            consentId: 'c-1',
            medium: 'SIGNED_PAPER',
            grantedBy: 'HOLDER',
          },
          WHO,
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('PD-046 no calcula el vencimiento con lo leído antes del candado: pasa sólo lo que cambia y lo recalcula el repositorio', async () => {
    const received = new Date(NOW.getTime() - 2 * 86_400_000);
    const edit = vi.fn().mockResolvedValue({
      status: 'edited',
      request: requestView(),
    });
    const service = new DataSubjectRequestsService(
      requestRepository({
        find: vi
          .fn()
          .mockResolvedValue(requestView({ receivedAt: NOW, right: 'ACCESS' })),
        edit,
      }),
      { record: vi.fn() },
    );

    await service.edit('r-1', { receivedAt: received }, WHO, NOW);
    // Exactamente lo pedido: ni un `dueOn` calculado con la fila de antes.
    expect(edit.mock.calls[0]?.[1]).toEqual({ receivedAt: received });

    await service.edit('r-1', { description: 'Otra cosa' }, WHO, NOW);
    expect(edit.mock.calls[1]?.[1]).toEqual({ description: 'Otra cosa' });
  });

  it('PD-046 rechaza editar una respondida o con recepción futura, sin llegar a escribir', async () => {
    const edit = vi.fn();
    const answeredService = new DataSubjectRequestsService(
      requestRepository({
        find: vi.fn().mockResolvedValue(requestView({ answer: answered })),
        edit,
      }),
      { record: vi.fn() },
    );
    await expect(
      answeredService.edit('r-1', { description: 'x' }, WHO, NOW),
    ).rejects.toMatchObject({ code: 'DATA_REQUEST_ALREADY_ANSWERED' });

    const openService = new DataSubjectRequestsService(
      requestRepository({
        find: vi.fn().mockResolvedValue(requestView()),
        edit,
      }),
      { record: vi.fn() },
    );
    await expect(
      openService.edit(
        'r-1',
        { receivedAt: new Date(NOW.getTime() + 60_000) },
        WHO,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'DATA_REQUEST_RECEIVED_IN_FUTURE' });
    expect(edit).not.toHaveBeenCalled();
  });

  it('PD-047 rectificar una solicitud sin respuesta es DATA_REQUEST_NOT_ANSWERED', async () => {
    const service = new DataSubjectRequestsService(
      requestRepository({
        correctAnswer: vi.fn().mockResolvedValue({ status: 'not-answered' }),
      }),
      { record: vi.fn() },
    );
    await expect(
      service.correctAnswer(
        'r-1',
        { outcome: 'DENIED', response: 'No procede' },
        WHO,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'DATA_REQUEST_NOT_ANSWERED' });
  });
});
