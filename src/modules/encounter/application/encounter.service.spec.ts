import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  PatientChartNotOpenError,
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
  VitalsCorrectionRequiresSignatureError,
} from '../domain/encounter.errors';
import type {
  ChartHistoryQuery,
  EncounterPage,
  EncounterQuery,
  EncounterStatusChange,
  EncounterRepository,
  EncounterView,
  StillOpenEncounter,
  NewEncounter,
  PatientChartStatus,
  SurvivingChart,
  PractitionerIdentity,
  SubjectStatusStamp,
  VitalSignsView,
  VitalsCorrectionAuthority,
  VitalsVersionView,
} from '../domain/encounter.repository';
import type { VitalSigns } from '../domain/vital-signs';
import type { LiveEvent } from '../../../shared/events/live-event';
import { InProcessLiveEventBus } from '../../../shared/events/live-event-bus';
import {
  EncounterService,
  type Requester,
  type VitalsRequester,
} from './encounter.service';

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

/** EN-228. Nursing: writes the signs, signs no history anywhere. */
const nurse: VitalsRequester = { ...requester, signSites: [] };

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
  carePlace: 1,
  medicoDelBarrio: false,
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
  hold: null,
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
  /** EN-228. What the service told the adapter to allow under the lock. */
  correctionAuthority: VitalsCorrectionAuthority[] = [];
  /** EN-217. The taking already on the attention, if any. */
  taken: VitalSignsView | null = null;
  stamps: SubjectStatusStamp[] = [];

  findPatientChart(): Promise<PatientChartStatus | null> {
    return Promise.resolve(this.chart);
  }

  findSurvivingChart(): Promise<SurvivingChart | null> {
    return Promise.resolve(null);
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

  /** EN-133. One opening row for the stored attention, as the trigger writes it. */
  statusHistoryOf(
    query: EncounterQuery,
  ): Promise<EncounterStatusChange[] | null> {
    return Promise.resolve(
      query.encounterId === this.stored.id
        ? [
            {
              from: null,
              to: 'OPEN',
              fact: 'OPENED',
              byName: 'Ana Villacís',
              at: this.stored.startedAt,
              reason: null,
            },
          ]
        : null,
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

  listStillOpen(): Promise<StillOpenEncounter[]> {
    return Promise.resolve([
      {
        ...this.stored,
        patient: { name: 'Ana Villacís', mrn: 'HC0000000001' },
      },
    ]);
  }

  saveVitals(
    _query: EncounterQuery,
    vitals: VitalSigns,
    recordedById: string,
    authority: VitalsCorrectionAuthority,
  ): Promise<VitalSignsView> {
    this.savedVitals.push(vitals);
    this.vitalsAuthors.push(recordedById);
    this.correctionAuthority.push(authority);
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
    return Promise.resolve(this.taken);
  }

  /** EN-217. What the database would say is missing; proven against it. */
  pending: ('weightKg' | 'heightCm' | 'headCircumferenceCm')[] = [];
  anthropometryPending(): Promise<
    ('weightKg' | 'heightCm' | 'headCircumferenceCm')[]
  > {
    return Promise.resolve(this.pending);
  }

  /** EN-063. What the database would say is demanded; proven against it. */
  anthropometryRequired(): Promise<
    ('weightKg' | 'heightCm' | 'headCircumferenceCm')[]
  > {
    return Promise.resolve([]);
  }

  findVitalsVersions(): Promise<VitalsVersionView[]> {
    return Promise.resolve([]);
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
  let heard: LiveEvent[];

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

    heard = [];
    const liveEvents = new InProcessLiveEventBus();
    liveEvents.subscribe((event) => heard.push(event));
    service = new EncounterService(repository, audit, logger, liveEvents);
  });

  const openRequest = {
    siteId: SITE,
    practitionerId: PRACTITIONER,
    patientId: PATIENT,
    startedAt: new Date('2026-09-14T14:00:00Z'),
    careModality: 'MORBIDITY' as const,
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

  it('AG-179 abrir la atención avisa a la agenda y a la sala de su sede, no a caja; rechazada, a nadie', async () => {
    await service.open(openRequest, requester);
    expect(heard).toEqual([
      { kind: 'agenda', siteId: SITE },
      { kind: 'waiting-room', siteId: SITE },
    ]);

    heard.length = 0;
    repository.chart = null;
    await expect(service.open(openRequest, requester)).rejects.toThrow();
    expect(heard).toEqual([]);
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

  it('EN-211 deja una fila de bitácora al leer las versiones de los signos', async () => {
    const versions = await service.vitalsVersionsOf('encounter-1', requester);

    expect(versions).toEqual([]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      resourceType: 'encounter_vitals',
      resourceId: 'encounter-1',
      action: 'READ',
    });
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

  it('EN-133 EN-127 abrir dice al almacén quién abre, y la atención nace en el establecimiento y fuera de la estrategia', async () => {
    await service.open(openRequest, requester);
    expect(repository.opened[0]).toMatchObject({
      openedById: requester.userId,
      carePlace: 1,
      medicoDelBarrio: false,
    });
  });

  it('EN-012 EN-013 abrir con otro lugar y la estrategia los lleva al almacén', async () => {
    await service.open(
      { ...openRequest, carePlace: 4, medicoDelBarrio: true },
      requester,
    );
    expect(repository.opened[0]).toMatchObject({
      carePlace: 4,
      medicoDelBarrio: true,
    });
  });

  it('EN-133 sirve el historial de estados sin dejar fila de bitácora, y una atención ajena es 404', async () => {
    const trail = await service.statusHistory('encounter-1', requester);
    expect(trail).toEqual([
      expect.objectContaining({ from: null, to: 'OPEN', fact: 'OPENED' }),
    ]);
    expect(audit.entries).toEqual([]);

    await expect(
      service.statusHistory('another-encounter', requester),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
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
     * planificador pueda llamar. Desde D-184 la atención la cierra caja al
     * cerrar la cuenta (EN-131), y ni siquiera ese camino vive aquí.
     */
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service) as object,
    );

    expect(methods.filter((name) => /expire|purge|sweep|cron|close/i.test(name))).toEqual([]); // prettier-ignore
  });

  it('EN-135 pone al paciente en preparación al abrir la toma de signos', async () => {
    await service.startVitals('encounter-1', requester);

    expect(repository.stamps).toHaveLength(1);
    expect(repository.stamps[0]?.fact).toBe('VITALS_OPENED');
    // ⚠️ NADA CLÍNICO SE ESCRIBE: lo único que ocurre es que el tablero avanza.
    expect(repository.savedVitals).toEqual([]);
  });

  it('EN-136 pone al paciente LISTO al guardar los signos, sin pedir un botón más', async () => {
    await service.recordVitals('encounter-1', { weightKg: 68.4 }, nurse);

    expect(repository.stamps.map((stamp) => stamp.fact)).toEqual([
      'VITALS_RECORDED',
    ]);
  });

  it('EN-217 guarda la toma aunque falte la antropometría obligatoria, y dice qué falta', async () => {
    /**
     * EN-008: what was true THAT DAY. D-132 B: the taking is saved and the
     * missing anthropometry is said; it is demanded when the note is signed.
     */
    repository.stored = anEncounter({ ageYears: 0, ageMonths: 3, ageDays: 2 });
    repository.pending = ['heightCm', 'headCircumferenceCm'];

    const saved = await service.recordVitals(
      'encounter-1',
      { weightKg: 6.2 },
      nurse,
    );
    expect(repository.savedVitals).toHaveLength(1);
    expect(saved.anthropometryPending).toEqual([
      'heightCm',
      'headCircumferenceCm',
    ]);
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
      nurse,
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
    await service.recordVitals('encounter-1', { weightKg: 68.4 }, nurse);

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
      .recordVitals('encounter-1', { weightKg: 68.4 }, nurse)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(EncounterAlreadyClosedError);
    expect((refusal as EncounterAlreadyClosedError).userTitle).toContain(
      'Con alta clínica',
    );
  });

  describe('EN-228 corregir los signos tras el alta exige record:sign en la sede de la atención', () => {
    const taking = (): VitalSignsView => ({
      encounterId: 'encounter-1',
      weightKg: 68.4,
      bmi: null,
      measuredAt: repository.stored.startedAt,
      recordedBy: { id: USER, name: 'Carmen Salazar' },
      correctedBy: null,
      correctedAt: null,
    });
    const discharge = () => {
      repository.stored = anEncounter({
        status: 'DISCHARGED',
        endedAt: repository.stored.startedAt,
        dischargeCondition: 'ALIVE',
      });
      repository.taken = taking();
    };

    it('EN-228 rechaza con 403 a enfermería tras el alta, sin escribir nada', async () => {
      discharge();

      await expect(
        service.recordVitals('encounter-1', { weightKg: 68.1 }, nurse),
      ).rejects.toBeInstanceOf(VitalsCorrectionRequiresSignatureError);
      expect(repository.savedVitals).toEqual([]);
      expect(audit.entries).toEqual([]);
    });

    it('EN-228 rechaza también a quien firma historia solo en OTRA sede', async () => {
      discharge();

      await expect(
        service.recordVitals(
          'encounter-1',
          { weightKg: 68.1 },
          { ...nurse, signSites: ['site-2'] },
        ),
      ).rejects.toBeInstanceOf(VitalsCorrectionRequiresSignatureError);
    });

    it('EN-228 deja corregir a quien firma historia en la sede, y se lo dice al adaptador para que lo vuelva a preguntar bajo el candado', async () => {
      discharge();

      await service.recordVitals(
        'encounter-1',
        { weightKg: 68.1 },
        { ...nurse, signSites: [SITE] },
      );
      await service.recordVitals(
        'encounter-1',
        { weightKg: 68.2 },
        { ...nurse, signSites: 'all' },
      );
      expect(repository.correctionAuthority).toEqual([
        { mayCorrectAfterDischarge: true },
        { mayCorrectAfterDischarge: true },
      ]);
    });

    it('EN-228 D-140.4 tras el alta, quien firma en la sede sin perfil de profesional recibe PRACTITIONER_PROFILE_REQUIRED y la toma queda intacta', async () => {
      discharge();
      repository.practitioner = null;

      await expect(
        service.recordVitals('encounter-1', { weightKg: 68.1 }, { ...nurse, signSites: [SITE] }), // prettier-ignore
      ).rejects.toBeInstanceOf(PractitionerProfileRequiredError);
      expect(repository.savedVitals).toEqual([]);
      expect(audit.entries).toEqual([]);
    });

    it('EN-228 D-140.4 tras el alta, con el registro ACESS vencido el día clínico de hoy, PRACTITIONER_NOT_LICENSED y la toma queda intacta', async () => {
      discharge();
      repository.practitioner = {
        practitionerId: PRACTITIONER,
        acessExpiresOn: new Date(Date.now() - 3 * 24 * 3_600_000),
      };

      await expect(
        service.recordVitals('encounter-1', { weightKg: 68.1 }, { ...nurse, signSites: [SITE] }), // prettier-ignore
      ).rejects.toBeInstanceOf(PractitionerNotLicensedError);
      expect(repository.savedVitals).toEqual([]);

      // Positive control: the same correction with the registration in force.
      repository.practitioner = {
        practitionerId: PRACTITIONER,
        acessExpiresOn: new Date(Date.now() + 30 * 24 * 3_600_000),
      };
      await service.recordVitals('encounter-1', { weightKg: 68.1 }, { ...nurse, signSites: [SITE] }); // prettier-ignore
      expect(repository.savedVitals).toHaveLength(1);
    });

    it('EN-228 D-140.4 antes del alta no se mira la licencia, pero el adaptador sabe por qué no podría corregir tras el alta', async () => {
      repository.taken = taking();
      repository.practitioner = {
        practitionerId: PRACTITIONER,
        acessExpiresOn: new Date(Date.now() - 3 * 24 * 3_600_000),
      };

      await service.recordVitals('encounter-1', { weightKg: 68.1 }, { ...nurse, signSites: [SITE] }); // prettier-ignore
      repository.practitioner = null;
      await service.recordVitals('encounter-1', { weightKg: 68.2 }, { ...nurse, signSites: [SITE] }); // prettier-ignore

      expect(repository.savedVitals).toHaveLength(2);
      expect(repository.correctionAuthority).toEqual([
        { mayCorrectAfterDischarge: false, afterDischargeRefusal: 'NOT_LICENSED' },
        { mayCorrectAfterDischarge: false, afterDischargeRefusal: 'NO_PRACTITIONER_PROFILE' },
      ]); // prettier-ignore
    });

    it('EN-228 antes del alta basta vitals:write (control positivo), y el adaptador sabe que esa cuenta no corrige tras el alta', async () => {
      repository.taken = taking();

      await service.recordVitals('encounter-1', { weightKg: 68.1 }, nurse);
      expect(repository.savedVitals).toHaveLength(1);
      expect(repository.correctionAuthority).toEqual([
        {
          mayCorrectAfterDischarge: false,
          afterDischargeRefusal: 'NOT_SIGNER',
        },
      ]);
    });
  });

  it('EN-060 conserva el instante de la TOMA, que no es el del tecleo', () => {
    // Nursing weighs at 08:10 and the network returns at 08:40: a record that
    // says 08:40 has quietly moved a fact.
    const measuredAt = new Date('2026-09-14T13:10:00Z');

    return service
      .recordVitals('encounter-1', { weightKg: 68.4, measuredAt }, nurse)
      .then(() => {
        expect(repository.savedVitals[0]?.measuredAt).toEqual(measuredAt);
      });
  });
});
