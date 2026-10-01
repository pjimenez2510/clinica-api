import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  EncounterAlreadyClosedError,
  EncounterAnnulmentReasonRequiredError,
  EncounterInterruptionReasonRequiredError,
  EncounterNotFoundError,
  PatientChartNotOpenError,
  PractitionerProfileRequiredError,
  VitalsRequiredError,
} from '../domain/encounter.errors';
import type {
  ChartHistoryQuery,
  EncounterPage,
  EncounterQuery,
  EncounterRepository,
  EncounterView,
  NewEncounter,
  PatientChartStatus,
  PractitionerIdentity,
  SubjectStatusStamp,
  VitalSignsView,
} from '../domain/encounter.repository';
import type { ClosurePlan } from '../domain/encounter-closure';
import type {
  AnnulmentPlan,
  InterruptionPlan,
} from '../domain/encounter-state';
import type { VitalSigns } from '../domain/vital-signs';
import { EncounterService, type Requester } from './encounter.service';

/**
 * The attention's use cases, against an in-memory port.
 *
 * WHAT A DOUBLE CAN PROVE HERE, and it is exactly the list of things that are
 * NOT database guarantees: the order of the refusals, what leaves a row in the
 * access trail and what deliberately does not, and that the mandatory
 * anthropometry is judged against the age FROZEN on the attention. The frozen
 * age itself, the BMI and the ranges are the database's and are exercised in
 * `test/integration/encounter-vitals.spec.ts`.
 */

const PATIENT = 'patient-1';
const PRACTITIONER = 'practitioner-1';
const SITE = 'site-1';
const USER = 'user-1';

const requester: Requester = {
  userId: USER,
  sites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anEncounter = (
  overrides: Partial<EncounterView> = {},
): EncounterView => ({
  id: 'encounter-1',
  siteId: SITE,
  practitionerId: PRACTITIONER,
  patientId: PATIENT,
  agendaEntryId: null,
  startedAt: new Date('2026-09-14T14:00:00Z'),
  endedAt: null,
  status: 'OPEN',
  careModality: 'MORBIDITY',
  careSetting: 'INTRAMURAL',
  visitSequence: 'FIRST_TIME',
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

class FakeEncounters implements EncounterRepository {
  chart: PatientChartStatus | null = { id: PATIENT, mergedIntoId: null };
  practitioner: PractitionerIdentity | null = {
    practitionerId: PRACTITIONER,
    acessExpiresOn: null,
  };
  stored: EncounterView = anEncounter();
  opened: NewEncounter[] = [];
  savedVitals: VitalSigns[] = [];
  vitalsAuthors: string[] = [];
  stamps: SubjectStatusStamp[] = [];

  findPatientChart(): Promise<PatientChartStatus | null> {
    return Promise.resolve(this.chart);
  }

  findPractitionerByUser(): Promise<PractitionerIdentity | null> {
    return Promise.resolve(this.practitioner);
  }

  open(encounter: NewEncounter): Promise<EncounterView> {
    this.opened.push(encounter);
    return Promise.resolve(this.stored);
  }

  findById(query: EncounterQuery): Promise<EncounterView | null> {
    return Promise.resolve(
      query.encounterId === this.stored.id ? this.stored : null,
    );
  }

  /** EN-162. What the last caller asked for, so a test can read the window back. */
  historyQueries: ChartHistoryQuery[] = [];
  /** The whole chart, out of which the double serves the asked-for window. */
  history: EncounterView[] = [];

  historyOf(query: ChartHistoryQuery): Promise<EncounterPage> {
    this.historyQueries.push(query);
    const rows = this.history.length > 0 ? this.history : [this.stored];
    const from = (query.page - 1) * query.pageSize;
    return Promise.resolve({
      items: rows.slice(from, from + query.pageSize),
      total: rows.length,
    });
  }

  listStillOpen(): Promise<EncounterView[]> {
    return Promise.resolve([this.stored]);
  }

  close(
    _query: EncounterQuery,
    decide: (encounter: EncounterView) => ClosurePlan,
  ): Promise<EncounterView> {
    const plan = decide(this.stored);
    this.stored = {
      ...this.stored,
      status: plan.to,
      endedAt: plan.endedAt,
      dischargeCondition: plan.dischargeCondition,
      closedById: plan.closedById,
      closedAt: plan.closedAt,
      closedBySubstituteReason: plan.substituteReason,
    };
    return Promise.resolve(this.stored);
  }

  /** EN-166, EN-167: the signatures the adapter would write, in order. */
  signedDrafts: { signedById: string; contentHash: string }[] = [];
  /** EN-167: drafts the adapter would find for the interrupting author. */
  drafts: { content: unknown }[] = [];

  annul(
    _query: EncounterQuery,
    decide: (encounter: EncounterView) => AnnulmentPlan,
  ): Promise<EncounterView> {
    const plan = decide(this.stored);
    this.stored = {
      ...this.stored,
      status: plan.to,
      endedAt: plan.endedAt,
      annulment: { reason: plan.reason, at: plan.at },
    };
    return Promise.resolve(this.stored);
  }

  discontinue(
    _query: EncounterQuery,
    decide: (encounter: EncounterView) => InterruptionPlan,
    drafts: {
      authorId: string;
      sign: (draft: { content: unknown }) => {
        signedById: string;
        signedAt: Date;
        contentHash: string;
      };
    },
  ): Promise<EncounterView> {
    const plan = decide(this.stored);
    for (const draft of this.drafts) this.signedDrafts.push(drafts.sign(draft));
    this.stored = {
      ...this.stored,
      status: plan.to,
      endedAt: plan.endedAt,
      interruption: { reason: plan.reason, origin: plan.origin, at: plan.at },
    };
    return Promise.resolve(this.stored);
  }

  saveVitals(
    _query: EncounterQuery,
    vitals: VitalSigns,
    recordedById: string,
  ): Promise<VitalSignsView> {
    this.savedVitals.push(vitals);
    this.vitalsAuthors.push(recordedById);
    return Promise.resolve({
      ...vitals,
      encounterId: this.stored.id,
      bmi: null,
      measuredAt: vitals.measuredAt ?? new Date('2026-09-14T14:05:00Z'),
      recordedBy: { id: recordedById, name: 'Carmen Salazar' },
      correctedBy: null,
      correctedAt: null,
    });
  }

  findVitals(): Promise<VitalSignsView | null> {
    return Promise.resolve(null);
  }

  stampSubjectStatus(stamp: SubjectStatusStamp): Promise<void> {
    this.stamps.push(stamp);
    return Promise.resolve();
  }
}

describe('los casos de uso de la atención', () => {
  let repository: FakeEncounters;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: EncounterService;

  beforeEach(() => {
    repository = new FakeEncounters();
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

    service = new EncounterService(repository, audit, logger);
  });

  const openRequest = {
    siteId: SITE,
    practitionerId: PRACTITIONER,
    patientId: PATIENT,
    startedAt: new Date('2026-09-14T14:00:00Z'),
    careModality: 'MORBIDITY' as const,
    careSetting: 'INTRAMURAL' as const,
    visitSequence: 'FIRST_TIME' as const,
  };

  it('EN-003 abre una atención sin cita, sin obligar a crear una', () => {
    // The urgency and the person at the counter are half of outpatient care;
    // forcing a cita produces fictitious appointments with falsified hours.
    return service.open(openRequest, requester).then((encounter) => {
      expect(encounter.id).toBe('encounter-1');
      expect(repository.opened[0]?.agendaEntryId).toBeUndefined();
    });
  });

  it('EN-001 rechaza abrir una atención de un paciente sin ficha', async () => {
    repository.chart = null;

    await expect(service.open(openRequest, requester)).rejects.toBeInstanceOf(
      PatientChartNotOpenError,
    );
    // Nothing was written: the refusal comes BEFORE the insert, which is what
    // art. 4 demands — the history is open before the attention starts.
    expect(repository.opened).toEqual([]);
  });

  it('EN-001 rechaza abrir una atención sobre una ficha absorbida por una fusión', async () => {
    repository.chart = { id: PATIENT, mergedIntoId: 'surviving-chart' };

    const refusal = await service
      .open(openRequest, requester)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PatientChartNotOpenError);
    // ⚠️ AND IT DOES NOT NAME THE SURVIVING CHART. Whoever is opening the
    // attention may hold nothing at all, so publishing the other chart's
    // number would hand out a datum one guess at a time (EN-124).
    expect(JSON.stringify(refusal)).not.toContain('surviving-chart');
  });

  it('EN-017 deja exactamente una fila de bitácora al abrir la atención', async () => {
    await service.open(openRequest, requester);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      userId: USER,
      resourceType: 'encounter',
      resourceId: 'encounter-1',
      action: 'CREATE',
      ip: '10.0.0.9',
    });
  });

  it('EN-017 no deja fila de bitácora cuando la apertura se rechaza', async () => {
    repository.chart = null;

    await service.open(openRequest, requester).catch(() => undefined);

    // There is no data subject to account to: a row per guessed identifier
    // would let anybody fill the trail with noise (PA-024's criterion).
    expect(audit.entries).toEqual([]);
  });

  it('EN-122 deja una fila de bitácora al abrir una atención concreta', async () => {
    await service.byId('encounter-1', requester);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'READ' });
  });

  it('EN-123 no deja ninguna fila de bitácora al LISTAR atenciones', async () => {
    /**
     * SC-017 in one assertion: «El 100 % de las aperturas de atención deja
     * exactamente una fila en la bitácora; listar las atenciones del día deja
     * CERO». Recording every listed row buries the accesses that matter, and
     * what makes it safe is that a listing carries no clinical content.
     */
    await service.historyOf(
      { patientId: PATIENT, page: 1, pageSize: 20 },
      requester,
    );
    await service.listStillOpen(undefined, requester);

    expect(audit.entries).toEqual([]);
  });

  it('EN-162 sirve una página de la historia y el total, no las ciento treinta y siete', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * CORTAR EN EL CLIENTE REDUCE LO QUE SE PINTA, NO LO QUE VIAJA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La ficha del paciente traía la historia entera y pintaba veinte. El
     * paciente crónico de diez años es exactamente el caso que lo rompe, y el
     * `total` es lo que permite decir «20 de 137» sin traerlas todas.
     */
    repository.history = Array.from({ length: 137 }, (_, index) =>
      anEncounter({ id: `encounter-${String(index)}` }),
    );

    const page = await service.historyOf(
      { patientId: PATIENT, page: 2, pageSize: 20 },
      requester,
    );

    expect(page.items).toHaveLength(20);
    expect(page.items[0]?.id).toBe('encounter-20');
    expect(page.total).toBe(137);
  });

  it('EN-121 lleva el alcance de sedes de quien pregunta a la página de la historia', async () => {
    // La consulta la acota el HANDLER: el listado no lleva la sede en la URL,
    // así que el alcance resuelto viaja hasta el `WHERE` y no se filtra
    // después.
    await service.historyOf(
      { patientId: PATIENT, page: 1, pageSize: 20 },
      requester,
    );

    expect(repository.historyQueries[0]).toEqual({
      patientId: PATIENT,
      sites: [SITE],
      page: 1,
      pageSize: 20,
    });
  });

  it('EN-121 no distingue una atención inexistente de una de otra sede', async () => {
    await expect(
      service.byId('another-encounter', requester),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
    expect(audit.entries).toEqual([]);
  });

  it('EN-146 lista las atenciones sin cerrar del profesional', async () => {
    const open = await service.listStillOpen(PRACTITIONER, requester);
    expect(open).toHaveLength(1);
  });

  it('EN-145 no expone ninguna operación que cierre atenciones por sí sola', () => {
    /**
     * ⚠️ LA AUSENCIA ES EL REQUISITO. D-A-010 descarta el cierre automático
     * porque tendría que inventarse la condición de egreso (EN-009), y lo que
     * lo hace cierto en código es que no existe ningún método que un
     * planificador pueda llamar: el único cierre toma un `Requester` con la
     * sesión de una persona y una atención concreta.
     */
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service) as object,
    );

    expect(methods.filter((name) => /expire|purge|sweep|cron/i.test(name))).toEqual([]); // prettier-ignore
    expect(methods).toContain('close');
    // And closing takes a REQUESTER: there is no signature a scheduler could
    // satisfy without a person's session behind it.
    expect(FakeEncounters.prototype.close.length).toBe(2);
  });

  it('EN-166 anula con el motivo y deja una fila de bitácora', async () => {
    const annulled = await service.annul(
      { encounterId: 'encounter-1', reason: ' Ficha de otro paciente ' },
      requester,
    );

    expect(annulled.status).toBe('ENTERED_IN_ERROR');
    expect(annulled.annulment?.reason).toBe('Ficha de otro paciente');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'UPDATE', resourceId: 'encounter-1' }); // prettier-ignore
  });

  it('EN-166 rechaza anular sin motivo y no escribe nada', async () => {
    await expect(
      service.annul({ encounterId: 'encounter-1', reason: '  ' }, requester),
    ).rejects.toBeInstanceOf(EncounterAnnulmentReasonRequiredError);
    expect(repository.stored.status).toBe('OPEN');
    expect(audit.entries).toEqual([]);
  });

  it('EN-166 rechaza anular a quien no tiene ficha profesional', async () => {
    repository.practitioner = null;
    await expect(
      service.annul({ encounterId: 'encounter-1', reason: 'x' }, requester),
    ).rejects.toBeInstanceOf(PractitionerProfileRequiredError);
  });

  it('EN-167 interrumpe con motivo y origen y firma los borradores con lo escrito', async () => {
    repository.drafts = [{ content: { motivoConsulta: 'Cefalea' } }];

    const discontinued = await service.discontinue(
      { encounterId: 'encounter-1', reason: 'Se retiró', origin: 'PATIENT' },
      requester,
    );

    expect(discontinued.status).toBe('DISCONTINUED');
    expect(discontinued.interruption).toMatchObject({ reason: 'Se retiró', origin: 'PATIENT' }); // prettier-ignore
    expect(repository.signedDrafts).toHaveLength(1);
    expect(repository.signedDrafts[0]?.signedById).toBe(PRACTITIONER);
    expect(repository.signedDrafts[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('EN-167 rechaza interrumpir sin origen', async () => {
    await expect(
      service.discontinue(
        { encounterId: 'encounter-1', reason: 'Se retiró' },
        requester,
      ),
    ).rejects.toBeInstanceOf(EncounterInterruptionReasonRequiredError);
  });

  it('EN-131 cierra la cuenta y registra quién y cuándo', async () => {
    repository.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'),
      dischargeCondition: 'ALIVE',
    });

    const closed = await service.close(
      { encounterId: 'encounter-1', canSignRecords: false },
      requester,
    );

    expect(closed.status).toBe('COMPLETED');
    expect(closed.closedById).toBe(PRACTITIONER);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closedBySubstituteReason).toBeNull();
  });

  it('EN-144 rechaza cerrar cuando la cuenta no tiene ficha profesional detrás', async () => {
    // `closed_by_id` is a foreign key to `practitioner`: without this refusal
    // the case comes out as `RELATED_RECORD_MISSING` on a form where nothing
    // is wrong.
    repository.practitioner = null;

    await expect(
      service.close({ encounterId: 'encounter-1', canSignRecords: true }, requester), // prettier-ignore
    ).rejects.toBeInstanceOf(PractitionerProfileRequiredError);
  });

  it('EN-135 pone al paciente en preparación al abrir la toma de signos', async () => {
    await service.startVitals('encounter-1', requester);

    expect(repository.stamps).toHaveLength(1);
    expect(repository.stamps[0]?.fact).toBe('VITALS_OPENED');
    // ⚠️ NADA CLÍNICO SE ESCRIBE: lo único que ocurre es que el tablero avanza.
    expect(repository.savedVitals).toEqual([]);
  });

  it('EN-136 pone al paciente LISTO al guardar los signos, sin pedir un botón más', async () => {
    await service.recordVitals('encounter-1', { weightKg: 68.4 }, requester);

    expect(repository.stamps.map((stamp) => stamp.fact)).toEqual([
      'VITALS_RECORDED',
    ]);
  });

  it('EN-063 exige la antropometría del menor de 5 años con la edad CONGELADA', async () => {
    /**
     * EN-008: what was true THAT DAY. Judged against today's date instead, a
     * report reprocessed next year would refuse rows it accepted — the
     * reasoning PA-005 wrote down for «intersexual en menores de un año».
     */
    repository.stored = anEncounter({ ageYears: 0, ageMonths: 3, ageDays: 2 });

    await expect(
      service.recordVitals('encounter-1', { weightKg: 6.2 }, requester),
    ).rejects.toBeInstanceOf(VitalsRequiredError);
    expect(repository.savedVitals).toEqual([]);
  });

  it('EN-066 registra los signos sin que exista ninguna nota clínica', async () => {
    /**
     * THE REQUIREMENT THAT WAS IMPOSSIBLE UNTIL D-A-003. Nursing takes the
     * vital signs before the doctor walks in, and nothing here asks for a
     * note, an author with `record:write` or a signature.
     */
    const vitals = await service.recordVitals(
      'encounter-1',
      { weightKg: 68.4, heightCm: 165 },
      requester,
    );

    expect(vitals.weightKg).toBe(68.4);
    expect(repository.savedVitals).toHaveLength(1);
  });

  it('EN-143 escribe el autor en el propio dato con la cuenta de la sesion, y deja la bitacora', async () => {
    /**
     * D-048: la autoría vive EN EL DATO —quién tomó el peso—, y sale de la
     * sesión, nunca del cuerpo. La bitácora sigue, con su `resourceType`
     * propio, porque la fila sólo guarda al autor de la toma VIGENTE y la de
     * antes se corrigió encima.
     */
    await service.recordVitals('encounter-1', { weightKg: 68.4 }, requester);

    expect(repository.vitalsAuthors).toEqual([USER]);

    expect(audit.entries).toContainEqual(
      expect.objectContaining({
        userId: USER,
        resourceType: 'encounter_vitals',
        resourceId: 'encounter-1',
        action: 'CREATE',
      }),
    );
  });

  it('EN-130 rechaza registrar signos vitales en una atención ya dada de alta', async () => {
    repository.stored = anEncounter({
      status: 'DISCHARGED',
      endedAt: new Date('2026-09-14T15:00:00Z'),
      dischargeCondition: 'ALIVE',
    });

    const refusal = await service
      .recordVitals('encounter-1', { weightKg: 68.4 }, requester)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(EncounterAlreadyClosedError);
    expect((refusal as EncounterAlreadyClosedError).userTitle).toContain(
      'Con alta clínica',
    );
  });

  it('EN-060 conserva el instante de la TOMA, que no es el del tecleo', () => {
    // Nursing weighs at 08:10 and the network returns at 08:40: a record that
    // says 08:40 has quietly moved a fact.
    const measuredAt = new Date('2026-09-14T13:10:00Z');

    return service
      .recordVitals('encounter-1', { weightKg: 68.4, measuredAt }, requester)
      .then(() => {
        expect(repository.savedVitals[0]?.measuredAt).toEqual(measuredAt);
      });
  });
});
