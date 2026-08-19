import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { INDIGENOUS_ETHNICITY_CODE } from '../domain/indigenous-nationality';
import type { PatientCorrectionRequest } from '../domain/patient-corrections';
import type {
  CatalogReference,
  NewPatient,
  PatientCorrectionState,
  PatientDetail,
  PatientIdentifier,
  PatientRepository,
} from '../domain/patient.repository';
import { PatientsService, type Requester } from './patients.service';

/**
 * The application layer of the register, against doubles of its port.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT TESTED HERE, AND IT IS THE HALF THAT MATTERS MOST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing about the two `CHECK`s this delivery adds — a death before a birth
 * and a chart that is its own mother — nor about the partial unique index, nor
 * about the correction and its history rows landing in ONE transaction. A
 * double that returns whatever it was programmed with cannot prove a
 * constraint exists. Those live in `test/integration/`, against a real
 * PostgreSQL.
 *
 * What IS here is what the service decides on its own: which catalogue each
 * reference must come from, that a merged chart is not corrected, that the
 * audit entry of a mutation carries NO payload, and that adding a document
 * never creates a chart.
 */

const PATIENT = '00000000-0000-4000-8000-000000000001';
const MOTHER = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const ETHNICITY = '00000000-0000-4000-8000-000000000004';
const PARISH = '00000000-0000-4000-8000-000000000005';
const NATIONALITY = '00000000-0000-4000-8000-000000000006';
const GENDER_IDENTITY = '00000000-0000-4000-8000-000000000007';
const COUNTRY = '00000000-0000-4000-8000-000000000008';

const REQUESTER: Requester = { userId: USER };

/** 16 August 2026, 10:00 in Guayaquil. */
const NOW = new Date('2026-08-16T15:00:00Z');

/**
 * Check digit CALCULATED, never copied from a real person.
 * 171003406 → modulus 10 gives 5.
 */
const CEDULA: PatientIdentifier = {
  type: 'CEDULA',
  issuingCountry: 'ECU',
  value: '1710034065',
};

function aConcept(overrides: Partial<CatalogReference> = {}): CatalogReference {
  return {
    id: ETHNICITY,
    systemCode: 'ETHNICITY',
    code: '3',
    display: 'Mestiza/o',
    validFrom: parseClinicalDate('2020-01-01'),
    validTo: null,
    ...overrides,
  };
}

/**
 * «Indígena», `1` de la pregunta 11 del INEC: la ÚNICA autoidentificación con
 * la que el RDACAA activa el campo de nacionalidad o pueblo indígena (PA-027).
 *
 * Por su `code` y no por su texto: la redacción de una categoría se reescribe
 * entre censos, y comparar cadenas es una regla que deja de cumplirse sin que
 * nada falle.
 */
function anIndigenousEthnicity(
  overrides: Partial<CatalogReference> = {},
): CatalogReference {
  return aConcept({
    code: INDIGENOUS_ETHNICITY_CODE,
    display: 'Indígena',
    ...overrides,
  });
}

/** Kichwa. Cualquiera de las 34 valdría: la regla no mira cuál. */
function aNationality(): CatalogReference {
  return aConcept({
    id: NATIONALITY,
    systemCode: 'NATIONALITY',
    code: '14',
    display: 'Kichwa',
  });
}

/**
 * Un país del catálogo `COUNTRY`, que se busca POR CÓDIGO y no por id.
 *
 * Es la diferencia con los cuatro conceptos de arriba y la razón de que el
 * puerto tenga un segundo método: la ficha guarda `VEN`, no el `uuid` de la
 * fila, por lo mismo que `patient_identifier.issuing_country`.
 */
function aCountry(overrides: Partial<CatalogReference> = {}): CatalogReference {
  return aConcept({
    id: COUNTRY,
    systemCode: 'COUNTRY',
    code: 'VEN',
    display: 'Venezuela (República Bolivariana de)',
    ...overrides,
  });
}

function aDetail(overrides: Partial<PatientDetail> = {}): PatientDetail {
  return {
    id: PATIENT,
    priority: 2,
    mrn: 'HC0000000801',
    familyName: 'Guamán',
    secondFamilyName: null,
    givenName: 'María',
    secondGivenName: null,
    sex: 'FEMALE',
    birthDate: new Date('1990-04-12T00:00:00Z'),
    birthDateEstimated: false,
    deceasedAt: null,
    age: { years: 36, months: null, days: null },
    rdacaaMissingFields: [],
    primaryIdentifier: null,
    phone: null,
    email: null,
    bloodType: null,
    residenceAddressLine: null,
    ethnicity: null,
    nationality: null,
    genderIdentity: null,
    countryOfNationality: null,
    residenceParish: null,
    motherPatientId: null,
    isProvisional: true,
    identifiers: [],
    mergedIntoMrn: null,
    /** PA-054. Una ficha que no absorbió a ninguna: vacía, nunca `null`. */
    absorbedCharts: { total: 0, mrns: [] },
    createdAt: new Date('2026-08-16T15:00:00Z'),
    ...overrides,
  };
}

const CURRENT_VALUES: PatientCorrectionState['values'] = {
  familyName: 'Guaman',
  secondFamilyName: null,
  givenName: 'María',
  secondGivenName: null,
  sex: 'FEMALE',
  birthDate: '1990-04-12',
  birthDateEstimated: 'false',
  deceasedAt: null,
  phone: null,
  email: null,
  residenceAddressLine: null,
  bloodType: null,
  ethnicityConceptId: null,
  nationalityConceptId: null,
  residenceParishConceptId: null,
  genderIdentityConceptId: null,
  countryOfNationalityCode: null,
  motherPatientId: null,
};

interface Doubles {
  concepts?: Record<string, CatalogReference>;
  /** El catálogo `COUNTRY`, indexado por su código alpha-3 (PA-053). */
  countries?: Record<string, CatalogReference>;
  detail?: PatientDetail | null;
  correctionState?: PatientCorrectionState | null;
  existing?: readonly string[];
  /** Charts that exist but were absorbed by a merge: findable, not live. */
  merged?: readonly string[];
  /** What the adapter's locked transaction concluded: did anything change? */
  changed?: boolean;
  identifierHolder?: { id: string } | null;
}

interface Recorded {
  audit: AccessAuditEntry[];
  corrections: {
    patientId: string;
    changedById: string;
    requested: PatientCorrectionRequest;
  }[];
  identifiers: { patientId: string; identifier: PatientIdentifier }[];
  created: NewPatient[];
}

function serviceWith(doubles: Doubles = {}): {
  service: PatientsService;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    audit: [],
    corrections: [],
    identifiers: [],
    created: [],
  };
  const detail = doubles.detail === undefined ? aDetail() : doubles.detail;

  const repository = {
    search: () => Promise.resolve({ items: [], total: 0 }),
    findById: () => Promise.resolve(detail),
    existsUnmerged: (id: string) =>
      Promise.resolve(
        (doubles.existing ?? [PATIENT, MOTHER]).includes(id) &&
          !(doubles.merged ?? []).includes(id),
      ),
    findByIdentifier: () =>
      Promise.resolve(
        doubles.identifierHolder === undefined
          ? null
          : (doubles.identifierHolder as never),
      ),
    findConceptReference: (id: string) =>
      Promise.resolve(doubles.concepts?.[id] ?? null),
    findConceptReferenceByCode: (systemCode: string, code: string) =>
      Promise.resolve(
        systemCode === 'COUNTRY' ? (doubles.countries?.[code] ?? null) : null,
      ),
    findCorrectionState: () =>
      Promise.resolve(
        doubles.correctionState === undefined
          ? { mergedIntoMrn: null, values: CURRENT_VALUES }
          : doubles.correctionState,
      ),
    correct: (input: {
      patientId: string;
      changedById: string;
      requested: PatientCorrectionRequest;
    }) => {
      recorded.corrections.push(input);
      return Promise.resolve(
        detail === null
          ? null
          : { patient: detail, changed: doubles.changed ?? true },
      );
    },
    addIdentifier: (input: {
      patientId: string;
      identifier: PatientIdentifier;
    }) => {
      recorded.identifiers.push(input);
      return Promise.resolve(detail);
    },
    create: (patient: NewPatient) => {
      recorded.created.push(patient);
      return Promise.resolve(aDetail());
    },
    listPriorityGroups: () => Promise.resolve([]),
    addPriorityGroup: () => Promise.reject(new Error('not used here')),
    closePriorityGroup: () => Promise.resolve(null),
  } as unknown as PatientRepository;

  const audit: AccessAuditRecorder = {
    record: (entry) => {
      recorded.audit.push(entry);
      return Promise.resolve();
    },
  };

  const logger = {
    setContext: () => undefined,
    info: () => undefined,
  } as unknown as PinoLogger;

  return {
    service: new PatientsService(repository, audit, logger),
    recorded,
  };
}

const aNewPatient = (overrides: Partial<NewPatient> = {}): NewPatient => ({
  familyName: 'Guamán',
  givenName: 'María',
  sex: 'FEMALE',
  birthDate: new Date('1990-04-12T00:00:00Z'),
  birthDateEstimated: false,
  ...overrides,
});

describe('choosing the RDACAA references from a catalogue', () => {
  it('PA-026 stores the ethnicity concept chosen from the catalogue', async () => {
    // Self-declared by the patient and chosen from a list, never typed as free
    // text: INEC revises the categories and a chart from three years ago has to
    // keep the wording it was recorded with.
    const { service, recorded } = serviceWith({
      concepts: { [ETHNICITY]: aConcept() },
    });

    await service.create(
      aNewPatient({ ethnicityConceptId: ETHNICITY }),
      REQUESTER,
      NOW,
    );

    expect(recorded.created[0]?.ethnicityConceptId).toBe(ETHNICITY);
  });

  it('PA-027 stores the nationality concept chosen from the catalogue', async () => {
    // WITH THE INDIGENOUS ETHNICITY, because that is the only chart on which
    // this field exists: the RDACAA's form enables it only then (PA-027).
    const { service, recorded } = serviceWith({
      concepts: {
        [ETHNICITY]: anIndigenousEthnicity(),
        [NATIONALITY]: aNationality(),
      },
    });

    await service.create(
      aNewPatient({
        ethnicityConceptId: ETHNICITY,
        nationalityConceptId: NATIONALITY,
      }),
      REQUESTER,
      NOW,
    );

    expect(recorded.created[0]?.nationalityConceptId).toBe(NATIONALITY);
  });

  it('PA-027 refuses a nationality on a chart that identifies as another ethnicity', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EN EL SERVICIO Y NO SÓLO EN EL DTO, y no puede estar en la base.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `Mestizo/a` + Kichwa es un dato contradictorio que el ministerio no
     * espera y que nada detecta después: vuelve con el reporte mensual. El DTO
     * no puede decidirlo —no sabe qué fila del catálogo es «Indígena»— y un
     * `CHECK` tampoco, porque eso está en otra tabla.
     */
    const { service, recorded } = serviceWith({
      concepts: {
        [ETHNICITY]: aConcept({ code: '6', display: 'Mestizo/a' }),
        [NATIONALITY]: aNationality(),
      },
    });

    await expect(
      service.create(
        aNewPatient({
          ethnicityConceptId: ETHNICITY,
          nationalityConceptId: NATIONALITY,
        }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
      fieldErrors: [expect.objectContaining({ field: 'nationalityConceptId' })],
    });
    // Y no queda media ficha: se decide antes de escribir nada.
    expect(recorded.created).toEqual([]);
  });

  it('PA-027 refuses a nationality on a chart with no ethnicity at all', async () => {
    // The form enables the field on an affirmative answer, so «nadie lo ha
    // preguntado todavía» is not «Indígena». The chart is registered without
    // either, and says what it is missing (PA-032).
    const { service, recorded } = serviceWith({
      concepts: { [NATIONALITY]: aNationality() },
    });

    await expect(
      service.create(
        aNewPatient({ nationalityConceptId: NATIONALITY }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
    });
    expect(recorded.created).toEqual([]);
  });

  it('PA-028 stores the residence as a DPA parish concept', async () => {
    const { service, recorded } = serviceWith({
      concepts: {
        [PARISH]: aConcept({
          id: PARISH,
          systemCode: 'DPA',
          code: '170150',
          display: 'Quito Distrito Metropolitano',
        }),
      },
    });

    await service.create(
      aNewPatient({ residenceParishConceptId: PARISH }),
      REQUESTER,
      NOW,
    );

    expect(recorded.created[0]?.residenceParishConceptId).toBe(PARISH);
  });

  it('PA-029 stores the gender identity WITHOUT touching the recorded sex', async () => {
    // Two columns, and neither derived from the other. The RDACAA has asked
    // for them separately since the MSP added the sex-gender variable.
    const { service, recorded } = serviceWith({
      concepts: {
        [GENDER_IDENTITY]: aConcept({
          id: GENDER_IDENTITY,
          systemCode: 'GENDER_IDENTITY',
        }),
      },
    });

    await service.create(
      aNewPatient({ sex: 'FEMALE', genderIdentityConceptId: GENDER_IDENTITY }),
      REQUESTER,
      NOW,
    );

    expect(recorded.created[0]).toMatchObject({
      sex: 'FEMALE',
      genderIdentityConceptId: GENDER_IDENTITY,
    });
  });

  it('PA-026 refuses an ethnicity id that does not exist, naming the field', async () => {
    // Four catalogue selectors sit on one form; without the field, the desk
    // has to re-check all four.
    const { service } = serviceWith({ concepts: {} });

    await expect(
      service.create(
        aNewPatient({ ethnicityConceptId: ETHNICITY }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_FOUND',
      fieldErrors: [expect.objectContaining({ field: 'ethnicityConceptId' })],
    });
  });

  it('PA-026 answers the same for a concept that belongs to ANOTHER catalogue', async () => {
    /**
     * A parish id sent as an ethnicity exists. Answering «existe, pero es de
     * otro catálogo» would turn the chart's endpoint into an oracle of the
     * whole catalogue, walkable by trying identifiers — and for the caller the
     * two mean the same thing: that is not a valid value for this field.
     */
    const { service } = serviceWith({
      concepts: {
        [ETHNICITY]: aConcept({ systemCode: 'DPA', code: '170150' }),
      },
    });

    await expect(
      service.create(
        aNewPatient({ ethnicityConceptId: ETHNICITY }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_FOUND' });
  });

  it('PA-028 refuses a parish withdrawn from the DPA before today', async () => {
    // NOT a 404: the code existed. What has to change is the choice, so the
    // answer is a different one — «elija uno de la lista actual».
    const { service } = serviceWith({
      concepts: {
        [PARISH]: aConcept({
          id: PARISH,
          systemCode: 'DPA',
          code: '170150',
          validTo: parseClinicalDate('2026-08-15'),
        }),
      },
    });

    await expect(
      service.create(
        aNewPatient({ residenceParishConceptId: PARISH }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_IN_FORCE',
      fieldErrors: [
        expect.objectContaining({ field: 'residenceParishConceptId' }),
      ],
    });
  });

  it('PA-028 accepts a parish whose validity ends TODAY', async () => {
    // Both ends inclusive. «Hasta el 16» includes the 16th, and a chart
    // registered that morning must not be refused.
    const { service } = serviceWith({
      concepts: {
        [PARISH]: aConcept({
          id: PARISH,
          systemCode: 'DPA',
          validTo: parseClinicalDate('2026-08-16'),
        }),
      },
    });

    await expect(
      service.create(
        aNewPatient({ residenceParishConceptId: PARISH }),
        REQUESTER,
        NOW,
      ),
    ).resolves.toBeDefined();
  });

  it('PA-053 stores the country of nationality as its alpha-3 code', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NO ES `nationalityConceptId`, Y ÉSA ES LA MITAD DE LA ENTREGA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `NATIONALITY` es la nacionalidad o pueblo indígena del RDACAA —Kichwa,
     * Shuar, Awa—. El país de un paciente venezolano es otro dato, y va en su
     * propia columna como CÓDIGO, igual que `issuingCountry` de un documento.
     */
    const { service, recorded } = serviceWith({
      countries: { VEN: aCountry() },
    });

    await service.create(
      aNewPatient({ countryOfNationalityCode: 'VEN' }),
      REQUESTER,
      NOW,
    );

    expect(recorded.created[0]?.countryOfNationalityCode).toBe('VEN');
    expect(recorded.created[0]?.nationalityConceptId).toBeUndefined();
  });

  it('PA-053 refuses an alpha-3 that is not in the COUNTRY catalogue, naming the field', async () => {
    // Tres letras mayúsculas es lo único que el DTO y el CHECK pueden exigir:
    // `XXX` pasa las dos y no es un país. Quien decide si existe es el
    // catálogo, y la respuesta nombra el campo para que el mensaje aterrice en
    // el selector que está mal.
    const { service, recorded } = serviceWith({ countries: {} });

    await expect(
      service.create(
        aNewPatient({ countryOfNationalityCode: 'XXX' }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_FOUND',
      fieldErrors: [
        expect.objectContaining({ field: 'countryOfNationalityCode' }),
      ],
    });
    expect(recorded.created).toEqual([]);
  });

  it('PA-053 refuses a country withdrawn from the catalogue before today', async () => {
    // Un país que se dividió o se renombró. NO es un 404 —existió— y lo que
    // hay que hacer es distinto: elegir uno de la lista actual.
    const { service } = serviceWith({
      countries: {
        SUN: aCountry({
          code: 'SUN',
          validTo: parseClinicalDate('1991-12-26'),
        }),
      },
    });

    await expect(
      service.create(
        aNewPatient({ countryOfNationalityCode: 'SUN' }),
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_IN_FORCE',
      fieldErrors: [
        expect.objectContaining({ field: 'countryOfNationalityCode' }),
      ],
    });
  });

  it('PA-053 validates a corrected country before writing anything', async () => {
    const { service, recorded } = serviceWith({ countries: {} });

    await expect(
      service.correct(
        PATIENT,
        { countryOfNationalityCode: 'XXX' },
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_FOUND' });
    expect(recorded.corrections).toEqual([]);
  });

  it('PA-053 lets the country be CLEARED without resolving it', async () => {
    // `null` es «vaciar», y no hay país que buscar. Resolverlo haría imposible
    // deshacer un país mal elegido el día que el catálogo lo retire.
    const { service, recorded } = serviceWith({ countries: {} });

    await service.correct(
      PATIENT,
      { countryOfNationalityCode: null },
      REQUESTER,
      NOW,
    );

    expect(recorded.corrections[0]?.requested).toEqual({
      countryOfNationalityCode: null,
    });
  });

  it('PA-053 does not ask for the country in order to register a chart', async () => {
    /**
     * D-028: nada de esto bloquea un alta. Y REQ-022 enumera documento, sexo,
     * etnia, nacionalidad, edad y residencia — el país NO está, así que tampoco
     * cuenta para el indicador de ficha incompleta (PA-032).
     */
    const { service, recorded } = serviceWith({ countries: {} });

    await expect(
      service.create(aNewPatient(), REQUESTER, NOW),
    ).resolves.toBeDefined();
    expect(recorded.created[0]?.countryOfNationalityCode).toBeUndefined();
  });

  it('PA-032 registers a chart with none of the four references at all', async () => {
    // D-028: optional at registration. Refusing a chart at three in the
    // morning with a newborn in the room is what REQ-009 forbids.
    const { service, recorded } = serviceWith({ concepts: {} });

    await expect(
      service.create(aNewPatient(), REQUESTER, NOW),
    ).resolves.toBeDefined();
    expect(recorded.created).toHaveLength(1);
  });
});

describe('linking a chart to its mother', () => {
  it('PA-009 records the link when the mother chart exists', async () => {
    const { service, recorded } = serviceWith();

    await service.create(
      aNewPatient({ motherPatientId: MOTHER }),
      REQUESTER,
      NOW,
    );

    expect(recorded.created[0]?.motherPatientId).toBe(MOTHER);
  });

  it('PA-009 refuses a mother chart that does not exist, naming the field', async () => {
    const { service } = serviceWith({ existing: [] });

    await expect(
      service.create(aNewPatient({ motherPatientId: MOTHER }), REQUESTER, NOW),
    ).rejects.toMatchObject({
      code: 'PATIENT_NOT_FOUND',
      fieldErrors: [expect.objectContaining({ field: 'motherPatientId' })],
    });
  });
});

describe('correcting a chart', () => {
  it('PA-031 hands the REQUEST to storage, never a plan computed out here', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * «DESDE QUÉ VALOR» SÓLO LO SABE QUIEN LEYÓ LA FILA BLOQUEADA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This service used to compute the plan from `findCorrectionState`, read
     * outside the transaction. Two desks correcting the same surname then both
     * recorded the value THEY read, and `patient_change_history` ended with two
     * rows claiming the same previous value — a chain nobody can reconstruct,
     * and `patient_change_history_value_changed` cannot see it because the two
     * values differ. The snapshot now belongs to the adapter's locked
     * transaction, so what leaves here is the request itself.
     */
    const { service, recorded } = serviceWith();

    await service.correct(PATIENT, { familyName: 'Guamán' }, REQUESTER, NOW);

    expect(recorded.corrections[0]?.requested).toEqual({
      familyName: 'Guamán',
    });
    expect(recorded.corrections[0]).not.toHaveProperty('changes');
  });

  it('PA-031 names the signed-in user as the author, never a field of the request', async () => {
    const { service, recorded } = serviceWith();

    await service.correct(PATIENT, { familyName: 'Guamán' }, REQUESTER, NOW);

    expect(recorded.corrections[0]?.changedById).toBe(USER);
  });

  it('PA-031 writes an UPDATE audit entry with NO before and NO after', async () => {
    /**
     * D-032. `access_audit_payload_only_for_declared_resources` refuses a
     * `'patient'` row carrying a payload, and recording does not throw — so
     * the entry would simply be LOST, in silence. The chart's contents belong
     * in `patient_change_history`, which is rectifiable; the access trail is
     * append-only and never purged.
     */
    const { service, recorded } = serviceWith();

    await service.correct(PATIENT, { familyName: 'Guamán' }, REQUESTER, NOW);

    const entry = recorded.audit.at(-1);
    expect(entry).toMatchObject({
      action: 'UPDATE',
      resourceType: 'patient',
      resourceId: PATIENT,
      userId: USER,
    });
    expect(entry?.before).toBeUndefined();
    expect(entry?.after).toBeUndefined();
  });

  it('PA-031 writes NO audit entry for a correction that changed nothing', async () => {
    /**
     * A field re-sent with the value it already held leaves no history row —
     * that is the plan's job, and `patient_change_history_value_changed` would
     * refuse it anyway. The audit entry has to be absent for the SAME reason,
     * and it is the half that used to be written regardless: `access_audit` is
     * append-only and never purged, so an `UPDATE` row for a mutation that did
     * not happen is a permanent claim the chart was modified, with nothing
     * anywhere able to say what changed.
     */
    const { service, recorded } = serviceWith({ changed: false });

    await service.correct(PATIENT, { givenName: 'María' }, REQUESTER, NOW);

    expect(recorded.corrections).toHaveLength(1);
    expect(recorded.audit.filter((entry) => entry.action === 'UPDATE')).toEqual(
      [],
    );
  });

  it('PA-031 refuses to correct a chart that was merged into another', async () => {
    // NOT a 404: the chart existed and printed documents still quote its MRN.
    // The caller is told where it went, exactly as the agenda does (AG-027).
    const { service, recorded } = serviceWith({
      correctionState: {
        mergedIntoMrn: 'HC0000000802',
        values: CURRENT_VALUES,
      },
    });

    await expect(
      service.correct(PATIENT, { familyName: 'Guamán' }, REQUESTER, NOW),
    ).rejects.toMatchObject({ code: 'PATIENT_MERGED' });
    expect(recorded.corrections).toEqual([]);
  });

  it('PA-031 answers PATIENT_NOT_FOUND for a chart that does not exist', async () => {
    const { service, recorded } = serviceWith({ correctionState: null });

    await expect(
      service.correct(PATIENT, { familyName: 'Guamán' }, REQUESTER, NOW),
    ).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
    expect(recorded.audit).toEqual([]);
  });

  it('PA-026 validates a corrected reference before writing anything', async () => {
    const { service, recorded } = serviceWith({ concepts: {} });

    await expect(
      service.correct(
        PATIENT,
        { ethnicityConceptId: ETHNICITY },
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_FOUND' });
    expect(recorded.corrections).toEqual([]);
  });

  it('PA-026 lets a reference be CLEARED without resolving it', async () => {
    // `null` means "vaciar", and there is no concept to look up. Resolving it
    // would make undoing a mistyped reference impossible the day the concept
    // is withdrawn from the catalogue.
    const { service, recorded } = serviceWith({
      concepts: {},
      correctionState: {
        mergedIntoMrn: null,
        values: { ...CURRENT_VALUES, ethnicityConceptId: ETHNICITY },
      },
    });

    await service.correct(
      PATIENT,
      { ethnicityConceptId: null },
      REQUESTER,
      NOW,
    );

    expect(recorded.corrections[0]?.requested).toEqual({
      ethnicityConceptId: null,
    });
  });

  it('PA-027 refuses to change the ethnicity of a chart that already declares a nationality', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * CUENTA EL ESTADO RESULTANTE, NO LO QUE VENGA EN EL CUERPO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La petición sólo trae la etnia. La nacionalidad ya estaba guardada, así
     * que la ficha que resultaría diría «Mestizo/a» y Kichwa a la vez — el
     * mismo dato contradictorio que enviar las dos juntas, alcanzado en dos
     * peticiones. Se rechaza señalando `nationalityConceptId`, y la salida es
     * vaciarla en la misma corrección.
     */
    const { service, recorded } = serviceWith({
      concepts: {
        [ETHNICITY]: aConcept({ code: '6', display: 'Mestizo/a' }),
      },
      correctionState: {
        mergedIntoMrn: null,
        values: { ...CURRENT_VALUES, nationalityConceptId: NATIONALITY },
      },
    });

    await expect(
      service.correct(
        PATIENT,
        { ethnicityConceptId: ETHNICITY },
        REQUESTER,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
      fieldErrors: [expect.objectContaining({ field: 'nationalityConceptId' })],
    });
    expect(recorded.corrections).toEqual([]);
  });

  it('PA-027 accepts the same correction when the nationality is cleared with it', async () => {
    // La salida del rechazo de arriba, y es UN SOLO `PATCH`: quien deja de
    // autoidentificarse como indígena deja de tener ese campo.
    const { service, recorded } = serviceWith({
      concepts: {
        [ETHNICITY]: aConcept({ code: '6', display: 'Mestizo/a' }),
      },
      correctionState: {
        mergedIntoMrn: null,
        values: { ...CURRENT_VALUES, nationalityConceptId: NATIONALITY },
      },
    });

    await service.correct(
      PATIENT,
      { ethnicityConceptId: ETHNICITY, nationalityConceptId: null },
      REQUESTER,
      NOW,
    );

    expect(recorded.corrections[0]?.requested).toEqual({
      ethnicityConceptId: ETHNICITY,
      nationalityConceptId: null,
    });
  });

  it('PA-027 keeps a correction of an unrelated field working on an indigenous chart', async () => {
    /**
     * La regla no puede convertir en incorregible una ficha que ya es
     * coherente: la etnia guardada se resuelve para leer su `code`, y NO se le
     * pregunta si sigue vigente. Una categoría que el INEC retire dejaría si no
     * sin poder corregir el teléfono de quien no se ha mudado.
     */
    const { service, recorded } = serviceWith({
      concepts: {
        [ETHNICITY]: anIndigenousEthnicity({
          validTo: parseClinicalDate('2024-12-31'),
        }),
      },
      correctionState: {
        mergedIntoMrn: null,
        values: {
          ...CURRENT_VALUES,
          ethnicityConceptId: ETHNICITY,
          nationalityConceptId: NATIONALITY,
        },
      },
    });

    await service.correct(PATIENT, { phone: '0991234567' }, REQUESTER, NOW);

    expect(recorded.corrections[0]?.requested).toEqual({ phone: '0991234567' });
  });

  it('PA-009 refuses a corrected mother link to a chart that does not exist', async () => {
    const { service, recorded } = serviceWith({ existing: [PATIENT] });

    await expect(
      service.correct(PATIENT, { motherPatientId: MOTHER }, REQUESTER, NOW),
    ).rejects.toMatchObject({
      code: 'PATIENT_NOT_FOUND',
      fieldErrors: [expect.objectContaining({ field: 'motherPatientId' })],
    });
    expect(recorded.corrections).toEqual([]);
  });

  it('PA-009 refuses a mother chart that was absorbed by a merge', async () => {
    /**
     * A merged chart is NOT deleted — printed documents still quote its MRN —
     * so «existe» is true about it. The link would be recorded and look
     * checked, while the newborn disappears from
     * `GET /patients?motherId=<superviviente>`: the only way of finding them
     * before they have a document of their own.
     */
    const { service, recorded } = serviceWith({ merged: [MOTHER] });

    await expect(
      service.correct(PATIENT, { motherPatientId: MOTHER }, REQUESTER, NOW),
    ).rejects.toMatchObject({
      code: 'PATIENT_NOT_FOUND',
      fieldErrors: [expect.objectContaining({ field: 'motherPatientId' })],
    });
    expect(recorded.corrections).toEqual([]);
  });

  it('PA-009 refuses to REGISTER a newborn under a chart merged away', async () => {
    const { service, recorded } = serviceWith({ merged: [MOTHER] });

    await expect(
      service.create(aNewPatient({ motherPatientId: MOTHER }), REQUESTER, NOW),
    ).rejects.toMatchObject({
      code: 'PATIENT_NOT_FOUND',
      fieldErrors: [expect.objectContaining({ field: 'motherPatientId' })],
    });
    expect(recorded.created).toEqual([]);
  });
});

describe('adding a document to a provisional chart', () => {
  it('PA-015 adds the document to the existing chart and creates no other', async () => {
    const { service, recorded } = serviceWith();

    await service.addIdentifier(PATIENT, CEDULA, REQUESTER);

    expect(recorded.identifiers).toEqual([
      { patientId: PATIENT, identifier: CEDULA },
    ]);
    expect(recorded.created).toEqual([]);
  });

  it('PA-015 leaves an UPDATE audit entry with no payload', async () => {
    const { service, recorded } = serviceWith();

    await service.addIdentifier(PATIENT, CEDULA, REQUESTER);

    const entry = recorded.audit.at(-1);
    expect(entry).toMatchObject({ action: 'UPDATE', resourceType: 'patient' });
    expect(entry?.before).toBeUndefined();
    expect(entry?.after).toBeUndefined();
  });

  it('PA-015 refuses a document another active chart already holds', async () => {
    // The partial unique index is the guarantee (PA-014); this only buys a
    // message the desk can act on instead of a constraint violation.
    const { service, recorded } = serviceWith({
      identifierHolder: { id: MOTHER },
    });

    await expect(
      service.addIdentifier(PATIENT, CEDULA, REQUESTER),
    ).rejects.toMatchObject({ code: 'PATIENT_IDENTIFIER_TAKEN' });
    expect(recorded.identifiers).toEqual([]);
  });

  it('PA-015 accepts a document THIS chart already holds without refusing it', async () => {
    // Re-sending is not a duplicate: the holder is the same chart, and
    // answering «ya existe un paciente con ese documento» about the patient in
    // front of you is the least actionable message possible.
    const { service } = serviceWith({ identifierHolder: { id: PATIENT } });

    await expect(
      service.addIdentifier(PATIENT, CEDULA, REQUESTER),
    ).resolves.toBeDefined();
  });

  it('PA-015 refuses to add a document to a chart that was merged away', async () => {
    const { service, recorded } = serviceWith({
      detail: aDetail({ mergedIntoMrn: 'HC0000000802' }),
    });

    await expect(
      service.addIdentifier(PATIENT, CEDULA, REQUESTER),
    ).rejects.toMatchObject({ code: 'PATIENT_MERGED' });
    expect(recorded.identifiers).toEqual([]);
  });

  it('PA-015 answers PATIENT_NOT_FOUND for a chart that does not exist', async () => {
    const { service, recorded } = serviceWith({ detail: null });

    await expect(
      service.addIdentifier(PATIENT, CEDULA, REQUESTER),
    ).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
    expect(recorded.audit).toEqual([]);
  });
});

describe('abrir una ficha', () => {
  it('PA-045 refuses to open a chart that was absorbed, naming the surviving MRN', async () => {
    /**
     * ES ESTA OPERACIÓN LA QUE DUELE, y por eso PA-045 dice «toda operación que
     * la nombre» y no «toda mutación». `PatientMergedError` existe literalmente
     * para que quien está en el mostrador deje de «abrir la ficha vieja y
     * preguntarse por qué se cortan las notas»: devolverla con un
     * `mergedIntoMrn` en algún campo del cuerpo es un puntero que cada pantalla
     * tiene que acordarse de leer, y un 409 que nombra el número vigente no.
     *
     * NO es un 404: la historia existió y documentos ya impresos siguen citando
     * su número.
     */
    const { service, recorded } = serviceWith({
      detail: aDetail({ mergedIntoMrn: 'HC0000000802' }),
    });

    await expect(service.getById(PATIENT, REQUESTER)).rejects.toMatchObject({
      code: 'PATIENT_MERGED',
      fieldErrors: [
        {
          field: 'patientId',
          code: 'PATIENT_MERGED',
          message: 'La historia vigente es HC0000000802',
        },
      ],
    });

    // Y NO DEJA FILA DE BITÁCORA: no se enseñó nada de la ficha, así que no hay
    // acceso del que responder. Mismo criterio que el 404 de PA-024.
    expect(recorded.audit).toEqual([]);
  });

  it('PA-022 opens a live chart and leaves exactly one audit row', async () => {
    // La otra mitad, que es lo que impide «arreglar» lo de arriba rechazando
    // todas las fichas.
    const { service, recorded } = serviceWith();

    await expect(service.getById(PATIENT, REQUESTER)).resolves.toMatchObject({
      id: PATIENT,
    });
    expect(recorded.audit).toEqual([
      expect.objectContaining({ action: 'READ', resourceType: 'patient' }),
    ]);
  });
});
