import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type {
  ActiveAllergy,
  ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import type {
  ChartSummaryQuery,
  ChartSummaryRepository,
  PreviousEncounterSummary,
} from '../domain/chart-summary.repository';
import type {
  EncounterQuery,
  EncounterRepository,
  EncounterView,
} from '../domain/encounter.repository';
import { EncounterNotFoundError } from '../domain/encounter.errors';
import type {
  AllergyAbsenceAssertion,
  PatientAllergyRepository,
} from '../domain/patient-allergy.repository';
import { ChartSummaryService } from './chart-summary.service';
import type { Requester } from './encounter.service';

/**
 * EN-159 to EN-161. The history a doctor has in front of them, as a use case.
 *
 * WHAT A DOUBLE PROVES HERE: that the chart comes off the ATTENTION and never
 * off the request, that today's consultation is not listed as its own history,
 * that the list is bounded and says how much it left out, that ONE audit row
 * is written and not one per attention, and — the requirement that is an
 * absence — that no note text ever travels.
 *
 * ⚠️ NOT HERE: that the reads follow a merged chart (PA-055). A double answers
 * whatever it was told to; that one is exercised against a real PostgreSQL in
 * `test/integration/encounter-chart-summary.spec.ts`.
 */

const SITE = 'site-1';
const ENCOUNTER = 'encounter-today';
const PATIENT = 'patient-1';

const requester: Requester = {
  userId: 'user-1',
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
  patientId: PATIENT,
  agendaEntryId: null,
  startedAt: new Date('2026-08-20T14:00:00Z'),
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

const aPrevious = (
  overrides: Partial<PreviousEncounterSummary> = {},
): PreviousEncounterSummary => ({
  id: 'encounter-old',
  siteId: SITE,
  startedAt: new Date('2026-05-11T14:00:00Z'),
  status: 'COMPLETED',
  careModality: 'MORBIDITY',
  careSetting: 'INTRAMURAL',
  visitSequence: 'FIRST_TIME',
  dischargeCondition: 'ALIVE',
  diagnoses: [
    {
      cie10Code: 'J020',
      cie10Display: 'Faringitis estreptocócica',
      certainty: 'DEFINITIVE',
      rank: 1,
    },
  ],
  vitals: {
    weightKg: 68.4,
    heightCm: 165,
    bmi: 25.13,
    systolicBp: 120,
    diastolicBp: 80,
    temperatureC: 36.8,
    measuredAt: new Date('2026-05-11T14:05:00Z'),
  },
  ...overrides,
});

class FakeEncounters {
  stored: EncounterView | null = anEncounter();

  findById(query: EncounterQuery): Promise<EncounterView | null> {
    if (this.stored === null) return Promise.resolve(null);
    const inScope =
      query.sites === 'all' || query.sites.includes(this.stored.siteId);
    return Promise.resolve(
      query.encounterId === this.stored.id && inScope ? this.stored : null,
    );
  }
}

class FakeSummaries implements ChartSummaryRepository {
  queries: ChartSummaryQuery[] = [];
  rows: PreviousEncounterSummary[] = [aPrevious()];
  total = 1;

  previousEncounters(
    query: ChartSummaryQuery,
  ): Promise<PreviousEncounterSummary[]> {
    this.queries.push(query);
    return Promise.resolve(this.rows.slice(0, query.limit));
  }

  countEncounters(query: ChartSummaryQuery): Promise<number> {
    this.queries.push(query);
    return Promise.resolve(this.total);
  }
}

class FakeActiveReader implements ActiveAllergyReader {
  asked: string[] = [];
  rows: ActiveAllergy[] = [
    {
      id: 'allergy-1',
      patientId: PATIENT,
      substanceConceptId: 'cnmb-1',
      substanceText: 'Penicilina',
      reaction: 'Anafilaxia',
      criticality: 'HIGH',
      recordedAt: new Date('2026-05-11T14:20:00Z'),
    },
  ];

  activeFor(chartId: string): Promise<readonly ActiveAllergy[]> {
    this.asked.push(chartId);
    return Promise.resolve(this.rows);
  }
}

/**
 * EN-087. Only `standingAbsenceFor`, which is the one method this read model
 * calls.
 *
 * The four write methods throw rather than returning something plausible: a
 * read model that quietly wrote an allergy is a defect a double should make
 * loud, not absorb.
 */
class FakeAllergyRecords {
  asked: string[] = [];
  standing: AllergyAbsenceAssertion | null = null;

  standingAbsenceFor(chartId: string): Promise<AllergyAbsenceAssertion | null> {
    this.asked.push(chartId);
    return Promise.resolve(this.standing);
  }
}

const anAssertion = (
  overrides: Partial<AllergyAbsenceAssertion> = {},
): AllergyAbsenceAssertion => ({
  id: 'absence-1',
  patientId: PATIENT,
  assertedById: 'user-9',
  assertedByName: 'Ana Villacís',
  assertedAt: new Date('2026-03-14T15:00:00Z'),
  ...overrides,
});

describe('la historia a la vista durante la consulta', () => {
  let encounters: FakeEncounters;
  let summaries: FakeSummaries;
  let reader: FakeActiveReader;
  let allergyRecords: FakeAllergyRecords;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: ChartSummaryService;

  beforeEach(() => {
    encounters = new FakeEncounters();
    summaries = new FakeSummaries();
    reader = new FakeActiveReader();
    allergyRecords = new FakeAllergyRecords();
    const entries: AccessAuditEntry[] = [];
    audit = {
      entries,
      record: (entry: AccessAuditEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };

    service = new ChartSummaryService(
      summaries,
      reader,
      allergyRecords as unknown as PatientAllergyRepository,
      encounters as unknown as EncounterRepository,
      audit,
    );
  });

  it('EN-159 devuelve alergias, atenciones anteriores y sus signos vitales en UNA respuesta', async () => {
    /**
     * Paso 4 del flujo: «mientras atiende, tiene delante la historia entera…
     * eso no es una pantalla aparte a la que hay que ir: es parte de la
     * consulta». Una pantalla que tiene que acordarse de pedir cinco cosas es
     * una que un día pide cuatro, y la que falta es la alergia.
     */
    const summary = await service.forEncounter(ENCOUNTER, requester);

    expect(summary.allergies).toHaveLength(1);
    expect(summary.allergies[0]?.substanceText).toBe('Penicilina');
    expect(summary.previousEncounters[0]?.diagnoses[0]?.cie10Code).toBe('J020');
    expect(summary.previousEncounters[0]?.vitals?.weightKg).toBe(68.4);
  });

  it('EN-159 toma la ficha de la ATENCIÓN y nunca de la petición', async () => {
    // Un `patientId` que el llamante pudiera nombrar convertiría un
    // `record:read` de una sede en una forma de leer los diagnósticos de
    // cualquier ficha de la clínica.
    await service.forEncounter(ENCOUNTER, requester);

    expect(reader.asked).toEqual([PATIENT]);
    expect(summaries.queries.every((q) => q.patientId === PATIENT)).toBe(true);
  });

  it('EN-159 excluye la atención en curso de «las anteriores»', async () => {
    await service.forEncounter(ENCOUNTER, requester);

    expect(
      summaries.queries.every((q) => q.excludeEncounterId === ENCOUNTER),
    ).toBe(true);
  });

  it('EN-159 acota la lista y dice cuántas hay en total, para que el recorte se vea', async () => {
    /**
     * §7 bis: el problema documentado no es falta de datos, es fragmentación,
     * y un recorte que el lector no ve es una historia que parece más corta de
     * lo que es.
     */
    summaries.rows = Array.from({ length: 9 }, (_unused, index) =>
      aPrevious({ id: `encounter-${String(index)}` }),
    );
    summaries.total = 23;

    const summary = await service.forEncounter(ENCOUNTER, requester);

    expect(summary.previousEncounters).toHaveLength(5);
    expect(summary.totalEncounters).toBe(23);
  });

  it('EN-160 no lleva el texto de ninguna nota anterior: enlaza, no pega', async () => {
    /**
     * De una nota clínica de hoy, el 18% lo escribió su autor; el 46% está
     * copiado y el 36% importado, y cada 1% de texto importado añade 1,5% de
     * longitud. Lo que viaja aquí es el identificador de la atención, que se
     * abre por su propia ruta y deja su propia fila de bitácora.
     */
    const summary = await service.forEncounter(ENCOUNTER, requester);
    const previous = summary.previousEncounters[0];

    expect(previous?.id).toBe('encounter-old');
    expect(Object.keys(previous ?? {})).not.toContain('notes');
    expect(Object.keys(previous ?? {})).not.toContain('content');
    // Y tampoco antecedentes: falta esquema (EN-085) y un campo vacío se
    // leería como «no consta ninguno».
    expect(Object.keys(summary)).not.toContain('antecedentes');
  });

  it('EN-161 deja UNA fila de bitácora y no una por atención listada', async () => {
    /**
     * Abrir la historia de un paciente es el acto que se registra (EN-122), y
     * esto lleva diagnósticos. Lo que no puede hacer es dejar cuarenta filas
     * que no dicen nada y enterrar los accesos que importan (EN-123).
     */
    summaries.rows = Array.from({ length: 5 }, (_unused, index) =>
      aPrevious({ id: `encounter-${String(index)}` }),
    );

    await service.forEncounter(ENCOUNTER, requester);

    expect(audit.entries).toEqual([
      expect.objectContaining({
        resourceType: 'patient_chart_summary',
        resourceId: PATIENT,
        action: 'READ',
      }),
    ]);
  });

  it('EN-121 no audita ni responde una atención fuera del alcance del llamante', async () => {
    // Nada se divulgó, así que no hay acceso del que responder — y una fila
    // por identificador adivinado dejaría llenar el rastro de ruido.
    encounters.stored = anEncounter({ siteId: 'site-2' });

    await expect(
      service.forEncounter(ENCOUNTER, requester),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
    expect(audit.entries).toHaveLength(0);
  });

  it('EN-087 sirve «sin alergias conocidas» con quién y cuándo, junto a la lista y no en su lugar', async () => {
    /**
     * Es lo que convierte dos estados en tres. La lista vacía sola no
     * distingue «no tiene» de «no se preguntó», y el estándar es literal: «una
     * afirmación positiva por parte de un usuario clínico, y no una posición
     * por defecto afirmada por un sistema informático a falta de otra
     * información».
     */
    reader.rows = [];
    allergyRecords.standing = anAssertion();

    const summary = await service.forEncounter(ENCOUNTER, requester);

    expect(summary.allergies).toHaveLength(0);
    expect(summary.noKnownAllergies).toMatchObject({
      assertedByName: 'Ana Villacís',
      assertedAt: new Date('2026-03-14T15:00:00Z'),
    });
    // Preguntado por la ficha de la ATENCIÓN, como todo lo demás de esta
    // respuesta, y nunca por un identificador que el llamante pudiera nombrar.
    expect(allergyRecords.asked).toEqual([PATIENT]);
  });

  it('EN-087 sirve `null` cuando nadie lo afirmó: es «no se preguntó», no «no tiene»', async () => {
    // El sistema no rellena el hueco. Una ficha sin alergias y sin afirmación
    // es exactamente «no lo sabemos», y afirmar lo contrario es el falso
    // negativo que hace daño.
    reader.rows = [];
    allergyRecords.standing = null;

    const summary = await service.forEncounter(ENCOUNTER, requester);

    expect(summary.allergies).toHaveLength(0);
    expect(summary.noKnownAllergies).toBeNull();
  });
});
