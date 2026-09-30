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
import { PrescriptionService } from './prescription.service';
import type {
  DiscardPlan,
  IssuePlan,
  IssueSnapshot,
  NewPrescription,
  PrescribingEncounter,
  PrescriberIdentity,
  PrescriptionQuery,
  PrescriptionRecordSource,
  PrescriptionRepository,
  PrescriptionView,
} from '../domain/prescription.repository';
import type { PrescriptionStatus } from '../domain/prescription';
import type { Requester } from './prescription.service';

/**
 * The prescription's use cases, against an in-memory port.
 *
 * WHAT A DOUBLE CAN PROVE HERE is exactly the list of things that are NOT
 * database guarantees: the ORDER of the refusals, which act leaves a row in the
 * access trail and which deliberately does not, that the prescriber is the
 * session and never an identifier in the request, and that an alert informs
 * while composing and interrupts while issuing.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: the two `CHECK`s, the frozen DCI, the
 * catalogue of the concept and the chart scope across a merge. All four are
 * PostgreSQL's, and a double returning what we asked it for would prove none of
 * them — they are exercised in `test/integration/prescription-issue.spec.ts`
 * against a real database.
 */

const SITE = 'site-1';
const ENCOUNTER = 'encounter-1';
const PRESCRIPTION = 'prescription-1';
const USER = 'user-1';
const PRACTITIONER = 'practitioner-1';
const AMOXICILLIN = 'concept-amoxicillin';

const requester: Requester = {
  userId: USER,
  sites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anEncounter = (
  overrides: Partial<PrescribingEncounter> = {},
): PrescribingEncounter => ({
  id: ENCOUNTER,
  siteId: SITE,
  patientId: 'patient-1',
  status: 'OPEN',
  startedAt: new Date('2026-09-14T14:00:00Z'),
  ...overrides,
});

const aPrescriber = (
  overrides: Partial<PrescriberIdentity> = {},
): PrescriberIdentity => ({
  practitionerId: PRACTITIONER,
  givenName: 'Ana',
  familyName: 'Villacís',
  acessRegistration: 'ACESS-11223',
  acessExpiresOn: new Date('2030-01-01T00:00:00Z'),
  ...overrides,
});

const aPrescription = (
  overrides: Partial<PrescriptionView> = {},
): PrescriptionView => ({
  id: PRESCRIPTION,
  encounterId: ENCOUNTER,
  prescriberId: PRACTITIONER,
  status: 'DRAFT',
  issuedAt: null,
  verificationCode: null,
  createdAt: new Date('2026-09-14T14:05:00Z'),
  discardedAt: null,
  discardReason: null,
  items: [
    {
      id: 'item-1',
      line: 1,
      conceptId: AMOXICILLIN,
      genericName: 'Amoxicilina',
      presentation: 'Cápsula',
      concentration: '500 mg',
      routeCode: 'ORAL',
      quantity: 20,
      doseText: '1 cápsula',
      frequencyText: 'Cada 8 horas',
      durationDays: 7,
      instructions: null,
      offFormularyJustification: null,
    },
  ],
  ...overrides,
});

const aSnapshot = (overrides: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  status: 'DRAFT',
  items: aPrescription().items.map((item) => ({
    line: item.line,
    genericName: item.genericName,
    presentation: item.presentation,
    concentration: item.concentration,
    routeCode: item.routeCode,
    quantity: item.quantity,
    doseText: item.doseText,
    frequencyText: item.frequencyText,
    durationDays: item.durationDays,
    conceptId: item.conceptId,
    offFormularyJustification: item.offFormularyJustification,
  })),
  allergies: [],
  cityOfPrescription: 'Quito',
  prescriber: {
    acessRegistration: 'ACESS-11223',
    acessExpiresOn: new Date('2030-01-01T00:00:00Z'),
  },
  ...overrides,
});

class FakeRepository implements PrescriptionRepository {
  encounter: PrescribingEncounter | null = anEncounter();
  prescriber: PrescriberIdentity | null = aPrescriber();
  snapshot: IssueSnapshot = aSnapshot();
  document: PrescriptionRecordSource | null = null;
  created: NewPrescription | undefined;
  discarded: DiscardPlan | undefined;
  listed = 0;

  findEncounterForPrescribing(): Promise<PrescribingEncounter | null> {
    return Promise.resolve(this.encounter);
  }

  findPrescriberByUser(): Promise<PrescriberIdentity | null> {
    return Promise.resolve(this.prescriber);
  }

  create(prescription: NewPrescription): Promise<PrescriptionView> {
    this.created = prescription;
    return Promise.resolve(aPrescription());
  }

  findById(): Promise<PrescriptionView | null> {
    return Promise.resolve(aPrescription());
  }

  listOfEncounter(): Promise<PrescriptionView[]> {
    this.listed += 1;
    return Promise.resolve([aPrescription()]);
  }

  issue(
    _query: PrescriptionQuery,
    decide: (snapshot: IssueSnapshot) => IssuePlan,
  ): Promise<PrescriptionView> {
    const plan = decide(this.snapshot);
    return Promise.resolve(
      aPrescription({
        status: 'ACTIVE',
        issuedAt: plan.issuedAt,
        verificationCode: plan.verificationCode,
      }),
    );
  }

  cancel(
    _query: PrescriptionQuery,
    decide: (status: PrescriptionStatus) => void,
  ): Promise<PrescriptionView> {
    decide(this.snapshot.status);
    return Promise.resolve(aPrescription({ status: 'CANCELLED' }));
  }

  discard(
    _query: PrescriptionQuery,
    plan: DiscardPlan,
    decide: (status: PrescriptionStatus) => void,
  ): Promise<PrescriptionView> {
    decide(this.snapshot.status);
    this.discarded = plan;
    return Promise.resolve(
      aPrescription({
        status: 'DISCARDED',
        discardedAt: plan.discardedAt,
        discardReason: plan.discardReason,
      }),
    );
  }

  documentOf(): Promise<PrescriptionRecordSource | null> {
    return Promise.resolve(this.document);
  }
}

/**
 * PR-062. The shared reader, as a double.
 *
 * ⚠️ IT IS A PORT OF `shared/` AND NOT OF THIS MODULE, which is why it arrives
 * as its own constructor argument: «las alergias activas de una ficha» is one
 * statement for the whole system, and what a double can show here is only that
 * the service ASKS it — that the answer resolves the merge link is proved
 * against a real database in `test/integration/prescription-issue.spec.ts`.
 */
class FakeAllergyReader implements ActiveAllergyReader {
  allergies: ActiveAllergy[] = [];

  activeFor(): Promise<readonly ActiveAllergy[]> {
    return Promise.resolve(this.allergies);
  }
}

const anAllergy = (
  substanceConceptId: string | null,
  overrides: Partial<ActiveAllergy> = {},
): ActiveAllergy => ({
  id: 'allergy-1',
  patientId: 'patient-1',
  substanceConceptId,
  substanceText: 'Amoxicilina',
  reaction: null,
  criticality: 'HIGH',
  recordedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('el servicio de recetas', () => {
  let repository: FakeRepository;
  let allergyReader: FakeAllergyReader;
  let entries: AccessAuditEntry[];
  let service: PrescriptionService;

  beforeEach(() => {
    repository = new FakeRepository();
    allergyReader = new FakeAllergyReader();
    entries = [];
    const audit: AccessAuditRecorder = {
      record: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
    const logger = { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger; // prettier-ignore
    service = new PrescriptionService(repository, allergyReader, audit, logger);
  });

  const composeRequest = {
    encounterId: ENCOUNTER,
    items: [
      {
        conceptId: AMOXICILLIN,
        genericName: null,
        presentation: 'Cápsula',
        concentration: '500 mg',
        routeCode: 'ORAL',
        quantity: 20,
        doseText: '1 cápsula',
        frequencyText: 'Cada 8 horas',
        durationDays: 7,
        instructions: null,
        offFormularyJustification: null,
      },
    ],
  };

  it('PR-001 rechaza componer sobre una atención que no existe o es de otra sede', async () => {
    repository.encounter = null;

    await expect(
      service.compose(composeRequest, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_ENCOUNTER_NOT_FOUND' });
  });

  it('PR-002 rechaza componer sobre una atención que ya no admite contenido clínico', async () => {
    repository.encounter = anEncounter({ status: 'COMPLETED' });

    await expect(
      service.compose(composeRequest, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_ENCOUNTER_NOT_OPEN' });
  });

  it('PR-002 admite componer sobre una atención suspendida, que sigue viva', async () => {
    repository.encounter = anEncounter({ status: 'ON_HOLD' });

    await expect(
      service.compose(composeRequest, requester),
    ).resolves.toBeDefined();
  });

  it('PR-004 rechaza componer a una cuenta sin ficha profesional', async () => {
    repository.prescriber = null;

    await expect(
      service.compose(composeRequest, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIBER_PROFILE_REQUIRED' });
  });

  it('PR-004 toma el prescriptor de la sesión y nunca de la petición', async () => {
    await service.compose(composeRequest, requester);

    expect(repository.created?.prescriberId).toBe(PRACTITIONER);
  });

  it('PR-067 informa de la alergia al componer, sin impedir nada', async () => {
    allergyReader.allergies = [anAllergy(AMOXICILLIN)];

    const composed = await service.compose(composeRequest, requester);

    expect(composed.prescription.status).toBe('DRAFT');
    expect(composed.allergyAlerts).toEqual([
      { line: 1, allergyId: 'allergy-1', match: 'EXACT' },
    ]);
  });

  it('PR-060 interrumpe la EMISIÓN de esa misma receta', async () => {
    // Las dos mitades de PR-067: informar y interrumpir son dos cosas, y sólo
    // la segunda ocurre cuando el documento va a existir.
    repository.snapshot = aSnapshot({
      allergies: [
        {
          id: 'allergy-1',
          substanceConceptId: AMOXICILLIN,
          substanceText: 'Amoxicilina',
        },
      ],
    });

    await expect(service.issue(PRESCRIPTION, requester)).rejects.toMatchObject({
      code: 'ALLERGY_CONTRAINDICATION',
    });
  });

  it('PR-063 no interrumpe con una alergia refutada, que el puerto ya no devuelve', async () => {
    repository.snapshot = aSnapshot({ allergies: [] });

    await expect(service.issue(PRESCRIPTION, requester)).resolves.toMatchObject(
      {
        status: 'ACTIVE',
      },
    );
  });

  it('PR-005 rechaza emitir lo que ya no es un borrador, diciendo en qué estado está', async () => {
    repository.snapshot = aSnapshot({ status: 'ACTIVE' });

    await expect(service.issue(PRESCRIPTION, requester)).rejects.toMatchObject({
      code: 'PRESCRIPTION_NOT_EDITABLE',
      params: { status: 'ACTIVE' },
    });
  });

  it('PR-034 rechaza emitir sin registro ACESS, que es lo que va impreso', async () => {
    // MÁS ESTRICTO que EN-029 a propósito: allí no tener registro anotado no
    // impide firmar, y aquí el art. 5.d.ii imprime el número en el documento.
    repository.snapshot = aSnapshot({
      prescriber: { acessRegistration: null, acessExpiresOn: null },
    });

    await expect(service.issue(PRESCRIPTION, requester)).rejects.toMatchObject({
      code: 'PRESCRIBER_NOT_LICENSED',
    });
  });

  it('PR-034 rechaza emitir con el registro ACESS vencido ayer', async () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    repository.snapshot = aSnapshot({
      prescriber: {
        acessRegistration: 'ACESS-11223',
        acessExpiresOn: yesterday,
      },
    });

    await expect(service.issue(PRESCRIPTION, requester)).rejects.toMatchObject({
      code: 'PRESCRIBER_NOT_LICENSED',
    });
  });

  it('PR-021 rechaza emitir cuando la sede no tiene ciudad que imprimir', async () => {
    repository.snapshot = aSnapshot({ cityOfPrescription: null });

    await expect(service.issue(PRESCRIPTION, requester)).rejects.toMatchObject({
      code: 'PRESCRIPTION_ESTABLISHMENT_INCOMPLETE',
    });
  });

  it('PR-032 rechaza emitir con una línea incompleta, antes de mirar la alergia', async () => {
    /**
     * EL ORDEN ES EL REQUISITO. A un médico con el formulario a medias hay que
     * decirle qué casilla falta, no advertirle de una alergia en una línea que
     * todavía no ha terminado de escribir.
     */
    repository.snapshot = aSnapshot({
      items: [{ ...aSnapshot().items[0]!, concentration: null }],
      allergies: [
        {
          id: 'allergy-1',
          substanceConceptId: AMOXICILLIN,
          substanceText: 'Amoxicilina',
        },
      ],
    });

    await expect(service.issue(PRESCRIPTION, requester)).rejects.toMatchObject({
      code: 'PRESCRIPTION_ITEM_INCOMPLETE',
    });
  });

  it('PR-020 emite con un código de verificación, y nunca con uno secuencial', async () => {
    const issued = await service.issue(PRESCRIPTION, requester);

    expect(issued.status).toBe('ACTIVE');
    expect(issued.issuedAt).not.toBeNull();
    // Aleatorio y de 16 caracteres: un código secuencial impreso en un papel
    // que sale del edificio deja enumerar los demás a quien tenga uno.
    expect(issued.verificationCode).toMatch(/^[0-9A-F]{16}$/);
  });

  it('PR-010 anula una receta EMITIDA sin borrar nada', async () => {
    repository.snapshot = aSnapshot({ status: 'ACTIVE' });

    const cancelled = await service.cancel(PRESCRIPTION, requester);

    expect(cancelled.status).toBe('CANCELLED');
  });

  it('PR-010 rechaza anular un borrador, porque no hay acto legal que anular', async () => {
    /**
     * Y no es una elección de diseño: `prescription_issued_coherence` obliga a
     * que todo estado distinto de `DRAFT` y `DISCARDED` lleve instante de
     * emisión, y una receta que nunca se emitió no tiene ninguno que dar. El
     * art. 70 describe el mismo acto —la receta EMITIDA que se pierde o se
     * altera—, así que la base y la norma coinciden. La salida de un borrador
     * equivocado es DESCARTARLO (PR-011), que es otro acto.
     */
    await expect(service.cancel(PRESCRIPTION, requester)).rejects.toMatchObject(
      {
        code: 'PRESCRIPTION_NOT_EDITABLE',
        params: { status: 'DRAFT' },
      },
    );
  });

  it('PR-011 descarta un borrador guardando quién, cuándo y por qué', async () => {
    // Los tres juntos porque la base los exige juntos
    // (`prescription_discard_states_who_when_and_why`): sin motivo, descartar
    // es hacer desaparecer lo que se escribió.
    const discarded = await service.discard(
      PRESCRIPTION,
      'Se tecleó en la atención equivocada',
      requester,
    );

    expect(discarded.status).toBe('DISCARDED');
    expect(discarded.discardReason).toBe('Se tecleó en la atención equivocada');
    expect(repository.discarded).toMatchObject({
      // Nunca la cédula y nunca el profesional: `discarded_by_id` apunta a
      // `app_user`, que es la cuenta que hizo el acto (REQ-110).
      discardedById: requester.userId,
      discardReason: 'Se tecleó en la atención equivocada',
    });
    expect(repository.discarded?.discardedAt).toBeInstanceOf(Date);
  });

  it('PR-011 rechaza descartar una receta ya emitida, que se anula', async () => {
    // Anular pesa —hay papel en la mano de alguien y una farmacia puede haber
    // dispensado— y descartar es limpieza. Compartir un estado dejaría «esta
    // receta se anuló» sin poder decir cuál de las dos cosas pasó.
    repository.snapshot = aSnapshot({ status: 'ACTIVE' });

    await expect(
      service.discard(PRESCRIPTION, 'Me equivoqué', requester),
    ).rejects.toMatchObject({
      code: 'PRESCRIPTION_NOT_EDITABLE',
      params: { status: 'ACTIVE' },
    });
    expect(repository.discarded).toBeUndefined();
  });

  it('PR-093 deja una fila de bitácora al componer, al emitir, al descartar y al anular', async () => {
    await service.compose(composeRequest, requester);
    await service.issue(PRESCRIPTION, requester);
    await service.discard(PRESCRIPTION, 'Borrador equivocado', requester);
    repository.snapshot = aSnapshot({ status: 'ACTIVE' });
    await service.cancel(PRESCRIPTION, requester);

    expect(entries.map((entry) => entry.action)).toEqual([
      'CREATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
    ]);
    expect(
      entries.every((entry) => entry.resourceType === 'prescription'),
    ).toBe(true);
  });

  it('PR-092 NO deja fila de bitácora al listar las recetas de una atención', async () => {
    await service.listOfEncounter(ENCOUNTER, requester);

    expect(repository.listed).toBe(1);
    expect(entries).toEqual([]);
  });

  it('PR-092 deja UNA fila de bitácora al leer el documento', async () => {
    repository.document = {
      prescription: aPrescription({ status: 'ACTIVE', issuedAt: new Date() }),
      chartId: 'patient-1',
      site: { id: SITE, name: 'Sede', mspUnicode: 'U1', city: 'Quito' },
      patient: {
        familyName: 'Guamán',
        givenName: 'María',
        ageYears: 34,
        ageMonths: 2,
        ageDays: 1,
      },
      diagnoses: [],
      prescriber: {
        givenName: 'Ana',
        familyName: 'Villacís',
        acessRegistration: 'ACESS-11223',
      },
    };

    await service.document(PRESCRIPTION, requester);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('READ');
  });

  it('PR-006 responde 404 de dominio cuando el documento es de otra sede', async () => {
    repository.document = null;

    await expect(
      service.document(PRESCRIPTION, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
    // Y no deja rastro: un 404 no es una divulgación.
    expect(entries).toEqual([]);
  });

  it('PR-001 rechaza listar las recetas de una atención fuera del alcance', async () => {
    repository.encounter = null;

    await expect(
      service.listOfEncounter(ENCOUNTER, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_ENCOUNTER_NOT_FOUND' });
  });
});
