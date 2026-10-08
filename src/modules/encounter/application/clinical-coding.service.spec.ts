import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ConsultationRepricer } from '../../../shared/billing/consultation-repricer.port';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  DiagnosisCorrectionRequiresSignatureError,
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  PractitionerNotLicensedError,
} from '../domain/encounter.errors';
import type {
  ClinicalCodingRepository,
  DiagnosisEdit,
  DiagnosisRestoration,
  DiagnosisRetraction,
  DiagnosisVersionView,
  DiagnosisView,
  EncounterCodingCorrection,
  EncounterCodingView,
  NewDiagnosis,
  NewProcedure,
  ProcedureView,
  RetractedDiagnosisView,
} from '../domain/clinical-coding.repository';
import type {
  EncounterQuery,
  EncounterRepository,
  EncounterView,
  PractitionerIdentity,
} from '../domain/encounter.repository';
import {
  ClinicalCodingService,
  type CodingRequester,
} from './clinical-coding.service';

/**
 * Block K's use cases, against an in-memory port.
 *
 * WHAT A DOUBLE CAN PROVE HERE is exactly the list of things that are NOT
 * database guarantees: the order of the refusals, that a discharged attention
 * takes no new diagnosis, what leaves a row in the access trail, that the
 * per-diagnosis occurrence is never derived from the attention's own visit
 * sequence, and that no amount ever crosses this boundary.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: the frozen snapshot (EN-041), the validity
 * of the concept on the day of care (EN-042) and the single principal
 * diagnosis (EN-043). All three are PostgreSQL's, and a double returning what
 * we asked it for would prove none of them — they are exercised in
 * `test/integration/encounter-diagnoses.spec.ts` against a real database.
 */

const SITE = 'site-1';
const OTHER_SITE = 'site-2';
const ENCOUNTER = 'encounter-1';
const USER = 'user-1';
const CONCEPT = 'concept-1';

const requester: CodingRequester = {
  userId: USER,
  sites: [SITE],
  // EN-212, D-117.13. Signs the history where it writes it, like a doctor.
  signSites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anEncounter = (
  overrides: Partial<EncounterView> = {},
): EncounterView => ({
  id: ENCOUNTER,
  siteId: SITE,
  practitionerId: 'practitioner-1',
  patientId: 'patient-1',
  agendaEntryId: null,
  startedAt: new Date('2026-09-14T14:00:00Z'),
  endedAt: null,
  status: 'OPEN',
  careModality: 'MORBIDITY',
  careSetting: 'INTRAMURAL',
  carePlace: 1,
  medicoDelBarrio: false,
  visitSequence: 'SUBSEQUENT',
  ageYears: 36,
  ageMonths: 2,
  ageDays: 4,
  dischargeCondition: null,
  closedById: null,
  closedAt: null,
  closedBySubstituteReason: null,
  annulment: null,
  interruption: null,
  ...overrides,
});

/**
 * Only the two methods this service uses. The rest of `EncounterRepository`
 * would be dead weight in this file, so it is stubbed by assertion rather than
 * implemented — a double that implements more than the subject calls is a
 * double that hides which dependency the subject actually has.
 */
class FakeEncounters {
  stored: EncounterView = anEncounter();
  identity: PractitionerIdentity | null = {
    practitionerId: 'practitioner-1',
    acessExpiresOn: null,
  };

  findPractitionerByUser(): Promise<PractitionerIdentity | null> {
    return Promise.resolve(this.identity);
  }

  findById(query: EncounterQuery): Promise<EncounterView | null> {
    const inScope =
      query.sites === 'all' || query.sites.includes(this.stored.siteId);
    return Promise.resolve(
      query.encounterId === this.stored.id && inScope ? this.stored : null,
    );
  }
}

class FakeCoding implements ClinicalCodingRepository {
  written: NewDiagnosis[] = [];
  performed: NewProcedure[] = [];
  diagnoses: DiagnosisView[] = [];
  procedures: ProcedureView[] = [];

  addDiagnosis(diagnosis: NewDiagnosis): Promise<DiagnosisView> {
    this.written.push(diagnosis);
    const view: DiagnosisView = {
      id: `diagnosis-${String(this.written.length)}`,
      encounterId: diagnosis.encounterId,
      conceptId: diagnosis.conceptId,
      cie10Code: 'J020',
      cie10Display: 'Faringitis estreptocócica',
      certainty: diagnosis.certainty,
      occurrence: diagnosis.occurrence,
      rank: diagnosis.rank ?? 1,
      careModality: 'MORBIDITY',
      notifiable: diagnosis.notifiable ?? false,
      mayBePrincipal: true,
      note: diagnosis.note ?? null,
      recordedAt: new Date('2026-09-14T14:20:00Z'),
      editedAt: null,
    };
    this.diagnoses.push(view);
    return Promise.resolve(view);
  }

  diagnosesOf(): Promise<DiagnosisView[]> {
    return Promise.resolve(this.diagnoses);
  }

  addProcedure(procedure: NewProcedure): Promise<ProcedureView> {
    this.performed.push(procedure);
    const view: ProcedureView = {
      id: `procedure-${String(this.performed.length)}`,
      encounterId: procedure.encounterId,
      conceptId: procedure.conceptId,
      procedureCode: '23.09',
      procedureDisplay: 'Extracción dental',
      quantity: procedure.quantity,
      performedAt: procedure.performedAt ?? new Date('2026-09-14T14:30:00Z'),
      note: procedure.note ?? null,
    };
    this.procedures.push(view);
    return Promise.resolve(view);
  }

  proceduresOf(): Promise<ProcedureView[]> {
    return Promise.resolve(this.procedures);
  }

  retracted: DiagnosisRetraction[] = [];

  retractDiagnosis(retraction: DiagnosisRetraction): Promise<void> {
    this.retracted.push(retraction);
    return Promise.resolve();
  }

  madePrimary: string[] = [];

  makePrimary(change: { diagnosisId: string }): Promise<DiagnosisView[]> {
    this.madePrimary.push(change.diagnosisId);
    return Promise.resolve(this.diagnoses);
  }

  edits: DiagnosisEdit[] = [];

  editDiagnosis(edit: DiagnosisEdit): Promise<DiagnosisView> {
    this.edits.push(edit);
    return Promise.resolve(this.diagnoses[0]!);
  }

  diagnosisVersions(): Promise<DiagnosisVersionView[]> {
    return Promise.resolve([]);
  }

  certificateCodes: string[] = [];
  prescriptionCodes: string[] = [];

  codesPrintedOnPrescriptions(): Promise<string[]> {
    return Promise.resolve(this.prescriptionCodes);
  }

  orderCodes: string[] = [];

  codesPrintedOnOrders(): Promise<string[]> {
    return Promise.resolve(this.orderCodes);
  }

  restored: DiagnosisRestoration[] = [];

  restoreDiagnosis(restoration: DiagnosisRestoration): Promise<DiagnosisView> {
    this.restored.push(restoration);
    return Promise.resolve({ ...this.diagnoses[0]!, id: 'diagnosis-restored' });
  }

  codesPrintedOnCertificates(): Promise<string[]> {
    return Promise.resolve(this.certificateCodes);
  }

  retractedDiagnosesOf(): Promise<RetractedDiagnosisView[]> {
    return Promise.resolve([]);
  }

  correctEncounterCoding(
    correction: EncounterCodingCorrection,
  ): Promise<EncounterCodingView> {
    return Promise.resolve({
      careModality: correction.careModality ?? 'MORBIDITY',
      visitSequence: correction.visitSequence ?? 'FIRST_TIME',
      carePlace: correction.carePlace ?? 1,
      medicoDelBarrio: correction.medicoDelBarrio ?? false,
    });
  }
}

describe('los casos de uso del bloque K', () => {
  let encounters: FakeEncounters;
  let coding: FakeCoding;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: ClinicalCodingService;
  let repricer: {
    repriceConsultation: Mock<ConsultationRepricer['repriceConsultation']>;
  };

  beforeEach(() => {
    encounters = new FakeEncounters();
    coding = new FakeCoding();
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
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as PinoLogger;

    repricer = {
      repriceConsultation: vi
        .fn<ConsultationRepricer['repriceConsultation']>()
        .mockResolvedValue(undefined),
    };

    service = new ClinicalCodingService(
      coding,
      encounters as unknown as EncounterRepository,
      audit,
      logger,
      repricer,
    );
  });

  const aDiagnosis = (overrides: Record<string, unknown> = {}) => ({
    encounterId: ENCOUNTER,
    conceptId: CONCEPT,
    certainty: 'DEFINITIVE' as const,
    occurrence: 'FIRST_TIME' as const,
    ...overrides,
  });

  it('EN-040 registra el diagnóstico contra el CONCEPTO y nunca contra un código tecleado', async () => {
    /**
     * No hay campo de código en la petición y no lo hay a propósito: un código
     * escrito a mano produce `E119`, `E11.9` y `E 11.9` como tres
     * enfermedades distintas, y el reporte del mes las cuenta por separado.
     */
    const diagnosis = await service.recordDiagnosis(aDiagnosis(), requester);

    expect(coding.written[0]?.conceptId).toBe(CONCEPT);
    expect(diagnosis.cie10Code).toBe('J020');
  });

  it('EN-045 no deriva primera-vez/subsecuente de la secuencia de la atención', async () => {
    /**
     * ⚠️ EL CASO QUE HACE FALSA LA DERIVACIÓN. La atención es SUBSEQUENT —el
     * paciente viene por su hipertensión— y hoy se le diagnostica diabetes,
     * que es de PRIMERA VEZ. Derivar una de otra deja la incidencia de
     * diabetes del mes en cero.
     */
    expect(encounters.stored.visitSequence).toBe('SUBSEQUENT');

    const diagnosis = await service.recordDiagnosis(
      aDiagnosis({ occurrence: 'FIRST_TIME' }),
      requester,
    );

    expect(diagnosis.occurrence).toBe('FIRST_TIME');
    expect(coding.written[0]?.occurrence).toBe('FIRST_TIME');
  });

  it('EN-044 guarda la condición del diagnóstico tal como llega', async () => {
    const diagnosis = await service.recordDiagnosis(
      aDiagnosis({ certainty: 'PRESUMPTIVE' }),
      requester,
    );
    expect(diagnosis.certainty).toBe('PRESUMPTIVE');
  });

  it('EN-049 traslada la marca de notificación obligatoria sin inventarla', async () => {
    /**
     * Es un apaño declarado: la lista del MSP tiene que ser propiedad del
     * CONCEPTO, y hoy no hay columna. Lo que este servicio no hace es
     * fingir que la deduce.
     */
    const marked = await service.recordDiagnosis(
      aDiagnosis({ notifiable: true }),
      requester,
    );
    expect(marked.notifiable).toBe(true);

    const unmarked = await service.recordDiagnosis(aDiagnosis(), requester);
    expect(unmarked.notifiable).toBe(false);
  });

  it('EN-047 admite más de tres diagnósticos en una atención', async () => {
    /**
     * El formulario tiene tres casillas y la historia clínica no tiene por qué
     * tenerlas: recortar el expediente a tres porque la hoja A3 tiene tres es
     * dejar de registrar lo que el paciente tiene. El recorte es de la
     * exportación.
     */
    for (const rank of [1, 2, 3, 4]) {
      await service.recordDiagnosis(aDiagnosis({ rank }), requester);
    }

    const { items } = await service.diagnosesOf(ENCOUNTER, requester);
    expect(items).toHaveLength(4);
  });

  it('EN-180 quita un diagnóstico como acto de quien lo quita, y un motivo en blanco no es motivo', async () => {
    await service.retractDiagnosis(
      { encounterId: ENCOUNTER, diagnosisId: 'diagnosis-1', reason: '   ' },
      requester,
    );

    expect(coding.retracted).toEqual([
      expect.objectContaining({
        diagnosisId: 'diagnosis-1',
        reason: null,
        retractedById: requester.userId,
      }),
    ]);
    expect(audit.entries.map((entry) => entry.action)).toEqual(['UPDATE']);
  });

  it.each(['DISCHARGED', 'COMPLETED'] as const)(
    'EN-188 quita un diagnóstico y cambia el principal de una atención con alta (%s)',
    async (status) => {
      encounters.stored = anEncounter({
        status,
        endedAt: new Date('2026-09-14T15:00:00Z'), // fecha-fija: la de la atención de prueba
        dischargeCondition: 'ALIVE',
      });

      await service.retractDiagnosis(
        {
          encounterId: ENCOUNTER,
          diagnosisId: 'diagnosis-1',
          reason: 'Código equivocado',
        },
        requester,
      );
      await service.makePrimary(ENCOUNTER, 'diagnosis-2', requester);

      expect(coding.retracted).toEqual([
        expect.objectContaining({ reason: 'Código equivocado' }),
      ]);
      expect(coding.madePrimary).toEqual(['diagnosis-2']);
    },
  );

  it.each(['DISCONTINUED', 'ENTERED_IN_ERROR'] as const)(
    'EN-180 no quita un diagnóstico de una atención %s',
    async (status) => {
      encounters.stored = anEncounter({
        status,
        endedAt: new Date('2026-09-14T15:00:00Z'), // fecha-fija: la de la atención de prueba
      });

      await expect(
        service.retractDiagnosis(
          { encounterId: ENCOUNTER, diagnosisId: 'diagnosis-1', reason: 'x' },
          requester,
        ),
      ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
      await expect(
        service.makePrimary(ENCOUNTER, 'diagnosis-1', requester),
      ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
      expect(coding.retracted).toHaveLength(0);
      expect(audit.entries).toHaveLength(0);
    },
  );

  it('EN-212 edita como acto de quien edita, deja una fila de bitácora, y un motivo en blanco no es motivo', async () => {
    await service.recordDiagnosis(aDiagnosis(), requester);
    audit.entries.length = 0;

    await service.editDiagnosis(
      {
        encounterId: ENCOUNTER,
        diagnosisId: 'diagnosis-1',
        certainty: 'PRESUMPTIVE',
        reason: '   ',
      },
      requester,
    );

    expect(coding.edits).toEqual([
      expect.objectContaining({
        diagnosisId: 'diagnosis-1',
        certainty: 'PRESUMPTIVE',
        reason: null,
        editedById: USER,
        mayCorrectAfterDischarge: true,
      }),
    ]);
    expect(audit.entries.map((entry) => entry.action)).toEqual(['UPDATE']);
  });

  it('EN-212 D-117.13 tras el alta corrige sólo quien firma historia en la sede y con registro vigente; nada se escribe si no', async () => {
    encounters.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'), // fecha-fija: la de la atención de prueba
      dischargeCondition: 'ALIVE',
    });
    const edit = {
      encounterId: ENCOUNTER,
      diagnosisId: 'diagnosis-1',
      certainty: 'PRESUMPTIVE' as const,
    };

    // Signs at another site only: not here.
    await expect(
      service.editDiagnosis(edit, { ...requester, signSites: [OTHER_SITE] }),
    ).rejects.toBeInstanceOf(DiagnosisCorrectionRequiresSignatureError);
    await expect(
      service.makePrimary(ENCOUNTER, 'diagnosis-1', {
        ...requester,
        signSites: [],
      }),
    ).rejects.toBeInstanceOf(DiagnosisCorrectionRequiresSignatureError);

    encounters.identity = {
      practitionerId: 'practitioner-1',
      acessExpiresOn: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    };
    await expect(service.editDiagnosis(edit, requester)).rejects.toBeInstanceOf(
      PractitionerNotLicensedError,
    );
    expect(coding.edits).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);

    // Positive control: in force, and signing here.
    encounters.identity = { practitionerId: 'practitioner-1', acessExpiresOn: null }; // prettier-ignore
    encounters.stored = { ...encounters.stored, status: 'OPEN' };
    await service.recordDiagnosis(aDiagnosis(), requester);
    encounters.stored = { ...encounters.stored, status: 'DISCHARGED' };
    await service.editDiagnosis(edit, { ...requester, signSites: 'all' });
    expect(coding.edits).toHaveLength(1);
  });

  it('EN-212 D-117.13 con la atención viva, la licencia vencida viaja al adaptador como «no corrige tras el alta», por si el alta llega antes del bloqueo', async () => {
    const edit = {
      encounterId: ENCOUNTER,
      diagnosisId: 'diagnosis-1',
      certainty: 'PRESUMPTIVE' as const,
    };
    await service.recordDiagnosis(aDiagnosis(), requester);
    encounters.identity = {
      practitionerId: 'practitioner-1',
      acessExpiresOn: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    };

    // Live: the edit goes through, and the adapter is told why it may not
    // once it finds the discharge under the lock.
    await service.editDiagnosis(edit, requester);
    expect(coding.edits[0]).toMatchObject({
      mayCorrectAfterDischarge: false,
      afterDischargeRefusal: 'NOT_LICENSED',
    });

    // Positive control: in force, it may.
    encounters.identity = { practitionerId: 'practitioner-1', acessExpiresOn: null }; // prettier-ignore
    await service.editDiagnosis(edit, requester);
    expect(coding.edits[1]).toMatchObject({ mayCorrectAfterDischarge: true });
    expect(coding.edits[1]?.afterDischargeRefusal).toBeUndefined();

    // Signing elsewhere only.
    await service.editDiagnosis(edit, {
      ...requester,
      signSites: [OTHER_SITE],
    });
    expect(coding.edits[2]).toMatchObject({
      mayCorrectAfterDischarge: false,
      afterDischargeRefusal: 'NOT_SIGNER',
    });
  });

  it('EN-189 sirve con cada diagnóstico si un certificado emitido imprimió su código', async () => {
    await service.recordDiagnosis(aDiagnosis(), requester);
    coding.certificateCodes = ['J020'];

    const { items } = await service.diagnosesOf(ENCOUNTER, requester);
    expect(items.map((item) => item.printedOnCertificate)).toEqual([true]);

    coding.certificateCodes = ['A09'];
    const again = await service.diagnosesOf(ENCOUNTER, requester);
    expect(again.items.map((item) => item.printedOnCertificate)).toEqual([
      false,
    ]);
  });

  it('EN-214 sirve con cada diagnóstico si una receta emitida imprimió su código', async () => {
    await service.recordDiagnosis(aDiagnosis(), requester);
    coding.prescriptionCodes = ['J020'];

    const { items } = await service.diagnosesOf(ENCOUNTER, requester);
    expect(items.map((item) => item.printedOnPrescription)).toEqual([true]);
  });

  it('ORD-121 sirve con cada diagnóstico si una orden emitida imprimió su código', async () => {
    await service.recordDiagnosis(aDiagnosis(), requester);
    coding.orderCodes = ['J020'];

    const { items } = await service.diagnosesOf(ENCOUNTER, requester);
    expect(items.map((item) => item.printedOnOrder)).toEqual([true]);
  });

  it('EN-213 «Deshacer» es un acto de quien deshace, sólo en la atención viva, y deja una fila de bitácora', async () => {
    await service.recordDiagnosis(aDiagnosis(), requester);
    audit.entries.length = 0;

    const back = await service.restoreDiagnosis(
      ENCOUNTER,
      'diagnosis-1',
      requester,
    );
    expect(back.id).toBe('diagnosis-restored');
    expect(coding.restored).toEqual([
      expect.objectContaining({
        retractionId: 'diagnosis-1',
        restoredById: USER,
      }),
    ]);
    expect(
      audit.entries.map((entry) => [entry.action, entry.resourceId]),
    ).toEqual([['CREATE', 'diagnosis-restored']]);

    encounters.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'), // fecha-fija: la de la atención de prueba
      dischargeCondition: 'ALIVE',
    });
    await expect(
      service.restoreDiagnosis(ENCOUNTER, 'diagnosis-1', requester),
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
    expect(coding.restored).toHaveLength(1);
  });

  it('EN-215 tras el alta sólo registra un diagnóstico quien firma historia en la sede; interrumpida, nadie', async () => {
    /**
     * D-117.12: tras el alta el código correcto se añade, porque el RDACAA lee
     * los diagnósticos de la atención y no la nota. Es corregir la
     * codificación, así que D-117.13 pide `record:sign`.
     */
    encounters.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'), // fecha-fija: la del doble
      dischargeCondition: 'ALIVE',
    });

    await expect(
      service.recordDiagnosis(aDiagnosis(), { ...requester, signSites: [] }),
    ).rejects.toBeInstanceOf(DiagnosisCorrectionRequiresSignatureError);
    expect(coding.written).toHaveLength(0);

    encounters.stored = anEncounter({ status: 'DISCONTINUED' });
    await expect(
      service.recordDiagnosis(aDiagnosis(), requester),
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
    expect(coding.written).toHaveLength(0);
  });

  it('BI-203 corregir primera vez o subsecuente avisa a caja para re-tarifar la consulta; la modalidad sola no', async () => {
    await service.correctEncounterCoding(
      { encounterId: ENCOUNTER, careModality: 'PREVENTION' },
      requester,
    );
    expect(repricer.repriceConsultation).not.toHaveBeenCalled();

    await service.correctEncounterCoding(
      { encounterId: ENCOUNTER, visitSequence: 'FIRST_TIME' },
      requester,
    );
    expect(repricer.repriceConsultation).toHaveBeenCalledWith({
      encounterId: ENCOUNTER,
      siteId: encounters.stored.siteId,
      changedById: requester.userId,
    });
  });

  it('EN-121 responde «no existe» a un diagnóstico de una atención de otra sede', async () => {
    encounters.stored = anEncounter({ siteId: OTHER_SITE });

    await expect(
      service.recordDiagnosis(aDiagnosis(), requester),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
  });

  it('EN-122 deja constancia de quién registró y de quién leyó un diagnóstico', async () => {
    await service.recordDiagnosis(aDiagnosis(), requester);
    await service.diagnosesOf(ENCOUNTER, requester);

    expect(
      audit.entries.map((entry) => [entry.resourceType, entry.action]),
    ).toEqual([
      ['encounter_diagnosis', 'CREATE'],
      ['encounter_diagnosis', 'READ'],
    ]);
  });

  it('EN-122 no deja constancia de una atención que no existe: nada se divulgó', async () => {
    await expect(
      service.diagnosesOf('encounter-desconocida', requester),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
    expect(audit.entries).toEqual([]);
  });

  it('EN-124 no escribe el código CIE-10 en el registro de la aplicación', async () => {
    /**
     * El diagnóstico de una persona identificable en una línea de log es el
     * dato más sensible del sistema en un archivo que nadie trata como
     * clínico. Lo que sale es la sede y el hecho.
     */
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as PinoLogger;
    const watched = new ClinicalCodingService(
      coding,
      encounters as unknown as EncounterRepository,
      audit,
      logger,
      { repriceConsultation: vi.fn() },
    );

    await watched.recordDiagnosis(aDiagnosis(), requester);

    const calls = (logger.info as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [context] = calls[0] as [Record<string, unknown>, string];
    expect(context).toEqual({
      site_id: SITE,
      action: 'DIAGNOSIS_RECORDED',
    });
  });

  it('EN-050 registra el procedimiento con la cantidad de veces que se realizó', async () => {
    // El ejemplo del propio instructivo: dos exodoncias en la misma atención.
    const procedure = await service.recordProcedure(
      { encounterId: ENCOUNTER, conceptId: CONCEPT, quantity: 2 },
      requester,
    );

    expect(procedure.quantity).toBe(2);
    expect(coding.performed[0]?.quantity).toBe(2);
  });

  it('EN-051 no deja pasar ningún importe por esta frontera', async () => {
    /**
     * ⚠️ LA AUSENCIA ES EL REQUISITO. `encounter_procedure.tariff_amount`
     * existe en el esquema y nada de este módulo lo lee ni lo escribe: lo que
     * cuesta el procedimiento es un `charge_item` de `billing`, resuelto por
     * la lista de precios del pagador en la fecha del servicio. Una fila
     * clínica que además lleva el dinero son dos registros en uno.
     */
    const procedure = await service.recordProcedure(
      { encounterId: ENCOUNTER, conceptId: CONCEPT, quantity: 1 },
      requester,
    );

    const money = /amount|price|precio|importe|tarif/i;
    expect(Object.keys(procedure).filter((key) => money.test(key))).toEqual([]);
    expect(
      Object.keys(coding.performed[0] ?? {}).filter((key) => money.test(key)),
    ).toEqual([]);
  });

  it('EN-151 registra un procedimiento de rutina sin pedir consentimiento suscrito', async () => {
    /**
     * Textual del A.M. 5316 §7.6.d: «no se requiere un consentimiento
     * informado suscrito en las intervenciones de riesgo mínimo». Se escribe
     * como requisito negativo porque el fallo es construir de más: una barrera
     * aquí entrena a todo el mundo a hacer clic sin leer, y entonces el
     * consentimiento que sí importa se firma con el mismo automatismo.
     */
    const procedure = await service.recordProcedure(
      { encounterId: ENCOUNTER, conceptId: CONCEPT, quantity: 1 },
      requester,
    );

    expect(procedure.id).toBeTruthy();
    expect(coding.performed).toHaveLength(1);
  });

  it('EN-009 rechaza registrar un procedimiento en una atención con alta clínica', async () => {
    encounters.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'),
      dischargeCondition: 'ALIVE',
    });

    await expect(
      service.recordProcedure(
        { encounterId: ENCOUNTER, conceptId: CONCEPT, quantity: 1 },
        requester,
      ),
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
  });

  it('EN-050 deja constancia de quién registró y de quién leyó un procedimiento', async () => {
    await service.recordProcedure(
      { encounterId: ENCOUNTER, conceptId: CONCEPT, quantity: 1 },
      requester,
    );
    await service.proceduresOf(ENCOUNTER, requester);

    expect(
      audit.entries.map((entry) => [entry.resourceType, entry.action]),
    ).toEqual([
      ['encounter_procedure', 'CREATE'],
      ['encounter_procedure', 'READ'],
    ]);
  });
});
