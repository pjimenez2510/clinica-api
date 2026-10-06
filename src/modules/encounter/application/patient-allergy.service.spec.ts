import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type {
  ActiveAllergy,
  ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  PatientAllergyNotFoundError,
  PatientChartNotOpenError,
} from '../domain/encounter.errors';
import type {
  AllergyAbsenceAssertion,
  AllergyVersionView,
  AllergyView,
  EditAllergy,
  NewAllergy,
  NewAllergyAbsence,
  PatientAllergyRepository,
  ReactivateAllergy,
  RefuteAllergy,
} from '../domain/patient-allergy.repository';
import type {
  EncounterRepository,
  PatientChartStatus,
} from '../domain/encounter.repository';
import { PatientAllergyService } from './patient-allergy.service';
import type { Requester } from './encounter.service';

/**
 * REQ-008's use cases, against in-memory ports.
 *
 * WHAT A DOUBLE CAN PROVE HERE is the list of things that are NOT database
 * guarantees: that nothing has a `delete`, that the criticality is never
 * invented, that a refutation with no reason is refused before it reaches
 * storage, what leaves a row in the access trail, and — the one that matters
 * most — that the active list a consultation sees comes from THE SAME reader a
 * prescription will use (EN-084).
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: that refuting does not DELETE (EN-082) and
 * that the reads follow a merged chart (PA-055). Neither can be shown with a
 * double — «que refutar no borre sólo se ve contando filas», says the SPEC —
 * and both are exercised in `test/integration/encounter-allergies.spec.ts`
 * against a real PostgreSQL.
 */

const PATIENT = 'patient-1';
const USER = 'user-1';

const requester: Requester = {
  userId: USER,
  sites: ['site-1'],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anAllergy = (overrides: Partial<AllergyView> = {}): AllergyView => ({
  id: 'allergy-1',
  patientId: PATIENT,
  substanceConceptId: null,
  substanceText: 'Penicilina',
  reaction: 'Urticaria',
  criticality: 'HIGH',
  recordedAt: new Date('2026-08-14T14:00:00Z'),
  refutedAt: null,
  refutedNotes: null,
  recordedBy: null,
  refutedBy: null,
  changedAt: null,
  ...overrides,
});

/** Only the one method the service uses: `findPatientChart`. */
class FakeEncounters {
  chart: PatientChartStatus | null = { id: PATIENT, mergedIntoId: null };

  findPatientChart(patientId: string): Promise<PatientChartStatus | null> {
    return Promise.resolve(
      this.chart !== null && this.chart.id === patientId ? this.chart : null,
    );
  }
}

class FakeAllergies implements PatientAllergyRepository {
  written: NewAllergy[] = [];
  refutations: RefuteAllergy[] = [];
  rows: AllergyView[] = [];
  /** `null` reproduces «no está en esta ficha ni en las que absorbió». */
  refuteAnswer: AllergyView | null = anAllergy({
    refutedAt: new Date('2026-08-20T10:00:00Z'),
    refutedNotes: 'Prueba cutánea negativa',
  });

  record(allergy: NewAllergy): Promise<AllergyView> {
    this.written.push(allergy);
    const view = anAllergy({
      id: `allergy-${String(this.written.length)}`,
      patientId: allergy.patientId,
      substanceConceptId: allergy.substanceConceptId ?? null,
      substanceText: allergy.substanceText,
      reaction: allergy.reaction ?? null,
      criticality: allergy.criticality,
    });
    this.rows.push(view);
    return Promise.resolve(view);
  }

  refute(refutation: RefuteAllergy): Promise<AllergyView | null> {
    this.refutations.push(refutation);
    return Promise.resolve(this.refuteAnswer);
  }

  listFor(): Promise<AllergyView[]> {
    return Promise.resolve(this.rows);
  }

  /** EN-087. What was asserted, so the test can read the author back. */
  absences: NewAllergyAbsence[] = [];

  assertNoKnownAllergies(
    assertion: NewAllergyAbsence,
  ): Promise<AllergyAbsenceAssertion> {
    this.absences.push(assertion);
    return Promise.resolve({
      id: `absence-${String(this.absences.length)}`,
      patientId: assertion.patientId,
      assertedById: assertion.assertedById,
      assertedByName: 'Ana Villacís',
      assertedAt: new Date('2026-08-20T15:00:00Z'),
    });
  }

  /** EN-087. `null` reproduce «no se preguntó», que es el estado por defecto. */
  standing: AllergyAbsenceAssertion | null = null;

  standingAbsenceFor(): Promise<AllergyAbsenceAssertion | null> {
    return Promise.resolve(this.standing);
  }

  /** EN-225. What was asked to change; `null` reproduces «no está». */
  edits: EditAllergy[] = [];
  editAnswer: AllergyView | null = anAllergy({ criticality: 'LOW' });

  edit(edit: EditAllergy): Promise<AllergyView | null> {
    this.edits.push(edit);
    return Promise.resolve(this.editAnswer);
  }

  /** EN-224. Who reactivated; `null` reproduces «no está». */
  reactivations: ReactivateAllergy[] = [];
  reactivateAnswer: AllergyView | null = anAllergy();

  reactivate(reactivation: ReactivateAllergy): Promise<AllergyView | null> {
    this.reactivations.push(reactivation);
    return Promise.resolve(this.reactivateAnswer);
  }

  versions: AllergyVersionView[] | null = [];

  versionsOf(): Promise<AllergyVersionView[] | null> {
    return Promise.resolve(this.versions);
  }

  refuteAndAssertNoKnownAllergies(): Promise<AllergyAbsenceAssertion> {
    return Promise.reject(new Error('not used by this service'));
  }

  retractNoKnownAllergies(): Promise<boolean> {
    return Promise.reject(new Error('not used by this service'));
  }
}

class FakeActiveReader implements ActiveAllergyReader {
  asked: string[] = [];
  /**
   * Built as an `ActiveAllergy` and NOT as an `AllergyView` with two nulls:
   * the shape is half the requirement, and a double that carried the refuted
   * columns would make the assertion below pass for the wrong reason.
   */
  rows: ActiveAllergy[] = [
    {
      id: 'allergy-1',
      patientId: PATIENT,
      substanceConceptId: 'cnmb-1',
      substanceText: 'Penicilina',
      reaction: 'Urticaria',
      criticality: 'HIGH',
      recordedAt: new Date('2026-08-14T14:00:00Z'),
    },
  ];

  activeFor(chartId: string): Promise<readonly ActiveAllergy[]> {
    this.asked.push(chartId);
    return Promise.resolve(this.rows);
  }
}

describe('las alergias del paciente', () => {
  let encounters: FakeEncounters;
  let allergies: FakeAllergies;
  let reader: FakeActiveReader;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: PatientAllergyService;

  beforeEach(() => {
    encounters = new FakeEncounters();
    allergies = new FakeAllergies();
    reader = new FakeActiveReader();
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

    service = new PatientAllergyService(
      allergies,
      reader,
      encounters as unknown as EncounterRepository,
      audit,
      logger,
    );
  });

  const aRequest = (overrides: Record<string, unknown> = {}) => ({
    patientId: PATIENT,
    substanceText: 'Penicilina',
    criticality: 'HIGH' as const,
    ...overrides,
  });

  it('EN-080 registra la alergia de forma estructurada: sustancia, reacción y criticidad', async () => {
    /**
     * La razón está escrita en el esquema: «estructurada y no enterrada en el
     * JSON del formulario 002 porque prescribir tiene que comprobarla, y
     * comprobarla significa una consulta, no una persona leyendo prosa».
     */
    const recorded = await service.record(
      aRequest({
        substanceConceptId: 'cnmb-concept-1',
        reaction: 'Angioedema',
      }),
      requester,
    );

    expect(allergies.written[0]).toMatchObject({
      patientId: PATIENT,
      substanceConceptId: 'cnmb-concept-1',
      substanceText: 'Penicilina',
      reaction: 'Angioedema',
      criticality: 'HIGH',
    });
    expect(recorded.substanceText).toBe('Penicilina');
  });

  it('EN-083 no inventa la criticidad: escribe la que le dieron y nada más', async () => {
    // El valor por defecto tiene que decir «no se sabe», no «es leve». Lo que
    // ningún camino de código hace es convertir una respuesta ausente en
    // `LOW`: el DTO la exige y el servicio la pasa tal cual.
    await service.record(
      aRequest({ criticality: 'UNABLE_TO_ASSESS' }),
      requester,
    );

    expect(allergies.written[0]?.criticality).toBe('UNABLE_TO_ASSESS');
  });

  it('EN-001 no escribe una alergia en una ficha absorbida por una fusión', async () => {
    // Se puede LEER a través del enlace y no se puede ESCRIBIR: lo escrito
    // hoy sobre la ficha absorbida se marcharía con la persona equivocada el
    // día que la fusión se deshaga.
    encounters.chart = { id: PATIENT, mergedIntoId: 'survivor-1' };

    await expect(service.record(aRequest(), requester)).rejects.toBeInstanceOf(
      PatientChartNotOpenError,
    );
    expect(allergies.written).toHaveLength(0);
  });

  it('EN-086 escribe en la fila a quien registra la alergia, desde la sesion, y deja la bitacora', async () => {
    /**
     * «¿Quién dijo que era alérgico?» se contesta desde la fila
     * (`recorded_by`), y el autor sale de la sesión —nunca del cuerpo—. La
     * bitácora sigue: es la que responde por las filas anteriores a la
     * columna.
     */
    const recorded = await service.record(aRequest(), requester);

    expect(allergies.written.map((row) => row.recordedById)).toEqual([USER]);

    expect(audit.entries).toEqual([
      expect.objectContaining({
        userId: USER,
        resourceType: 'patient_allergy',
        resourceId: recorded.id,
        action: 'CREATE',
      }),
    ]);
  });

  it('EN-082 refuta con motivo y no borra: el servicio nunca pide una eliminación', async () => {
    const refuted = await service.refute(
      {
        patientId: PATIENT,
        allergyId: 'allergy-1',
        notes: 'Prueba cutánea negativa',
      },
      requester,
    );

    expect(allergies.refutations[0]).toMatchObject({
      patientId: PATIENT,
      allergyId: 'allergy-1',
      notes: 'Prueba cutánea negativa',
      // EN-086. Quién la descartó, desde la sesión.
      refutedById: USER,
    });
    expect(refuted.refutedAt).not.toBeNull();
    // No hay método de borrado en el puerto, y esta es la comprobación de que
    // el servicio no puede haber llamado a uno.
    expect(Object.keys(allergies)).not.toContain('deleted');
  });

  it('EN-224 descarta sin motivo, y un motivo en blanco viaja como ninguno', async () => {
    // D-126.2: una confirmación y un motivo opcional de lista. Quién y cuándo
    // los guarda la fila; lo que había, la versión.
    await service.refute({ patientId: PATIENT, allergyId: 'allergy-1' }, requester); // prettier-ignore
    await service.refute(
      { patientId: PATIENT, allergyId: 'allergy-1', notes: '   ' },
      requester,
    );
    await service.refute(
      {
        patientId: PATIENT,
        allergyId: 'allergy-1',
        notes: ' Prueba negativa ',
      },
      requester,
    );

    expect(allergies.refutations.map((r) => r.notes)).toEqual([
      null,
      null,
      'Prueba negativa',
    ]);
  });

  it('EN-082 responde una sola negativa cuando la alergia no está en esa ficha', async () => {
    // «No existe» y «es de otra ficha» contestan lo mismo: distinguirlas
    // confirmaría, de una en una, que cierto identificador es una alergia de
    // la historia de otra persona.
    allergies.refuteAnswer = null;

    await expect(
      service.refute(
        { patientId: PATIENT, allergyId: 'otra', notes: 'motivo' },
        requester,
      ),
    ).rejects.toBeInstanceOf(PatientAllergyNotFoundError);
  });

  it('EN-084 sirve las alergias activas por el MISMO lector que comprobará la prescripción', async () => {
    /**
     * No es una preferencia de estilo: dos consultas del mismo predicado
     * acaban discrepando, y en lo que discreparían es en el alcance de ficha
     * — la alergia a la penicilina de la ficha absorbida que deja de verse.
     */
    const active = await service.activeFor(PATIENT);

    expect(reader.asked).toEqual([PATIENT]);
    expect(active).toHaveLength(1);
    // Y el lector compartido no expone el motivo de una refutación: no es
    // asunto de quien prescribe.
    expect(Object.keys(active[0] ?? {})).not.toContain('refutedNotes');
  });

  it('EN-084 no deja fila de bitácora al servir las activas: la deja el acto que las pidió', async () => {
    // Sus llamadores auditan lo que están haciendo —abrir la atención
    // (EN-122) o leer el resumen (EN-161)—. Una entrada aquí duplicaría todas.
    await service.activeFor(PATIENT);

    expect(audit.entries).toHaveLength(0);
  });

  it('EN-080 audita el listado completo, que es la única lista del módulo que se audita', async () => {
    /**
     * EN-123 deja los listados fuera del rastro porque llevan identificadores
     * y ningún contenido clínico. Éste lo rompe a propósito: una alergia ES
     * contenido clínico. Una entrada por LECTURA, nunca una por fila.
     */
    allergies.rows = [anAllergy(), anAllergy({ id: 'allergy-2' })];

    const chart = await service.listFor(PATIENT, requester);

    expect(chart.allergies).toHaveLength(2);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        resourceType: 'patient_allergy',
        resourceId: PATIENT,
        action: 'READ',
      }),
    ]);
  });

  it('EN-087 el listado sirve la afirmación de ausencia con su autor y su instante', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SON TRES ESTADOS Y EL LISTADO SÓLO PODÍA PINTAR DOS
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `nilknown` es «una afirmación positiva por parte de un usuario clínico,
     * y no una posición por defecto afirmada por un sistema informático a
     * falta de otra información». Sin este campo, la ficha del paciente no
     * puede distinguir «sin alergias conocidas, afirmado por la Dra. X el
     * 14-03-2026» de «nadie lo preguntó»: las dos llegaban como una lista
     * vacía. Es el mismo par que `chart-summary` ya sirve (EN-159).
     */
    allergies.rows = [];
    allergies.standing = {
      id: 'absence-1',
      patientId: PATIENT,
      assertedById: USER,
      assertedByName: 'Ana Villacís',
      assertedAt: new Date('2026-03-14T15:00:00Z'),
    };

    const chart = await service.listFor(PATIENT, requester);

    expect(chart.allergies).toEqual([]);
    expect(chart.noKnownAllergies?.assertedByName).toBe('Ana Villacís');
    expect(chart.noKnownAllergies?.assertedAt).toBeInstanceOf(Date);
  });

  it('EN-087 el listado vacío sin afirmación dice «no se preguntó» y no «no tiene»', async () => {
    // La dirección segura: ante la duda, la pantalla cae del lado de «no
    // registradas». Lo que este campo añade es poder decir la verdad cuando
    // alguien SÍ lo afirmó, no cambiar lo que se dice cuando nadie lo hizo.
    allergies.rows = [];

    const chart = await service.listFor(PATIENT, requester);

    expect(chart.allergies).toEqual([]);
    expect(chart.noKnownAllergies).toBeNull();
  });

  it('EN-087 no duplica la fila de bitácora por servir la afirmación junto a la lista', async () => {
    // Una entrada por LECTURA, nunca una por fila ni una por mitad de la
    // respuesta: es la misma divulgación y el mismo acto (EN-123).
    allergies.rows = [anAllergy()];
    allergies.standing = null;

    await service.listFor(PATIENT, requester);

    expect(audit.entries).toHaveLength(1);
  });

  it('EN-225 edita la alergia con el autor de la SESIÓN y deja la bitácora como actualización', async () => {
    const edited = await service.edit(
      {
        patientId: PATIENT,
        allergyId: 'allergy-1',
        changes: { criticality: 'LOW' },
      },
      requester,
    );

    expect(allergies.edits).toEqual([
      expect.objectContaining({
        patientId: PATIENT,
        allergyId: 'allergy-1',
        changes: { criticality: 'LOW' },
        editedById: USER,
      }),
    ]);
    expect(allergies.edits[0]?.now).toBeInstanceOf(Date);
    expect(edited.criticality).toBe('LOW');
    expect(audit.entries).toEqual([
      expect.objectContaining({
        resourceType: 'patient_allergy',
        resourceId: 'allergy-1',
        action: 'UPDATE',
      }),
    ]);
  });

  it('EN-225 responde una sola negativa al editar o reactivar una alergia que no está en esa ficha', async () => {
    allergies.editAnswer = null;
    allergies.reactivateAnswer = null;
    allergies.versions = null;

    await expect(
      service.edit(
        { patientId: PATIENT, allergyId: 'otra', changes: { reaction: null } },
        requester,
      ),
    ).rejects.toBeInstanceOf(PatientAllergyNotFoundError);
    await expect(
      service.reactivate(PATIENT, 'otra', requester),
    ).rejects.toBeInstanceOf(PatientAllergyNotFoundError);
    await expect(
      service.versionsOf(PATIENT, 'otra', requester),
    ).rejects.toBeInstanceOf(PatientAllergyNotFoundError);
    expect(audit.entries).toHaveLength(0);
  });

  it('EN-224 reactiva con quien está en la sesión, sin exigir una ficha abierta', async () => {
    // Corrige algo que ya está en la ficha: alcanzable desde la superviviente.
    encounters.chart = null;

    const back = await service.reactivate(PATIENT, 'allergy-1', requester);

    expect(allergies.reactivations[0]).toMatchObject({
      patientId: PATIENT,
      allergyId: 'allergy-1',
      reactivatedById: USER,
    });
    expect(back.refutedAt).toBeNull();
    expect(audit.entries[0]?.action).toBe('UPDATE');
  });

  it('EN-225 sirve las versiones y deja la lectura en la bitácora', async () => {
    allergies.versions = [
      {
        version: 1,
        replacedBy: { id: USER, name: 'Ana Villacís' },
        replacedAt: new Date(),
        allergy: anAllergy({ substanceText: 'Penisilina' }),
      },
    ];

    const versions = await service.versionsOf(PATIENT, 'allergy-1', requester);

    expect(versions.map((v) => v.allergy.substanceText)).toEqual([
      'Penisilina',
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({ resourceId: 'allergy-1', action: 'READ' }),
    ]);
  });
});
