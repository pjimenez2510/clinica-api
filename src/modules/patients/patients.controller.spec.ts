import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import type { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { PatientsService } from './application/patients.service';
import type { PatientDetail } from './domain/patient.repository';
import {
  patientDetailSchema,
  patientPageSchema,
  patientSummarySchema,
} from './dto/patient.dto';
import { PatientsController } from './patients.controller';

/**
 * The HTTP contract of the register: what actually leaves the process.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RESPONSES ARE PARSED AGAINST THE PUBLISHED SCHEMAS, NOT EYEBALLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patientDetailSchema` and `patientPageSchema` are what NestJS turns into the
 * OpenAPI document, and `clinica-web` generates its types from that document.
 * A field the mapping forgets is therefore not a missing field on a screen: it
 * is a field the other side is told exists, typed, and receives as
 * `undefined`. Parsing here is what makes the schema and the mapping unable to
 * drift.
 *
 * Nothing about the database, the guard or the audit trail is exercised: those
 * are `test/integration/`, with a real PostgreSQL and a real session.
 */

const PATIENT = '00000000-0000-4000-8000-000000000001';
const MOTHER = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const PARISH = '00000000-0000-4000-8000-000000000004';

function aDetail(overrides: Partial<PatientDetail> = {}): PatientDetail {
  return {
    id: PATIENT,
    priority: 2,
    mrn: 'HC0000000801',
    familyName: 'Guamán',
    secondFamilyName: 'Vélez',
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
    ethnicity: { id: PATIENT, code: '3', display: 'Mestiza/o' },
    nationality: null,
    people: null,
    genderIdentity: null,
    countryOfNationality: null,
    residenceParish: {
      id: PARISH,
      code: '170150',
      display: 'Quito Distrito Metropolitano',
      provinceCode: '17',
      provinceDisplay: 'Pichincha',
      cantonCode: '1701',
      cantonDisplay: 'Quito',
    },
    motherPatientId: MOTHER,
    isProvisional: false,
    identifiers: [],
    mergedIntoMrn: null,
    absorbedCharts: { total: 0, mrns: [] },
    createdAt: new Date('2026-08-16T15:00:00Z'),
    ...overrides,
  };
}

const REQUEST = {
  ip: '10.0.0.1',
  get: () => undefined,
} as unknown as Request;

function controllerWith(detail: PatientDetail): {
  controller: PatientsController;
  seen: { search: unknown[]; correct: unknown[]; identifiers: unknown[] };
} {
  const seen = {
    search: [] as unknown[],
    correct: [] as unknown[],
    identifiers: [] as unknown[],
  };

  const patients = {
    search: (criteria: unknown) => {
      seen.search.push(criteria);
      return Promise.resolve({ items: [detail], total: 1 });
    },
    getById: () => Promise.resolve(detail),
    create: () => Promise.resolve(detail),
    correct: (id: string, body: unknown) => {
      seen.correct.push({ id, body });
      return Promise.resolve(detail);
    },
    addIdentifier: (id: string, identifier: unknown) => {
      seen.identifiers.push({ id, identifier });
      return Promise.resolve(detail);
    },
  } as unknown as PatientsService;

  const currentUser = {
    requireUserId: () => USER,
  } as unknown as CurrentUserService;

  return { controller: new PatientsController(patients, currentUser), seen };
}

describe('the patient record as it leaves the API', () => {
  it('PA-028 returns the parish with province and canton derived from its code', async () => {
    // 170150 → province 17, canton 1701. Neither is a column, and two rows of
    // the INEC file declare a canton their own code contradicts — with a
    // stored canton those patients would be reported in the wrong one.
    const { controller } = controllerWith(aDetail());

    const response = await controller.byId(PATIENT, REQUEST);
    const parsed = patientDetailSchema.parse(response);

    expect(parsed.residenceParish).toEqual({
      id: PARISH,
      code: '170150',
      display: 'Quito Distrito Metropolitano',
      provinceCode: '17',
      provinceDisplay: 'Pichincha',
      cantonCode: '1701',
      cantonDisplay: 'Quito',
    });
  });

  it('PA-026 returns the ethnicity with the wording it was recorded with', async () => {
    const { controller } = controllerWith(aDetail());

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.ethnicity).toEqual({
      id: PATIENT,
      code: '3',
      display: 'Mestiza/o',
    });
  });

  it('PA-029 returns the gender identity as a field of its own, never derived', async () => {
    const { controller } = controllerWith(
      aDetail({
        sex: 'FEMALE',
        genderIdentity: { id: PATIENT, code: 'F', display: 'Femenino' },
      }),
    );

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.sex).toBe('FEMALE');
    expect(parsed.genderIdentity?.display).toBe('Femenino');
  });

  it('PA-053 returns the country of nationality with its NAME, and not only its code', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * «VEN» NO ES INFORMACIÓN (ADR-005 §5).
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Un código que quien lo lee no puede interpretar es ruido con aspecto de
     * dato. Si sólo viajara el código, la pantalla no podría hacer otra cosa
     * que pintarlo tal cual: la interfaz no puede resolverlo sola, así que
     * decir cómo se llama es obligación del backend.
     *
     * Y ES OTRO DATO QUE `nationality`, que es la nacionalidad o pueblo
     * indígena del RDACAA. Aquí viajan los dos a la vez, que es precisamente lo
     * que la columna nueva compra.
     */
    const { controller } = controllerWith(
      aDetail({
        nationality: { id: PATIENT, code: '14', display: 'Kichwa' },
        countryOfNationality: {
          code: 'VEN',
          display: 'Venezuela (República Bolivariana de)',
        },
      }),
    );

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.countryOfNationality).toEqual({
      code: 'VEN',
      display: 'Venezuela (República Bolivariana de)',
    });
    expect(parsed.nationality?.display).toBe('Kichwa');
  });

  it('PA-053 keeps the code when the catalogue cannot name the country', async () => {
    // Una edición anterior del catálogo, un país que se dividió. El nombre
    // viaja nulo y el CÓDIGO SIGUE VIAJANDO: un nombre que falta es una
    // pantalla peor, un código que falta es un registro peor.
    const { controller } = controllerWith(
      aDetail({ countryOfNationality: { code: 'SUN', display: null } }),
    );

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.countryOfNationality).toEqual({
      code: 'SUN',
      display: null,
    });
  });

  it('PA-009 returns the link to the mother on the chart', async () => {
    const { controller } = controllerWith(aDetail());

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.motherPatientId).toBe(MOTHER);
  });

  it('PA-008 returns the date of death as an ISO instant on every response naming the patient', async () => {
    // The contract the listing and the chart already had does not change: what
    // changes is that there is now a route that writes it.
    const deceasedAt = new Date('2026-03-03T05:00:00.000Z');
    const { controller } = controllerWith(aDetail({ deceasedAt }));

    const detail = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );
    const page = patientPageSchema.parse(
      await controller.search({
        page: 1,
        pageSize: 20,
        includeMerged: false,
        sortBy: 'name',
        sortDirection: 'asc',
      } as never),
    );

    expect(detail.deceasedAt).toBe('2026-03-03T05:00:00.000Z');
    expect(page.items[0]?.deceasedAt).toBe('2026-03-03T05:00:00.000Z');
  });

  it('PA-030 returns the derived age, in days for a neonate', async () => {
    const { controller } = controllerWith(
      aDetail({ age: { years: 0, months: null, days: 12 } }),
    );

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.age).toEqual({ years: 0, months: null, days: 12 });
  });

  it('PA-032 names the fields the RDACAA is still missing, on the chart AND on the listing', async () => {
    // Admission works from the list. A chart it cannot see is incomplete is a
    // chart nobody completes until the Dirección Distrital returns the report.
    const { controller } = controllerWith(
      aDetail({
        rdacaaMissingFields: ['identifier', 'ethnicityConceptId'],
      }),
    );

    const detail = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );
    const page = patientPageSchema.parse(
      await controller.search({
        page: 1,
        pageSize: 20,
        includeMerged: false,
        sortBy: 'name',
        sortDirection: 'asc',
      } as never),
    );

    expect(detail.rdacaaMissingFields).toEqual([
      'identifier',
      'ethnicityConceptId',
    ]);
    expect(page.items[0]?.rdacaaMissingFields).toEqual([
      'identifier',
      'ethnicityConceptId',
    ]);
  });

  it('PA-021 keeps the catalogue concepts OUT of the listing row', async () => {
    /**
     * A search fires on every letter typed. The row carries the derived age
     * and what is missing — the two things admission reads from the list — and
     * not four resolved catalogue concepts per patient.
     */
    const { controller } = controllerWith(aDetail());

    const page = patientPageSchema.parse(
      await controller.search({
        page: 1,
        pageSize: 20,
        includeMerged: false,
        sortBy: 'name',
        sortDirection: 'asc',
      } as never),
    );

    const row = page.items[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      Object.keys(patientSummarySchema.shape).sort(),
    );
    expect(row.ethnicity).toBeUndefined();
    expect(row.residenceParish).toBeUndefined();
    // PA-053: el país tampoco, y por el mismo motivo — ponerle nombre cuesta
    // una consulta al catálogo por fila.
    expect(row.countryOfNationality).toBeUndefined();
  });

  it('PA-054 names the charts this one absorbed, by their MRN', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA MITAD QUE LE FALTABA A PA-043, Y EL CASO DE LA ALERGIA (D-038).
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La absorbida apunta a la superviviente; desde la superviviente el enlace
     * era invisible. El médico abre la ficha vigente, no ve la alergia a la
     * penicilina que se quedó en la absorbida, y prescribe.
     *
     * EL MRN Y NO UN CONTADOR: un número a secas nombra el problema y no da
     * con qué ir a mirarlo. El MRN es lo que se teclea en la búsqueda del
     * registro, así que es lo que permite LLEGAR a la otra ficha.
     */
    const { controller } = controllerWith(
      aDetail({
        absorbedCharts: { total: 2, mrns: ['HC0000000415', 'HC0000000902'] },
      }),
    );

    const parsed = patientDetailSchema.parse(
      await controller.byId(PATIENT, REQUEST),
    );

    expect(parsed.absorbedCharts).toEqual({
      total: 2,
      mrns: ['HC0000000415', 'HC0000000902'],
    });
  });

  it('PA-054 answers a chart that absorbed nobody with an EMPTY list, never null', async () => {
    /**
     * Ni el campo ausente ni `null`. Que la interfaz tenga que distinguir tres
     * estados —ausente, nulo y vacío— donde el dominio tiene dos es cómo nacen
     * los errores de pantalla: dos de los tres caminos se pintan bien por
     * casualidad y el tercero revienta el día que alguien fusiona.
     */
    const { controller } = controllerWith(aDetail());

    const response = (await controller.byId(PATIENT, REQUEST)) as Record<
      string,
      unknown
    >;
    const parsed = patientDetailSchema.parse(response);

    expect('absorbedCharts' in response).toBe(true);
    expect(parsed.absorbedCharts).not.toBeNull();
    expect(parsed.absorbedCharts).toEqual({ total: 0, mrns: [] });
  });

  it('PA-054 keeps the absorbed charts OUT of the listing row', async () => {
    /**
     * PA-021: la búsqueda se dispara con cada letra tecleada, y una
     * subconsulta por fila para contestar algo que ninguna fila de resultados
     * necesita es latencia en el camino más caliente del módulo.
     *
     * SE AFIRMA SOBRE LA RESPUESTA y no sobre el esquema: el resumen se
     * construye a mano en `toSummaryResponse`, así que lo que hay que
     * comprobar es lo que sale, no lo que el esquema permitiría.
     */
    const { controller } = controllerWith(
      aDetail({
        absorbedCharts: { total: 2, mrns: ['HC0000000415', 'HC0000000902'] },
      }),
    );

    const page = await controller.search({
      page: 1,
      pageSize: 20,
      includeMerged: false,
      sortBy: 'name',
      sortDirection: 'asc',
    } as never);

    const row = page.items[0] as Record<string, unknown>;
    expect(row.absorbedCharts).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(
      Object.keys(patientSummarySchema.shape).sort(),
    );
  });

  it('PA-009 passes the mother filter through to the register search', async () => {
    const { controller, seen } = controllerWith(aDetail());

    await controller.search({
      page: 1,
      pageSize: 20,
      includeMerged: false,
      motherId: MOTHER,
      sortBy: 'name',
      sortDirection: 'asc',
    } as never);

    expect(seen.search[0]).toMatchObject({ motherId: MOTHER });
  });

  it('PA-031 answers a correction with the chart as a later GET would return it', async () => {
    const { controller, seen } = controllerWith(aDetail());

    const response = await controller.correct(
      PATIENT,
      { familyName: 'Guamán' },
      REQUEST,
    );

    expect(() => patientDetailSchema.parse(response)).not.toThrow();
    expect(seen.correct[0]).toEqual({
      id: PATIENT,
      body: { familyName: 'Guamán' },
    });
  });

  it('PA-015 answers the document route with the whole chart, no longer provisional', async () => {
    const { controller, seen } = controllerWith(
      aDetail({ isProvisional: false }),
    );

    const parsed = patientDetailSchema.parse(
      await controller.addIdentifier(
        PATIENT,
        {
          type: 'CEDULA',
          issuingCountry: 'ECU',
          value: '1710034065',
        } as never,
        REQUEST,
      ),
    );

    expect(parsed.isProvisional).toBe(false);
    expect(seen.identifiers[0]).toEqual({
      id: PATIENT,
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: '1710034065',
      },
    });
  });
});
