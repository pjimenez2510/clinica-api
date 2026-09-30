import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import type {
  ClinicalCodingRepository,
  DiagnosisView,
  NewDiagnosis,
  NewProcedure,
  ProcedureView,
} from '../domain/clinical-coding.repository';
import type {
  EncounterQuery,
  EncounterRepository,
  EncounterView,
} from '../domain/encounter.repository';
import { ClinicalCodingService } from './clinical-coding.service';
import type { Requester } from './encounter.service';

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

const requester: Requester = {
  userId: USER,
  sites: [SITE],
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
  visitSequence: 'SUBSEQUENT',
  ageYears: 36,
  ageMonths: 2,
  ageDays: 4,
  dischargeCondition: null,
  closedById: null,
  closedAt: null,
  closedBySubstituteReason: null,
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
      note: diagnosis.note ?? null,
      recordedAt: new Date('2026-09-14T14:20:00Z'),
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
}

describe('los casos de uso del bloque K', () => {
  let encounters: FakeEncounters;
  let coding: FakeCoding;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: ClinicalCodingService;

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

    service = new ClinicalCodingService(
      coding,
      encounters as unknown as EncounterRepository,
      audit,
      logger,
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

    const diagnoses = await service.diagnosesOf(ENCOUNTER, requester);
    expect(diagnoses).toHaveLength(4);
  });

  it('EN-009 rechaza diagnosticar en una atención con alta clínica', async () => {
    /**
     * Un diagnóstico es contenido NUEVO, no una enmienda: el médico firmó, el
     * acto terminó, y codificar una enfermedad después cambiaría lo que dijo
     * la consulta sin rastro de corrección. Lo que queda es enmendar la nota.
     */
    encounters.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'),
      dischargeCondition: 'ALIVE',
    });

    await expect(
      service.recordDiagnosis(aDiagnosis(), requester),
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
    expect(coding.written).toHaveLength(0);
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
